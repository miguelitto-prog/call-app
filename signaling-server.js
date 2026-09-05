// Servidor do Sinal: contas de verdade (usuário/senha num banco SQLite local),
// canais de texto e voz (criar/apagar, com histórico de mensagens), e a
// sinalização WebRTC da chamada em grupo — agora com escopo por canal de voz,
// já que pode ter mais de um.
//
// Guarda tudo em sinal.db, um arquivo SQLite ao lado deste script (usa o
// módulo node:sqlite, que já vem com o Node — não precisa instalar nada
// além do pacote "ws"). É experimental no Node ainda, então é normal
// aparecer um aviso no console ao iniciar.
//
// Rode com: npm run server
//
// Importante: isso guarda senha com hash (scrypt) e nunca em texto puro,
// mas as sessões são só em memória (reiniciar o servidor derruba todo
// mundo, precisando logar de novo) e não tem HTTPS — bom o suficiente pra
// jogar com os amigos na sua rede, não pra expor na internet aberta.
const { WebSocketServer } = require('ws');
const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 8080;
// Se você adicionar um disco persistente no Render (recomendado — sem ele o
// banco reseta a cada deploy), aponte a variável de ambiente DB_PATH pro
// caminho montado, ex: /var/data/sinal.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sinal.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('texto','voz')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Canais padrão, só na primeira vez que o banco é criado.
const { count } = db.prepare('SELECT COUNT(*) AS count FROM channels').get();
if (count === 0) {
  const insertChannel = db.prepare('INSERT INTO channels (name, kind, created_at) VALUES (?, ?, ?)');
  insertChannel.run('geral', 'texto', new Date().toISOString());
  insertChannel.run('sala principal', 'voz', new Date().toISOString());
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  const attempt = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return attempt.length === expected.length && timingSafeEqual(attempt, expected);
}

function listChannels() {
  return db.prepare('SELECT id, name, kind FROM channels ORDER BY kind DESC, id ASC').all();
}

// token de sessão -> { userId, username }. Só em memória, de propósito (ver
// aviso lá em cima) — mais simples que gerenciar expiração/refresh agora.
const sessions = new Map();

const wss = new WebSocketServer({ port: PORT });
const clients = new Map(); // connectionId -> { socket, userId, username, voiceChannelId }

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(message) {
  for (const client of clients.values()) send(client.socket, message);
}

function peersInVoiceChannel(channelId, excludeId) {
  if (channelId == null) return [];
  return [...clients.entries()]
    .filter(([id, c]) => c.voiceChannelId === channelId && id !== excludeId)
    .map(([id]) => id);
}

wss.on('connection', (socket) => {
  let connId = null; // só existe depois de autenticar

  function startSession(userId, username, existingToken) {
    connId = randomUUID();
    const token = existingToken || randomUUID();
    sessions.set(token, { userId, username });
    clients.set(connId, { socket, userId, username, voiceChannelId: null });
    send(socket, { type: 'auth-ok', id: connId, token, username, channels: listChannels() });
    console.log(`${username} entrou. Conectados: ${clients.size}`);
  }

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignora mensagem malformada
    }

    // ---- Conta: tem que autenticar antes de fazer qualquer outra coisa ----
    if (msg.type === 'register') {
      const username = String(msg.username || '').trim();
      const password = String(msg.password || '');
      if (username.length < 3) {
        return send(socket, { type: 'auth-error', message: 'O nome de usuário precisa ter pelo menos 3 letras.' });
      }
      if (password.length < 6) {
        return send(socket, { type: 'auth-error', message: 'A senha precisa ter pelo menos 6 caracteres.' });
      }
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        return send(socket, { type: 'auth-error', message: 'Esse nome de usuário já existe.' });
      }
      const salt = randomBytes(16).toString('hex');
      db.prepare('INSERT INTO users (username, salt, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(username, salt, hashPassword(password, salt), new Date().toISOString());
      // Não loga automaticamente — o cliente mostra a notificação e volta
      // pra aba "Entrar" pra confirmar a senha.
      send(socket, { type: 'register-ok', username });
      return;
    }

    if (msg.type === 'login') {
      const username = String(msg.username || '').trim();
      const password = String(msg.password || '');
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
        return send(socket, { type: 'auth-error', message: 'Usuário ou senha incorretos.' });
      }
      startSession(user.id, user.username);
      return;
    }

    if (msg.type === 'resume') {
      const session = sessions.get(msg.token);
      if (!session) return send(socket, { type: 'auth-error', message: 'Sessão expirada, entre de novo.' });
      startSession(session.userId, session.username, msg.token);
      return;
    }

    if (!connId) return; // ignora tudo que chegar antes do login
    const me = clients.get(connId);

    // ---- Canais ----
    if (msg.type === 'create-channel') {
      const name = String(msg.name || '').trim().slice(0, 60);
      const kind = msg.kind === 'voz' ? 'voz' : 'texto';
      if (!name) return;
      const info = db
        .prepare('INSERT INTO channels (name, kind, created_at) VALUES (?, ?, ?)')
        .run(name, kind, new Date().toISOString());
      broadcast({ type: 'channel-created', channel: { id: info.lastInsertRowid, name, kind } });
      return;
    }

    if (msg.type === 'delete-channel') {
      const channelId = Number(msg.channelId);
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
      db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);

      // Quem estava na chamada desse canal de voz é tirado dela.
      const memberIds = [...clients.entries()]
        .filter(([, c]) => c.voiceChannelId === channelId)
        .map(([id]) => id);
      memberIds.forEach((id) => { clients.get(id).voiceChannelId = null; });
      for (const id of memberIds) {
        for (const otherId of memberIds) {
          if (otherId !== id) send(clients.get(otherId).socket, { type: 'peer-left', id });
        }
      }
      broadcast({ type: 'channel-deleted', channelId });
      return;
    }

    // ---- Chat de texto ----
    if (msg.type === 'get-messages') {
      const channelId = Number(msg.channelId);
      const messages = db
        .prepare('SELECT username, content, created_at AS createdAt FROM messages WHERE channel_id = ? ORDER BY id ASC LIMIT 200')
        .all(channelId);
      send(socket, { type: 'messages-history', channelId, messages });
      return;
    }

    if (msg.type === 'send-message') {
      const channelId = Number(msg.channelId);
      const content = String(msg.content || '').trim().slice(0, 2000);
      if (!content) return;
      const createdAt = new Date().toISOString();
      db.prepare('INSERT INTO messages (channel_id, username, content, created_at) VALUES (?, ?, ?, ?)')
        .run(channelId, me.username, content, createdAt);
      broadcast({ type: 'message', channelId, message: { username: me.username, content, createdAt } });
      return;
    }

    // ---- Entrar/sair de um canal de voz (isso que dá o escopo da mesh) ----
    if (msg.type === 'join-voice') {
      const channelId = Number(msg.channelId);
      me.voiceChannelId = channelId;
      const peerIds = peersInVoiceChannel(channelId, connId);
      const peers = peerIds.map((id) => ({ id, username: clients.get(id).username }));
      send(socket, { type: 'voice-welcome', channelId, peers });
      for (const peerId of peerIds) {
        send(clients.get(peerId).socket, { type: 'peer-joined', id: connId, channelId, username: me.username });
      }
      return;
    }

    if (msg.type === 'leave-voice') {
      const channelId = me.voiceChannelId;
      me.voiceChannelId = null;
      for (const peerId of peersInVoiceChannel(channelId, connId)) {
        send(clients.get(peerId).socket, { type: 'peer-left', id: connId });
      }
      return;
    }

    // ---- Estado (mudo / compartilhando tela / câmera) — só pro canal de voz atual ----
    if (msg.type === 'state') {
      for (const peerId of peersInVoiceChannel(me.voiceChannelId, connId)) {
        send(clients.get(peerId).socket, { ...msg, from: connId });
      }
      return;
    }

    // ---- Sinalização direta (oferta/resposta SDP, candidatos ICE) ----
    const targetClient = clients.get(msg.target);
    if (targetClient) send(targetClient.socket, { ...msg, from: connId });
  });

  socket.on('close', () => {
    if (!connId) return;
    const me = clients.get(connId);
    if (me && me.voiceChannelId != null) {
      for (const peerId of peersInVoiceChannel(me.voiceChannelId, connId)) {
        send(clients.get(peerId).socket, { type: 'peer-left', id: connId });
      }
    }
    clients.delete(connId);
    console.log(`Alguém saiu. Conectados: ${clients.size}`);
  });
});

console.log(`Servidor do Sinal rodando em ws://localhost:${PORT}`);
console.log(`Banco de dados: ${DB_PATH}`);

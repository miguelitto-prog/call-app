// Servidor de sinalização com suporte a mais de 2 participantes: cada cliente
// recebe um id, e as mensagens de sinalização (oferta/resposta/ICE) são
// direcionadas a um participante específico (msg.target), não mais um
// broadcast simples pros outros dois. Áudio/vídeo continuam indo direto entre
// os PCs via WebRTC — esse servidor só ajuda todo mundo a se encontrar.
//
// Mensagens do tipo 'state' (mudo / compartilhando tela / câmera ligada) são
// a exceção: elas vão pra todo mundo na sala, não só pro "target", porque
// servem pra manter a lista de participantes e o aviso de tela compartilhada
// sincronizados pra todo mundo.
//
// Rode com: npm run server
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // id -> socket

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

wss.on('connection', (socket) => {
  const id = randomUUID();
  clients.set(id, socket);
  console.log(`Novo participante: ${id}. Total: ${clients.size}`);

  // Avisa o recém-chegado quem já está na sala, pra ele criar a conexão com
  // cada um.
  send(socket, {
    type: 'welcome',
    id,
    peers: [...clients.keys()].filter((otherId) => otherId !== id),
  });

  // Avisa todo mundo que já está na sala que uma pessoa nova entrou.
  for (const [otherId, otherSocket] of clients) {
    if (otherId !== id) send(otherSocket, { type: 'peer-joined', id });
  }

  socket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return; // ignora mensagem malformada
    }

    if (message.type === 'state') {
      for (const [otherId, otherSocket] of clients) {
        if (otherId !== id) send(otherSocket, { ...message, from: id });
      }
      return;
    }

    // Mensagens de sinalização (oferta/resposta SDP, candidatos ICE) são
    // sempre endereçadas a um participante específico via "target".
    const targetSocket = clients.get(message.target);
    if (targetSocket) send(targetSocket, { ...message, from: id });
  });

  socket.on('close', () => {
    clients.delete(id);
    console.log(`Participante saiu: ${id}. Total: ${clients.size}`);
    for (const otherSocket of clients.values()) {
      send(otherSocket, { type: 'peer-left', id });
    }
  });
});

console.log(`Servidor de sinalização (multi-participante) rodando em ws://localhost:${PORT}`);

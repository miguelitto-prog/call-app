// O endereço do servidor vem do config.json.
let SIGNALING_URL = 'ws://localhost:8080';

let ws;
let myId = null; // id de conexão (muda a cada login/reconexão)
let myUsername = null;

let channels = []; // [{ id, name, kind }] — vem do servidor
let selectedChannelId = null; // canal aberto na área principal agora
let activeVoiceChannelId = null; // canal de voz em que estou de fato conectado

let myAudioTrack = null; // microfone, quando na chamada
let cameraTrack = null; // track da câmera, quando ligada
let screenTrack = null; // track da tela, quando compartilhando

let audioCtx = null;
const speakingMeters = new Map(); // id -> intervalId, pra detectar quem tá falando

// Estado (mudo / compartilhando tela / câmera ligada) de cada participante
// da chamada atual, incluindo 'local' pra mim mesmo.
const states = new Map(); // id -> { muted, sharing, camera }

// Chamada em grupo = "mesh": uma RTCPeerConnection direta pra cada outro
// participante do MESMO canal de voz. A chave do Map é o id de conexão que
// o servidor deu a cada participante.
const peers = new Map(); // id -> { pc, audioTransceiver, videoTransceiver, polite, makingOffer, ignoreOffer }

const QUALITY_PRESETS = {
  '480p15': { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 } },
  '720p30': { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
  '1080p30': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
  '1080p60': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } },
  native: {},
};

let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ---- Elementos ----
const authScreen = document.getElementById('auth-screen');
const authForm = document.getElementById('auth-form');
const authTabs = [...document.querySelectorAll('.auth-tab')];
const authUsernameInput = document.getElementById('auth-username');
const authPasswordInput = document.getElementById('auth-password');
const authSubmitBtn = document.getElementById('auth-submit');
const authErrorEl = document.getElementById('auth-error');

const appEl = document.getElementById('app');
const textChannelsEl = document.getElementById('text-channels');
const voiceChannelsEl = document.getElementById('voice-channels');
const inCallBanner = document.getElementById('in-call-banner');
const inCallText = document.getElementById('in-call-text');
const inCallLeaveBtn = document.getElementById('in-call-leave');
const selfAvatarEl = document.getElementById('self-avatar');
const selfUsernameEl = document.getElementById('self-username');
const statusEl = document.getElementById('status');
const logoutBtn = document.getElementById('logout-btn');

const channelTitleText = document.getElementById('channel-title-text');
const participantCountEl = document.getElementById('participant-count');
const sharingPillEl = document.getElementById('sharing-pill');
const sharingTextEl = document.getElementById('sharing-text');

const voiceViewEl = document.getElementById('voice-view');
const videoGrid = document.getElementById('video-grid');
const prejoinEl = document.getElementById('pre-join');
const callBtn = document.getElementById('call-btn');

const textViewEl = document.getElementById('text-view');
const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

const controlsRowEl = document.getElementById('controls-row');
const micBtn = document.getElementById('mic-btn');
const cameraBtn = document.getElementById('camera-btn');
const shareBtn = document.getElementById('share-btn');
const shareQualitySelect = document.getElementById('share-quality');
const leaveBtn = document.getElementById('leave-btn');

// ---- Utilidades ----
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function initials(id) {
  if (id === 'local') return (myUsername || 'VC').slice(0, 2).toUpperCase();
  const st = states.get(id);
  return st && st.username ? st.username.slice(0, 2).toUpperCase() : id.slice(0, 2).toUpperCase();
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- Notificação simples (toast) ----
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => { toastEl.hidden = true; }, 220);
  }, 3200);
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function sendSignal(targetId, payload) {
  send({ target: targetId, ...payload });
}

// ---- Autenticação ----
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  authTabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  authSubmitBtn.textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  authErrorEl.hidden = true;
}

authTabs.forEach((tab) => {
  tab.addEventListener('click', () => setAuthMode(tab.dataset.mode));
});

authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  authErrorEl.hidden = true;
  send({ type: authMode, username: authUsernameInput.value.trim(), password: authPasswordInput.value });
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('sinal_token');
  location.reload();
});

function showAuthError(message) {
  authErrorEl.textContent = message;
  authErrorEl.hidden = false;
}

function onAuthenticated(msg) {
  myId = msg.id;
  myUsername = msg.username;
  channels = msg.channels;
  localStorage.setItem('sinal_token', msg.token);

  authScreen.hidden = true;
  appEl.hidden = false;
  selfUsernameEl.textContent = myUsername;
  selfAvatarEl.textContent = myUsername.slice(0, 2).toUpperCase();
  setStatus('conectado');

  renderChannelList();
  if (!selectedChannelId && channels.length > 0) {
    selectChannel(channels[0].id);
  }
}

// ---- Canais ----
function channelIcon(kind) {
  return kind === 'voz'
    ? '<path d="M11 5L6 9H3v6h3l5 4V5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 9a4 4 0 010 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    : '<path d="M5 4h14v12H8l-3 3V4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
}

function renderChannelList() {
  textChannelsEl.innerHTML = '';
  voiceChannelsEl.innerHTML = '';

  channels.filter((c) => c.kind === 'texto').forEach((c) => textChannelsEl.appendChild(buildChannelRow(c)));

  channels.filter((c) => c.kind === 'voz').forEach((c) => {
    voiceChannelsEl.appendChild(buildChannelRow(c));
    if (c.id === activeVoiceChannelId) voiceChannelsEl.appendChild(buildVoiceMembersList());
  });
}

function buildChannelRow(c) {
  const row = document.createElement('div');
  row.className = 'channel-row' + (c.id === selectedChannelId ? ' active' : '');
  row.innerHTML = `
    <svg class="channel-icon" viewBox="0 0 24 24" fill="none">${channelIcon(c.kind)}</svg>
    <span class="channel-name">${escapeHtml(c.name)}</span>
    <button type="button" class="channel-delete" title="Apagar canal">×</button>
  `;
  row.addEventListener('click', (e) => {
    if (e.target.closest('.channel-delete')) return;
    selectChannel(c.id);
  });
  row.querySelector('.channel-delete').addEventListener('click', () => {
    if (confirm(`Apagar o canal "${c.name}"? As mensagens dele também somem.`)) {
      send({ type: 'delete-channel', channelId: c.id });
    }
  });
  return row;
}

function buildVoiceMembersList() {
  const wrap = document.createElement('div');
  wrap.className = 'voice-members';
  wrap.id = 'voice-members';
  const entries = [{ id: 'local', label: myUsername }, ...[...peers.keys()].map((id) => ({ id, label: (states.get(id) || {}).username || 'Convidado' }))];
  entries.forEach(({ id, label }) => {
    const st = states.get(id) || {};
    const row = document.createElement('div');
    row.className = 'vm' + (st.muted ? ' muted' : '');
    row.id = `vm-${id}`;
    const micPath = st.muted
      ? '<path d="M3 3l18 18M12 15a3 3 0 003-3V6a3 3 0 00-5.6-1.5M9 9v3a3 3 0 004.6 2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
      : '<path d="M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3z" stroke="currentColor" stroke-width="2"/><path d="M6 11a6 6 0 0012 0M12 19v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    row.innerHTML = `
      <div class="avatar on">${escapeHtml(initials(id))}</div>
      <div class="vm-name">${escapeHtml(label)}</div>
      <svg class="mic-icon" viewBox="0 0 24 24" fill="none">${micPath}</svg>
    `;
    wrap.appendChild(row);
  });
  return wrap;
}

document.querySelectorAll('.add-channel-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.kind;
    const name = prompt(kind === 'voz' ? 'Nome do novo canal de voz:' : 'Nome do novo canal de texto:');
    if (name && name.trim()) send({ type: 'create-channel', name: name.trim(), kind });
  });
});

function selectChannel(id) {
  selectedChannelId = id;
  const channel = channels.find((c) => c.id === id);
  renderChannelList();
  if (!channel) {
    channelTitleText.textContent = 'Nenhum canal';
    participantCountEl.textContent = '';
    voiceViewEl.hidden = true;
    textViewEl.hidden = true;
    controlsRowEl.hidden = true;
    return;
  }

  channelTitleText.textContent = channel.name;

  if (channel.kind === 'texto') {
    voiceViewEl.hidden = true;
    textViewEl.hidden = false;
    controlsRowEl.hidden = true;
    messagesEl.innerHTML = '';
    send({ type: 'get-messages', channelId: id });
  } else {
    textViewEl.hidden = true;
    voiceViewEl.hidden = false;
    renderVoiceViewState();
  }
}

function renderVoiceViewState() {
  const connectedHere = activeVoiceChannelId === selectedChannelId;
  prejoinEl.hidden = connectedHere;
  controlsRowEl.hidden = !connectedHere;
  updateParticipantLabel();
}

function updateParticipantLabel() {
  if (activeVoiceChannelId === selectedChannelId && activeVoiceChannelId != null) {
    participantCountEl.textContent = `· ${peers.size + 1} na chamada`;
  } else {
    participantCountEl.textContent = '';
  }
}

function renderInCallBanner() {
  if (activeVoiceChannelId == null) {
    inCallBanner.hidden = true;
    return;
  }
  const channel = channels.find((c) => c.id === activeVoiceChannelId);
  inCallBanner.hidden = false;
  inCallText.textContent = `Na chamada: ${channel ? channel.name : ''}`;
}

// ---- Chat de texto ----
messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const content = messageInput.value.trim();
  if (!content || selectedChannelId == null) return;
  send({ type: 'send-message', channelId: selectedChannelId, content });
  messageInput.value = '';
});

function appendMessageEl(m) {
  const el = document.createElement('div');
  el.className = 'message';
  el.innerHTML = `
    <div class="message-head"><span class="message-author">${escapeHtml(m.username)}</span><span class="message-time">${formatTime(m.createdAt)}</span></div>
    <div class="message-body">${escapeHtml(m.content)}</div>
  `;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---- Tiles de vídeo ----
function ensureTile(id, label) {
  let tile = document.getElementById(`tile-${id}`);
  if (tile) return tile.querySelector('video');

  tile = document.createElement('div');
  tile.className = 'video-card';
  tile.id = `tile-${id}`;
  tile.innerHTML = `
    <video autoplay playsinline${id === 'local' ? ' muted' : ''}></video>
    <div class="video-label">
      <svg class="mic-icon" viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3z" stroke="currentColor" stroke-width="2"/><path d="M6 11a6 6 0 0012 0M12 19v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
  videoGrid.appendChild(tile);
  return tile.querySelector('video');
}

function removeTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
}

function updateTileVisual(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (!tile) return;
  const st = states.get(id) || {};
  const hasVideo = !!(st.camera || st.sharing);
  const video = tile.querySelector('video');
  video.classList.toggle('empty', !hasVideo);

  let avatar = tile.querySelector('.avatar');
  if (!hasVideo) {
    if (!avatar) {
      avatar = document.createElement('div');
      avatar.className = 'avatar on';
      tile.appendChild(avatar);
    }
    avatar.textContent = initials(id);
  } else if (avatar) {
    avatar.remove();
  }

  tile.classList.toggle('sharing', !!st.sharing);
  tile.classList.toggle('muted', !!st.muted);
}

function updateLocalPreview() {
  const video = ensureTile('local', myUsername || 'Você');
  const track = screenTrack || cameraTrack;
  video.srcObject = track ? new MediaStream([track]) : null;
  updateTileVisual('local');
}

function updateSharingPill() {
  const sharers = [...states.entries()].filter(([, st]) => st.sharing).map(([id]) => id);
  if (sharers.length === 0) {
    sharingPillEl.hidden = true;
    return;
  }
  sharingPillEl.hidden = false;
  if (sharers.length === 1 && sharers[0] === 'local') {
    sharingTextEl.textContent = 'Você está compartilhando a tela';
  } else if (sharers.length === 1) {
    sharingTextEl.textContent = `${(states.get(sharers[0]) || {}).username || 'Um convidado'} está compartilhando a tela`;
  } else {
    sharingTextEl.textContent = `${sharers.length} pessoas compartilhando a tela`;
  }
}

// ---- Quem está falando ----
function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function attachSpeakingMeter(id, stream) {
  if (speakingMeters.has(id) || stream.getAudioTracks().length === 0) return;
  const ctx = ensureAudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const intervalId = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    setSpeaking(id, Math.sqrt(sumSquares / data.length) > 0.04);
  }, 150);

  speakingMeters.set(id, intervalId);
}

function detachSpeakingMeter(id) {
  const intervalId = speakingMeters.get(id);
  if (intervalId) clearInterval(intervalId);
  speakingMeters.delete(id);
  setSpeaking(id, false);
}

function setSpeaking(id, isSpeaking) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.classList.toggle('speaking', isSpeaking);
  const vm = document.getElementById(`vm-${id}`);
  if (vm) vm.classList.toggle('speaking', isSpeaking);
}

// ---- Estado (mudo / câmera / compartilhando) ----
function broadcastState() {
  const st = states.get('local');
  if (!st) return;
  send({ type: 'state', muted: st.muted, sharing: st.sharing, camera: st.camera });
}

// ---- Peer connections (mesh, escopo = canal de voz atual) ----
function createPeer(peerId, label) {
  const pc = new RTCPeerConnection(rtcConfig);
  const state = { pc, polite: myId < peerId, makingOffer: false, ignoreOffer: false };

  state.audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  state.videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });

  if (myAudioTrack) state.audioTransceiver.sender.replaceTrack(myAudioTrack);
  const currentVideo = screenTrack || cameraTrack;
  if (currentVideo) state.videoTransceiver.sender.replaceTrack(currentVideo);

  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(peerId, { type: 'sdp', description: pc.localDescription });
    } catch (err) {
      console.error('Erro ao negociar com', peerId, err);
    } finally {
      state.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(peerId, { type: 'ice', candidate });
  };

  pc.ontrack = (event) => {
    const video = ensureTile(peerId, (states.get(peerId) || {}).username || 'Convidado');
    video.srcObject = event.streams[0];
    updateTileVisual(peerId);
    if (event.track.kind === 'audio') attachSpeakingMeter(peerId, new MediaStream([event.track]));
  };

  peers.set(peerId, state);

  if (!states.has(peerId)) states.set(peerId, { muted: false, sharing: false, camera: false, username: label || 'Convidado' });
  ensureTile(peerId, (states.get(peerId) || {}).username || 'Convidado');
  updateTileVisual(peerId);
  renderChannelList();
  updateParticipantLabel();

  return state;
}

function getOrCreatePeer(peerId, label) {
  return peers.get(peerId) || createPeer(peerId, label);
}

function closePeer(peerId) {
  const state = peers.get(peerId);
  if (!state) return;
  state.pc.close();
  peers.delete(peerId);
  states.delete(peerId);
  detachSpeakingMeter(peerId);
  removeTile(peerId);
  renderChannelList();
  updateSharingPill();
  updateParticipantLabel();
}

async function handleSignal(fromId, msg) {
  const state = getOrCreatePeer(fromId);
  const { pc } = state;

  if (msg.type === 'sdp') {
    const description = msg.description;
    const offerCollision = description.type === 'offer' && (state.makingOffer || pc.signalingState !== 'stable');
    state.ignoreOffer = !state.polite && offerCollision;
    if (state.ignoreOffer) return;

    await pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      sendSignal(fromId, { type: 'sdp', description: pc.localDescription });
    }
  } else if (msg.type === 'ice') {
    try {
      await pc.addIceCandidate(msg.candidate);
    } catch (err) {
      if (!state.ignoreOffer) console.error('Erro ao adicionar ICE candidate', err);
    }
  }
}

// ---- Entrar/sair de um canal de voz ----
async function joinVoice(channelId) {
  if (activeVoiceChannelId != null && activeVoiceChannelId !== channelId) {
    await leaveVoice();
  }

  ensureAudioCtx();
  const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  myAudioTrack = audioStream.getAudioTracks()[0];
  attachSpeakingMeter('local', audioStream);
  states.set('local', { muted: false, sharing: false, camera: false, username: myUsername });
  updateLocalPreview();

  send({ type: 'join-voice', channelId });
  activeVoiceChannelId = channelId;
  renderChannelList();
  renderVoiceViewState();
  renderInCallBanner();
  broadcastState();
}

async function leaveVoice() {
  if (activeVoiceChannelId == null) return;
  send({ type: 'leave-voice' });

  for (const id of [...peers.keys()]) closePeer(id);
  if (myAudioTrack) { myAudioTrack.stop(); myAudioTrack = null; }
  if (cameraTrack) { cameraTrack.stop(); cameraTrack = null; }
  if (screenTrack) { screenTrack.stop(); screenTrack = null; }
  detachSpeakingMeter('local');
  states.delete('local');
  removeTile('local');

  activeVoiceChannelId = null;
  cameraBtn.classList.remove('active');
  shareBtn.classList.remove('active');
  micBtn.classList.remove('muted');
  renderChannelList();
  renderVoiceViewState();
  renderInCallBanner();
  updateSharingPill();
}

callBtn.addEventListener('click', () => joinVoice(selectedChannelId));
leaveBtn.addEventListener('click', () => leaveVoice());
inCallLeaveBtn.addEventListener('click', () => leaveVoice());
inCallBanner.addEventListener('click', (e) => {
  if (e.target.closest('#in-call-leave')) return;
  if (activeVoiceChannelId != null) selectChannel(activeVoiceChannelId);
});

// ---- Mudo ----
function toggleMic() {
  if (activeVoiceChannelId == null) return;
  const st = states.get('local');
  st.muted = !st.muted;
  if (myAudioTrack) myAudioTrack.enabled = !st.muted;
  micBtn.classList.toggle('muted', st.muted);
  renderChannelList();
  broadcastState();
}

// ---- Câmera ----
async function toggleCamera() {
  if (activeVoiceChannelId == null) return;

  if (cameraTrack) {
    cameraTrack.stop();
    cameraTrack = null;
    cameraBtn.classList.remove('active');
    if (!screenTrack) await setVideoForAll(null);
    states.get('local').camera = false;
    updateLocalPreview();
    broadcastState();
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  cameraTrack = stream.getVideoTracks()[0];
  cameraBtn.classList.add('active');
  states.get('local').camera = true;
  if (!screenTrack) await setVideoForAll(cameraTrack);
  updateLocalPreview();
  broadcastState();
}

async function setVideoForAll(track) {
  await Promise.all([...peers.values()].map((state) => state.videoTransceiver.sender.replaceTrack(track)));
}

// ---- Compartilhar tela (com qualidade escolhida) ----
async function toggleShare() {
  if (activeVoiceChannelId == null) return;
  if (screenTrack) {
    stopShare();
    return;
  }

  const preset = QUALITY_PRESETS[shareQualitySelect.value] || {};
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: preset, audio: false });

  screenTrack = stream.getVideoTracks()[0];
  await setVideoForAll(screenTrack);
  shareBtn.classList.add('active');
  states.get('local').sharing = true;
  updateLocalPreview();
  updateSharingPill();
  broadcastState();

  screenTrack.onended = stopShare;
}

async function stopShare() {
  if (!screenTrack) return;
  screenTrack.stop();
  screenTrack = null;
  shareBtn.classList.remove('active');
  states.get('local').sharing = false;

  await setVideoForAll(cameraTrack || null);
  updateLocalPreview();
  updateSharingPill();
  broadcastState();
}

shareQualitySelect.addEventListener('change', async () => {
  if (!screenTrack) return;
  const preset = QUALITY_PRESETS[shareQualitySelect.value] || {};
  try {
    await screenTrack.applyConstraints(preset);
  } catch (err) {
    console.error('Não foi possível aplicar a nova qualidade agora', err);
  }
});

micBtn.addEventListener('click', toggleMic);
cameraBtn.addEventListener('click', toggleCamera);
shareBtn.addEventListener('click', toggleShare);

// ---- Conexão com o servidor ----
function connectSignaling() {
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    const token = localStorage.getItem('sinal_token');
    if (token) {
      setStatus('entrando…');
      send({ type: 'resume', token });
    } else {
      setStatus('desconectado');
    }
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'auth-ok') {
      onAuthenticated(msg);
    } else if (msg.type === 'register-ok') {
      showToast(`Conta "${msg.username}" criada! Agora é só entrar.`);
      setAuthMode('login');
      authUsernameInput.value = msg.username;
      authPasswordInput.value = '';
      authPasswordInput.focus();
    } else if (msg.type === 'auth-error') {
      if (appEl.hidden) {
        localStorage.removeItem('sinal_token');
        showAuthError(msg.message);
      }
    } else if (msg.type === 'channel-created') {
      channels.push(msg.channel);
      renderChannelList();
    } else if (msg.type === 'channel-deleted') {
      channels = channels.filter((c) => c.id !== msg.channelId);
      if (activeVoiceChannelId === msg.channelId) await leaveVoice();
      if (selectedChannelId === msg.channelId) {
        selectChannel(channels[0] ? channels[0].id : null);
      } else {
        renderChannelList();
      }
    } else if (msg.type === 'messages-history') {
      if (msg.channelId === selectedChannelId) {
        messagesEl.innerHTML = '';
        msg.messages.forEach(appendMessageEl);
      }
    } else if (msg.type === 'message') {
      if (msg.channelId === selectedChannelId) appendMessageEl(msg.message);
    } else if (msg.type === 'voice-welcome') {
      msg.peers.forEach((p) => getOrCreatePeer(p.id, p.username));
      renderChannelList();
      updateParticipantLabel();
    } else if (msg.type === 'peer-joined') {
      getOrCreatePeer(msg.id, msg.username);
      renderChannelList();
      updateParticipantLabel();
    } else if (msg.type === 'peer-left') {
      closePeer(msg.id);
    } else if (msg.type === 'sdp' || msg.type === 'ice') {
      await handleSignal(msg.from, msg);
    } else if (msg.type === 'state') {
      const prev = states.get(msg.from) || {};
      states.set(msg.from, { ...prev, muted: !!msg.muted, sharing: !!msg.sharing, camera: !!msg.camera });
      updateTileVisual(msg.from);
      renderChannelList();
      updateSharingPill();
    }
  };

  ws.onerror = () => setStatus('erro de conexão');
  ws.onclose = () => setStatus('desconectado');
}

async function init() {
  // Antes isso vinha do config.json via window.sinal.getConfig(), que só
  // existe dentro do Electron. Rodando num navegador comum (Vercel), a
  // configuração vem do config.js, carregado antes deste arquivo.
  const config = window.SINAL_CONFIG || {};
  SIGNALING_URL = config.signalingUrl || SIGNALING_URL;
  if (config.turnServer) rtcConfig.iceServers.push(config.turnServer);
  connectSignaling();
}

init();

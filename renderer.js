// O endereço do servidor vem do config.json.
let SIGNALING_URL = 'ws://localhost:8080';

let ws;
let myId = null;
let inCall = false;

let myAudioTrack = null; // microfone, quando na chamada
let cameraTrack = null; // track da câmera, quando ligada
let screenTrack = null; // track da tela, quando compartilhando

let audioCtx = null;
const speakingMeters = new Map(); // id -> intervalId, pra detectar quem tá falando

// Estado (mudo / compartilhando tela / câmera ligada) de cada participante,
// incluindo 'local' pra mim mesmo. É isso que decide se o tile mostra vídeo
// ou o avatar, o ícone de mudo na lista e o aviso "compartilhando a tela".
const states = new Map(); // id -> { muted, sharing, camera }

// Chamada em grupo = "mesh": uma RTCPeerConnection direta pra cada outro
// participante da sala. Funciona bem pra grupos pequenos (recomendado até
// uns 4-5 amigos ao mesmo tempo — cada pessoa manda o próprio áudio/vídeo
// pra todo mundo, então o consumo de upload cresce com o número de gente).
// A chave do Map é o id que o servidor de sinalização deu a cada participante.
const peers = new Map(); // id -> { pc, audioTransceiver, videoTransceiver, polite, makingOffer, ignoreOffer }

const videoGrid = document.getElementById('video-grid');
const voiceMembersEl = document.getElementById('voice-members');
const statusEl = document.getElementById('status');
const participantCountEl = document.getElementById('participant-count');
const sharingPillEl = document.getElementById('sharing-pill');
const sharingTextEl = document.getElementById('sharing-text');
const prejoinEl = document.getElementById('pre-join');
const controlsRowEl = document.getElementById('controls-row');
const callBtn = document.getElementById('call-btn');
const micBtn = document.getElementById('mic-btn');
const cameraBtn = document.getElementById('camera-btn');
const shareBtn = document.getElementById('share-btn');

let rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function setStatus(text) {
  statusEl.textContent = text;
}

function participantCount() {
  return peers.size + 1; // +1 = eu
}

function updateParticipantCount() {
  participantCountEl.textContent = inCall ? `· ${participantCount()} na chamada` : '';
}

function initials(id) {
  return id === 'local' ? 'VC' : id.slice(0, 2).toUpperCase();
}

// ---- Tiles de vídeo: um por participante, criados/removidos dinamicamente ----
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
      <span>${label}</span>
    </div>
  `;
  videoGrid.appendChild(tile);
  return tile.querySelector('video');
}

function removeTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
}

// Mostra vídeo de verdade só quando a pessoa tem câmera ou tela ligada;
// caso contrário mostra o avatar com as iniciais, junto do resto do visual
// (borda de "compartilhando", ícone de mudo).
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
      avatar.textContent = initials(id);
      tile.appendChild(avatar);
    }
  } else if (avatar) {
    avatar.remove();
  }

  tile.classList.toggle('sharing', !!st.sharing);
  tile.classList.toggle('muted', !!st.muted);
}

function updateLocalPreview() {
  const video = ensureTile('local', 'Você');
  const track = screenTrack || cameraTrack;
  video.srcObject = track ? new MediaStream([track]) : null;
  updateTileVisual('local');
}

// ---- Lista "NA CHAMADA" da barra lateral — espelha os tiles de vídeo ----
function renderSidebarList() {
  voiceMembersEl.innerHTML = '';
  const entries = [{ id: 'local', label: 'Você' }, ...[...peers.keys()].map((id) => ({ id, label: 'Convidado' }))];

  entries.forEach(({ id, label }) => {
    const st = states.get(id) || {};
    const row = document.createElement('div');
    row.className = 'vm' + (st.muted ? ' muted' : '');
    row.id = `vm-${id}`;
    const micPath = st.muted
      ? '<path d="M3 3l18 18M12 15a3 3 0 003-3V6a3 3 0 00-5.6-1.5M9 9v3a3 3 0 004.6 2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
      : '<path d="M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3z" stroke="currentColor" stroke-width="2"/><path d="M6 11a6 6 0 0012 0M12 19v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    row.innerHTML = `
      <div class="avatar on">${initials(id)}</div>
      <div class="vm-name">${label}</div>
      <svg class="mic-icon" viewBox="0 0 24 24" fill="none">${micPath}</svg>
    `;
    voiceMembersEl.appendChild(row);
  });
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
    sharingTextEl.textContent = 'Um convidado está compartilhando a tela';
  } else {
    sharingTextEl.textContent = `${sharers.length} pessoas compartilhando a tela`;
  }
}

// ---- Quem está falando: mede o volume do áudio local e de cada participante ----
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
    const rms = Math.sqrt(sumSquares / data.length);
    setSpeaking(id, rms > 0.04);
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

// ---- Sinalização ----
function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function sendSignal(targetId, payload) {
  send({ target: targetId, ...payload });
}

// Avisa todo mundo (sem "target") do meu estado atual — é o que faz a lista
// da barra lateral e o aviso de "compartilhando a tela" aparecerem certos
// pros outros participantes.
function broadcastState() {
  const st = states.get('local');
  send({ type: 'state', muted: st.muted, sharing: st.sharing, camera: st.camera });
}

// ---- Peer connections (mesh) ----
// Cada dupla de participantes decide quem é o "educado" (polite) comparando
// os ids — isso evita que os dois lados mandem oferta ao mesmo tempo quando
// várias pessoas entram na sala perto uma da outra. É o padrão "perfect
// negotiation" recomendado pela própria especificação do WebRTC: o lado
// "educado" aceita a oferta que chegou e descarta a sua; o outro lado ignora
// a oferta que chegou e segue com a dele.
function createPeer(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);
  const state = { pc, polite: myId < peerId, makingOffer: false, ignoreOffer: false };

  // Cria os "espaços" de áudio e vídeo já de cara, mesmo sem track nenhuma
  // ainda — assim, ligar/desligar câmera ou tela depois só troca o conteúdo
  // (replaceTrack) sem precisar renegociar a conexão.
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
    const video = ensureTile(peerId, 'Convidado');
    video.srcObject = event.streams[0];
    updateTileVisual(peerId);
    if (event.track.kind === 'audio') attachSpeakingMeter(peerId, new MediaStream([event.track]));
  };

  peers.set(peerId, state);

  if (!states.has(peerId)) states.set(peerId, { muted: false, sharing: false, camera: false });
  ensureTile(peerId, 'Convidado');
  updateTileVisual(peerId);
  renderSidebarList();
  updateParticipantCount();

  return state;
}

function getOrCreatePeer(peerId) {
  return peers.get(peerId) || createPeer(peerId);
}

function closePeer(peerId) {
  const state = peers.get(peerId);
  if (!state) return;
  state.pc.close();
  peers.delete(peerId);
  states.delete(peerId);
  detachSpeakingMeter(peerId);
  removeTile(peerId);
  renderSidebarList();
  updateSharingPill();
  updateParticipantCount();
}

async function handleSignal(fromId, msg) {
  const state = getOrCreatePeer(fromId);
  const { pc } = state;

  if (msg.type === 'sdp') {
    const description = msg.description;
    const offerCollision =
      description.type === 'offer' && (state.makingOffer || pc.signalingState !== 'stable');

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

// ---- Entrar na chamada ----
async function joinCall() {
  ensureAudioCtx(); // clique do usuário — aproveita o gesto pra liberar o áudio

  const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  myAudioTrack = audioStream.getAudioTracks()[0];
  inCall = true;
  attachSpeakingMeter('local', audioStream);
  updateLocalPreview();

  // Se já tinha gente na sala (conexões criadas em segundo plano ao abrir o
  // app), manda meu áudio pra eles agora.
  for (const state of peers.values()) {
    state.audioTransceiver.sender.replaceTrack(myAudioTrack);
  }

  prejoinEl.hidden = true;
  controlsRowEl.hidden = false;
  callBtn.disabled = true;
  updateParticipantCount();
  broadcastState();
}

// ---- Mudo: só disponível depois de entrar na chamada ----
function toggleMic() {
  if (!inCall) return;
  const st = states.get('local');
  st.muted = !st.muted;
  if (myAudioTrack) myAudioTrack.enabled = !st.muted;
  micBtn.classList.toggle('muted', st.muted);
  renderSidebarList();
  broadcastState();
}

// ---- Câmera: só liga quando o usuário clica no botão ----
async function toggleCamera() {
  if (!inCall) return;

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

  // Só manda a câmera pros amigos se não tiver compartilhamento de tela ativo
  // (os dois dividem o mesmo "espaço" de vídeo, igual antes).
  if (!screenTrack) await setVideoForAll(cameraTrack);
  updateLocalPreview();
  broadcastState();
}

// Aplica a mesma track de vídeo (ou null) em todas as conexões da mesh de
// uma vez — é assim que câmera/tela chegam pra todo mundo ao mesmo tempo.
async function setVideoForAll(track) {
  await Promise.all(
    [...peers.values()].map((state) => state.videoTransceiver.sender.replaceTrack(track))
  );
}

// ---- Compartilhar tela: liga e para com o mesmo botão ----
async function toggleShare() {
  if (!inCall) return;

  if (screenTrack) {
    stopShare();
    return;
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 60 },
    audio: false,
  });

  screenTrack = stream.getVideoTracks()[0];
  await setVideoForAll(screenTrack);
  shareBtn.classList.add('active');
  states.get('local').sharing = true;
  updateLocalPreview();
  updateSharingPill();
  broadcastState();

  // Se o usuário parar pelos controles do próprio Windows (barra de captura),
  // isso também deve atualizar o botão do app.
  screenTrack.onended = stopShare;
}

async function stopShare() {
  if (!screenTrack) return;
  screenTrack.stop();
  screenTrack = null;
  shareBtn.classList.remove('active');
  states.get('local').sharing = false;

  // Volta pra câmera, se estiver ligada; senão fica sem vídeo.
  await setVideoForAll(cameraTrack || null);
  updateLocalPreview();
  updateSharingPill();
  broadcastState();
}

// ---- Conexão com o servidor de sinalização ----
function connectSignaling() {
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => setStatus('conectado');

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'welcome') {
      myId = msg.id;
      // Já cria a conexão com quem estiver na sala (sem áudio/vídeo ainda,
      // até eu clicar em "Entrar na chamada").
      msg.peers.forEach((peerId) => getOrCreatePeer(peerId));
    } else if (msg.type === 'peer-joined') {
      getOrCreatePeer(msg.id);
    } else if (msg.type === 'peer-left') {
      closePeer(msg.id);
    } else if (msg.type === 'sdp' || msg.type === 'ice') {
      await handleSignal(msg.from, msg);
    } else if (msg.type === 'state') {
      states.set(msg.from, { muted: !!msg.muted, sharing: !!msg.sharing, camera: !!msg.camera });
      updateTileVisual(msg.from);
      renderSidebarList();
      updateSharingPill();
    }
  };

  ws.onerror = () => setStatus('erro de conexão');
  ws.onclose = () => setStatus('desconectado');
}

callBtn.addEventListener('click', joinCall);
micBtn.addEventListener('click', toggleMic);
cameraBtn.addEventListener('click', toggleCamera);
shareBtn.addEventListener('click', toggleShare);

async function init() {
  states.set('local', { muted: false, sharing: false, camera: false });
  ensureTile('local', 'Você');
  updateTileVisual('local');
  renderSidebarList();

  const config = await window.sinal.getConfig();
  SIGNALING_URL = config.signalingUrl;
  if (config.turnServer) {
    rtcConfig.iceServers.push(config.turnServer);
  }
  connectSignaling();
}

init();

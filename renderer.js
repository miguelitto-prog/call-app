// O endereço do servidor vem do config.json.
let SIGNALING_URL = 'ws://localhost:8080';

let ws;
let myId = null;
let inCall = false;

let myAudioTrack = null; // microfone, quando na chamada
let cameraTrack = null; // track da câmera, quando ligada
let screenTrack = null; // track da tela, quando compartilhando

// Chamada em grupo = "mesh": uma RTCPeerConnection direta pra cada outro
// participante da sala. Funciona bem pra grupos pequenos (recomendado até
// uns 4-5 amigos ao mesmo tempo — cada pessoa manda o próprio áudio/vídeo
// pra todo mundo, então o consumo de upload cresce com o número de gente).
// A chave do Map é o id que o servidor de sinalização deu a cada participante.
const peers = new Map(); // id -> { pc, audioTransceiver, videoTransceiver, polite, makingOffer, ignoreOffer }

const videoGrid = document.getElementById('video-grid');
const statusEl = document.getElementById('status');
const callBtn = document.getElementById('call-btn');
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

// ---- Tiles de vídeo: um por participante, criados/removidos dinamicamente ----
function ensureTile(id, label) {
  let tile = document.getElementById(`tile-${id}`);
  if (tile) return tile.querySelector('video');

  tile = document.createElement('div');
  tile.className = 'video-card';
  tile.id = `tile-${id}`;
  tile.innerHTML = `
    <video autoplay playsinline${id === 'local' ? ' muted' : ''}></video>
    <div class="video-label">${label}</div>
  `;
  videoGrid.appendChild(tile);
  return tile.querySelector('video');
}

function removeTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
}

function updateLocalPreview() {
  const video = ensureTile('local', 'Você');
  const track = screenTrack || cameraTrack;
  video.srcObject = track ? new MediaStream([track]) : null;
}

// ---- Sinalização ----
function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function sendSignal(targetId, payload) {
  send({ target: targetId, ...payload });
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
    const video = ensureTile(peerId, 'Amigo');
    video.srcObject = event.streams[0];
  };

  peers.set(peerId, state);
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
  removeTile(peerId);
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
  const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  myAudioTrack = audioStream.getAudioTracks()[0];
  inCall = true;
  updateLocalPreview();

  // Se já tinha gente na sala (conexões criadas em segundo plano ao abrir o
  // app), manda meu áudio pra eles agora.
  for (const state of peers.values()) {
    state.audioTransceiver.sender.replaceTrack(myAudioTrack);
  }

  setStatus(`Na chamada (${participantCount()} participantes)`);
  callBtn.disabled = true;
}

// ---- Câmera: só liga quando o usuário clica no botão ----
async function toggleCamera() {
  if (!inCall) {
    setStatus('Entre na chamada antes de ligar a câmera');
    return;
  }

  if (cameraTrack) {
    cameraTrack.stop();
    cameraTrack = null;
    cameraBtn.textContent = 'Ligar câmera';
    if (!screenTrack) await setVideoForAll(null);
    updateLocalPreview();
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  cameraTrack = stream.getVideoTracks()[0];
  cameraBtn.textContent = 'Desligar câmera';

  // Só manda a câmera pros amigos se não tiver compartilhamento de tela ativo
  // (os dois dividem o mesmo "espaço" de vídeo, igual antes).
  if (!screenTrack) await setVideoForAll(cameraTrack);
  updateLocalPreview();
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
  if (!inCall) {
    setStatus('Entre na chamada antes de compartilhar a tela');
    return;
  }

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
  shareBtn.textContent = 'Parar compartilhamento';
  updateLocalPreview();

  // Se o usuário parar pelos controles do próprio Windows (barra de captura),
  // isso também deve atualizar o botão do app.
  screenTrack.onended = stopShare;
}

async function stopShare() {
  if (!screenTrack) return;
  screenTrack.stop();
  screenTrack = null;
  shareBtn.textContent = 'Compartilhar tela';

  // Volta pra câmera, se estiver ligada; senão fica sem vídeo.
  await setVideoForAll(cameraTrack || null);
  updateLocalPreview();
}

// ---- Conexão com o servidor de sinalização ----
function connectSignaling() {
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => setStatus('Conectado — pronto pra entrar na chamada');

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'welcome') {
      myId = msg.id;
      // Já cria a conexão com quem estiver na sala (sem áudio/vídeo ainda,
      // até eu clicar em "Entrar na chamada").
      msg.peers.forEach((peerId) => getOrCreatePeer(peerId));
    } else if (msg.type === 'peer-joined') {
      getOrCreatePeer(msg.id);
      if (inCall) setStatus(`Na chamada (${participantCount()} participantes)`);
    } else if (msg.type === 'peer-left') {
      closePeer(msg.id);
      if (inCall) setStatus(`Na chamada (${participantCount()} participantes)`);
    } else if (msg.type === 'sdp' || msg.type === 'ice') {
      await handleSignal(msg.from, msg);
    }
  };

  ws.onerror = () => setStatus('Não foi possível conectar ao servidor de sinalização');
  ws.onclose = () => setStatus('Desconectado do servidor');
}

callBtn.addEventListener('click', joinCall);
cameraBtn.addEventListener('click', toggleCamera);
shareBtn.addEventListener('click', toggleShare);

async function init() {
  const config = await window.sinal.getConfig();
  SIGNALING_URL = config.signalingUrl;
  if (config.turnServer) {
    rtcConfig.iceServers.push(config.turnServer);
  }
  connectSignaling();
}

init();

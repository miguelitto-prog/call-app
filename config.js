// Configuração do Sinal rodando no navegador (Vercel ou qualquer host
// estático). Antes esse endereço vinha do config.json lido pelo Electron;
// agora é só editar aqui.
window.SINAL_CONFIG = {
  signalingUrl: 'wss://call-app-1-ulv1.onrender.com',

  // Se precisar de um servidor TURN pra amigos atrás de rede mais restrita:
  // turnServer: { urls: 'turn:standard.relay.metered.ca:80', username: '...', credential: '...' },
};

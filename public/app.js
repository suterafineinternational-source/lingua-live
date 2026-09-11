const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const els = {
  start: $('#startBtn'), statusDot: $('#statusDot'), statusText: $('#statusText'), latency: $('#latency'),
  room: $('#roomCode'), source: $('#sourceTranscript'), target: $('#targetTranscript'), audio: $('#translatedAudio'),
  captions: $('#captionsBtn'), captionStage: $('#captionStage'), captionText: $('#captionText'), voice: $('#voiceBtn'),
  invite: $('#inviteBtn'), exportBtn: $('#exportBtn'), settingsBtn: $('#settingsBtn'), settingsDialog: $('#settingsDialog'),
  volume: $('#volume'), micMode: $('#micMode'), tabMode: $('#tabMode')
};

let running = false;
let sourceMode = 'mic';
let sourceStream = null;
let pc = null;
let events = null;
let sourceText = '';
let targetText = '';
let startedAt = null;
let firstOutputAt = null;
let audioEnabled = true;
let captionEnabled = false;

const params = new URLSearchParams(location.search);
const room = (params.get('room') || Math.random().toString(36).slice(2, 8)).toUpperCase();
els.room.textContent = room;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

function setStatus(text, mode='idle') {
  els.statusText.textContent = text;
  els.statusDot.className = 'dot' + (mode === 'live' ? ' live' : mode === 'error' ? ' error' : '');
}

function setText(el, text) {
  el.classList.remove('placeholder');
  el.textContent = text || '—';
  el.scrollTop = el.scrollHeight;
}

function resetTranscripts() {
  sourceText = '';
  targetText = '';
  firstOutputAt = null;
  els.source.textContent = 'Il parlato riconosciuto apparirà qui…';
  els.source.classList.add('placeholder');
  els.target.textContent = 'La traduzione apparirà e verrà letta qui…';
  els.target.classList.add('placeholder');
  els.captionText.textContent = 'Waiting for speech…';
  els.latency.textContent = '—';
}

async function captureSource() {
  if (sourceMode === 'tab') {
    const audio = { echoCancellation:false, noiseSuppression:false, autoGainControl:false };
    if (navigator.mediaDevices.getSupportedConstraints?.().suppressLocalAudioPlayback) {
      audio.suppressLocalAudioPlayback = true;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Seleziona una scheda del browser e abilita “Condividi audio scheda”.');
    }
    return stream;
  }

  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
    video: false
  });
}

async function createSession() {
  const res = await fetch('/api/session', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ targetLanguage:'en' })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || data?.error || 'Impossibile creare la sessione Realtime.');
  return data;
}

function handleRealtimeEvent(event) {
  if (event.type === 'session.input_transcript.delta') {
    sourceText += event.delta || '';
    setText(els.source, sourceText);
  }

  if (event.type === 'session.output_transcript.delta') {
    if (!firstOutputAt) {
      firstOutputAt = performance.now();
      els.latency.textContent = `${Math.max(0, Math.round(firstOutputAt - startedAt))} ms*`;
    }
    targetText += event.delta || '';
    setText(els.target, targetText);
    els.captionText.textContent = targetText.slice(-260).trim();
  }

  if (event.type === 'error') {
    console.error(event);
    setStatus('Errore Realtime', 'error');
    toast(event.error?.message || 'Errore nel flusso Realtime');
  }
}

async function openRealtimeTranslation() {
  sourceStream = await captureSource();
  const session = await createSession();

  pc = new RTCPeerConnection();
  events = pc.createDataChannel('oai-events');

  for (const track of sourceStream.getAudioTracks()) pc.addTrack(track, sourceStream);

  pc.ontrack = ({ streams }) => {
    els.audio.srcObject = streams[0];
    els.audio.volume = Number(els.volume.value);
    if (audioEnabled) els.audio.play().catch(() => {});
  };

  events.onopen = () => setStatus('Interpretazione attiva', 'live');
  events.onmessage = ({ data }) => {
    try {
      handleRealtimeEvent(JSON.parse(data));
    } catch {
      // Ignore non-JSON events.
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch('https://api.openai.com/v1/realtime/translations/calls', {
    method:'POST',
    headers:{
      Authorization:`Bearer ${session.client_secret}`,
      'Content-Type':'application/sdp'
    },
    body: offer.sdp
  });

  if (!sdpRes.ok) throw new Error(await sdpRes.text() || 'Errore WebRTC OpenAI.');
  await pc.setRemoteDescription({ type:'answer', sdp: await sdpRes.text() });
}

async function start() {
  if (running) return stop();

  resetTranscripts();
  setStatus('Connessione…');
  els.start.disabled = true;
  startedAt = performance.now();

  try {
    await openRealtimeTranslation();
    running = true;
    els.start.textContent = '■ Ferma interpretazione';
    els.start.classList.add('stop');
    setStatus('Interpretazione attiva', 'live');
  } catch (error) {
    console.error(error);
    setStatus('Errore', 'error');
    toast(error.message);
    await cleanup();
  } finally {
    els.start.disabled = false;
  }
}

async function cleanup() {
  try {
    if (events?.readyState === 'open') events.send(JSON.stringify({ type:'session.close' }));
  } catch {}
  try { pc?.getSenders().forEach((s) => s.track?.stop()); } catch {}
  try { pc?.close(); } catch {}
  try { sourceStream?.getTracks().forEach((t) => t.stop()); } catch {}
  pc = null;
  events = null;
  sourceStream = null;
  els.audio.srcObject = null;
}

async function stop() {
  await cleanup();
  running = false;
  setStatus('Pronto');
  els.latency.textContent = '—';
  els.start.textContent = '▶ Avvia interpretazione';
  els.start.classList.remove('stop');
}

els.start.addEventListener('click', start);

els.micMode.addEventListener('click', () => {
  if (running) return toast('Ferma prima la sessione.');
  sourceMode = 'mic';
  els.micMode.classList.add('active');
  els.tabMode.classList.remove('active');
});

els.tabMode.addEventListener('click', () => {
  if (running) return toast('Ferma prima la sessione.');
  sourceMode = 'tab';
  els.tabMode.classList.add('active');
  els.micMode.classList.remove('active');
});

$$('[data-accent]').forEach((btn) => btn.addEventListener('click', () => {
  $$('[data-accent]').forEach((x) => x.classList.remove('active'));
  btn.classList.add('active');
  localStorage.setItem('linguaAccent', btn.dataset.accent);
  toast(btn.dataset.accent === 'us' ? 'Preferenza: inglese americano' : 'Preferenza: inglese britannico');
}));

const savedAccent = localStorage.getItem('linguaAccent');
if (savedAccent) {
  const savedButton = $(`[data-accent="${savedAccent}"]`);
  if (savedButton) savedButton.click();
}

els.voice.addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  els.voice.textContent = `🔊 Voce: ${audioEnabled ? 'ON' : 'OFF'}`;
  els.audio.muted = !audioEnabled;
});

els.captions.addEventListener('click', () => {
  captionEnabled = !captionEnabled;
  els.captionStage.hidden = !captionEnabled;
  els.captions.classList.toggle('active', captionEnabled);
});

els.volume.addEventListener('input', () => {
  els.audio.volume = Number(els.volume.value);
});

els.settingsBtn.addEventListener('click', () => els.settingsDialog.showModal());

els.invite.addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Link stanza copiato negli appunti');
  } catch {
    prompt('Copia il link stanza:', link);
  }
});

els.exportBtn.addEventListener('click', () => {
  const txt = `LINGUA LIVE — TRASCRIZIONE\nStanza: ${room}\nData: ${new Date().toLocaleString('it-IT')}\n\nITALIANO\n${sourceText}\n\nENGLISH\n${targetText}\n`;
  const blob = new Blob([txt], { type:'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lingua-live-${room}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

window.addEventListener('beforeunload', cleanup);

fetch('/api/health')
  .then((r) => r.json())
  .then((health) => {
    if (!health.realtime) toast('Configura OPENAI_API_KEY per attivare la traduzione Realtime.');
  })
  .catch(() => {});

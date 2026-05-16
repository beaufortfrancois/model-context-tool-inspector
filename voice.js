/**
 * AmiVoice WebSocket speech recognition for WebMCP Voice Inspector.
 *
 * Connects to AmiVoice, streams mic audio, and puts the final recognized
 * text into the existing #userPromptText textarea.
 */

const ENDPOINT = 'wss://acp-api-nolog.amivoice.com/v1/';
const ENGINE = '-a-general';
const AUDIO_FORMAT = 'audio/x-pcm;bit=16;rate=16000;channels=1';
const SAMPLE_RATE = 16000;
const CHUNK_SIZE = 4096;

const startBtn = document.getElementById('voiceStartBtn');
const stopBtn = document.getElementById('voiceStopBtn');
const statusDiv = document.getElementById('voiceStatus');
const resultDiv = document.getElementById('voiceResult');
const userPromptText = document.getElementById('userPromptText');
const amivoiceKeyBtn = document.getElementById('amivoiceKeyBtn');

function getAppKey() {
  return localStorage.amivoiceKey || '';
}

amivoiceKeyBtn.onclick = () => {
  const key = prompt('AmiVoice APPKEY を入力してください', getAppKey());
  if (key == null) return;
  localStorage.amivoiceKey = key;
  updateUI();
};

function updateUI() {
  const hasKey = !!getAppKey();
  startBtn.disabled = !hasKey;
  amivoiceKeyBtn.textContent = hasKey ? 'Update APPKEY' : 'Set APPKEY';
}
updateUI();

// Float32 PCM → Int16 PCM
function encodeToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16.buffer;
}

let ws = null;
let audioCtx = null;
let stream = null;
let processor = null;

function setStatus(text, color) {
  statusDiv.textContent = text;
  statusDiv.style.color = color || '';
}

async function startRecognition() {
  const appKey = getAppKey();
  if (!appKey) {
    alert('AmiVoice APPKEY が未設定です。');
    return;
  }

  startBtn.disabled = true;
  stopBtn.disabled = true;
  resultDiv.textContent = '';
  setStatus('マイク権限取得中...', '#f0a500');

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true },
    });
  } catch (e) {
    setStatus('マイク権限エラー: ' + e.message, 'red');
    startBtn.disabled = false;
    return;
  }

  setStatus('AmiVoice 接続中...', '#f0a500');

  ws = new WebSocket(ENDPOINT);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(`s ${AUDIO_FORMAT} ${ENGINE} ${appKey}`);
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    const type = event.data[0];
    const payload = event.data.slice(2);

    if (type === 's') {
      setStatus('録音中 🔴', '#e53e3e');
      stopBtn.disabled = false;
      startAudio();
    } else if (type === 'A') {
      const text = parseResultText(payload);
      if (text) {
        resultDiv.textContent = text;
        userPromptText.value = (userPromptText.value ? userPromptText.value + ' ' : '') + text;
      }
    } else if (type === 'p') {
      const text = parseResultText(payload);
      if (text) resultDiv.textContent = text + '...';
    } else if (type === 'e') {
      setStatus('エラー: ' + payload, 'red');
      cleanup();
    } else if (type === 'C') {
      cleanup();
    }
  };

  ws.onerror = () => {
    setStatus('WebSocket エラー', 'red');
    cleanup();
  };

  ws.onclose = () => {
    if (statusDiv.textContent === '録音中 🔴') setStatus('切断', '#888');
    cleanup();
  };
}

function startAudio() {
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = audioCtx.createMediaStreamSource(stream);
  processor = audioCtx.createScriptProcessor(CHUNK_SIZE, 1, 1);

  processor.onaudioprocess = (e) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeToInt16(e.inputBuffer.getChannelData(0)));
    }
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);
}

async function stopRecognition() {
  stopBtn.disabled = true;
  setStatus('認識中...', '#3182ce');

  if (ws?.readyState === WebSocket.OPEN) ws.send('e');

  processor?.disconnect();
  processor = null;
  if (audioCtx) { await audioCtx.close(); audioCtx = null; }
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function cleanup() {
  processor?.disconnect();
  processor = null;
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;

  startBtn.disabled = !getAppKey();
  stopBtn.disabled = true;

  if (!statusDiv.textContent.startsWith('エラー') &&
      !statusDiv.textContent.startsWith('マイク権限') &&
      !statusDiv.textContent.startsWith('WebSocket')) {
    setStatus('待機中');
  }
}

function parseResultText(payload) {
  try {
    const json = JSON.parse(payload);
    if (typeof json.text === 'string') return json.text;
    if (Array.isArray(json.results)) {
      return json.results.flatMap((r) => r.tokens?.map((t) => t.written) ?? []).join('');
    }
  } catch {
    return payload.trim();
  }
  return '';
}

startBtn.onclick = () => void startRecognition();
stopBtn.onclick = () => void stopRecognition();

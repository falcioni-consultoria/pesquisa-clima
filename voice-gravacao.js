// Modo gravação: grava o áudio, normaliza o volume e transcreve localmente (Whisper no navegador).
// Funciona bem com voz baixa porque o volume é ajustado antes de transcrever.

async function decodificar(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(buf);
    const x = audio.getChannelData(0).slice();
    let pico = 0;
    for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > pico) pico = v; }
    if (pico < 0.002) return null;
    const ganho = 0.9 / pico;
    for (let i = 0; i < x.length; i++) x[i] *= ganho;
    return x;
  } finally {
    ctx.close().catch(() => {});
  }
}

export function chaveNuvem() {
  try { return localStorage.getItem('falclima_nuvem_key') || ''; } catch (e) { return ''; }
}

export function salvarChaveNuvem(chave) {
  try {
    if (chave) localStorage.setItem('falclima_nuvem_key', chave); else localStorage.removeItem('falclima_nuvem_key');
  } catch (e) { /* sem storage */ }
}

function paraWav(x, taxa) {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const txt = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  txt(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); txt(8, 'WAVE'); txt(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, taxa, true); v.setUint32(28, taxa * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  txt(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 0x7fff, true);
  return buf;
}

export function wavBlob(audio) {
  return new Blob([paraWav(audio, 16000)], { type: 'audio/wav' });
}

// Transcrição na nuvem. Chave "gsk_..." = Groq (gratuito, Whisper large-v3); "sk-..." = OpenAI.
function provedor(chave) {
  return chave.startsWith('gsk_')
    ? { url: 'https://api.groq.com/openai/v1/audio/transcriptions', modelos: ['whisper-large-v3', 'whisper-large-v3-turbo'] }
    : { url: 'https://api.openai.com/v1/audio/transcriptions', modelos: ['gpt-4o-transcribe', 'whisper-1'] };
}

async function transcreverNuvem(audio, chave, dica) {
  const wav = paraWav(audio, 16000);
  const { url, modelos } = provedor(chave);
  for (const modelo of modelos) {
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    fd.append('model', modelo);
    fd.append('language', 'pt');
    fd.append('temperature', '0');
    if (dica) fd.append('prompt', dica);
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${chave}` }, body: fd });
    if (r.status === 401) throw new Error('chave-invalida');
    if (r.ok) return ((await r.json()).text || '').trim();
    if (r.status === 429 && modelo === modelos[modelos.length - 1]) throw new Error('limite');
    if (r.status !== 400 && r.status !== 404 && r.status !== 429) throw new Error('nuvem-' + r.status);
  }
  throw new Error('nuvem-indisponivel');
}

export function criarGravador({ onNivel, onModelo }) {
  const worker = new Worker('whisper-worker.js', { type: 'module' });
  const pendentes = new Map();
  let seq = 0;

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.tipo === 'progresso') { onModelo && onModelo(m.pct); return; }
    if (m.tipo === 'pronto') { onModelo && onModelo(100); return; }
    const p = pendentes.get(m.id);
    if (!p) return;
    pendentes.delete(m.id);
    if (m.tipo === 'texto') p.res(m.texto); else p.rej(new Error(m.mensagem));
  };
  worker.onerror = () => {
    pendentes.forEach((p) => p.rej(new Error('falha ao carregar o modelo de voz')));
    pendentes.clear();
  };

  let stream = null;
  let recorder = null;
  let chunks = [];
  let ctxMedidor = null;
  let timer = null;

  function limpar() {
    clearInterval(timer);
    timer = null;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (ctxMedidor) { ctxMedidor.close().catch(() => {}); ctxMedidor = null; }
  }

  return {
    precarregar() { worker.postMessage({ tipo: 'carregar' }); },

    async iniciar() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      ctxMedidor = new (window.AudioContext || window.webkitAudioContext)();
      const origem = ctxMedidor.createMediaStreamSource(stream);
      const analisador = ctxMedidor.createAnalyser();
      analisador.fftSize = 1024;
      origem.connect(analisador);
      const buf = new Uint8Array(analisador.fftSize);
      const inicio = Date.now();
      let picos = [];
      timer = setInterval(() => {
        analisador.getByteTimeDomainData(buf);
        let soma = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; soma += v * v; }
        const nivel = Math.min(1, Math.sqrt(soma / buf.length) * 12);
        const agora = Date.now();
        picos.push({ t: agora, nivel });
        picos = picos.filter((p) => agora - p.t < 3000);
        const baixo = agora - inicio > 4000 && Math.max(...picos.map((p) => p.nivel)) < 0.08;
        onNivel && onNivel({ nivel, baixo });
      }, 120);
      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.start();
    },

    parar() {
      return new Promise((resolve, reject) => {
        if (!recorder) { resolve(null); return; }
        recorder.onstop = async () => {
          limpar();
          try { resolve(await decodificar(new Blob(chunks, { type: recorder.mimeType }))); } catch (e) { reject(e); }
        };
        recorder.stop();
      });
    },

    cancelar() {
      if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; try { recorder.stop(); } catch (e) { /* já parado */ } }
      limpar();
    },

    async transcrever(audio, dica) {
      const chave = chaveNuvem();
      if (chave) {
        try {
          return await transcreverNuvem(audio, chave, dica);
        } catch (e) {
          if (e.message === 'chave-invalida' || e.message === 'limite') throw e;
          // sem internet ou falha da nuvem: cai para a transcrição local
        }
      }
      return transcreverLocal(audio);
    },

  };

  function transcreverLocal(audio) {
    const id = ++seq;
    return new Promise((res, rej) => {
      pendentes.set(id, { res, rej });
      worker.postMessage({ tipo: 'transcrever', id, audio }, [audio.buffer]);
    });
  }
}

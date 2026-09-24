import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/+esm';

let asr = null;
let carregando = null;

function carregar() {
  if (asr) return Promise.resolve(asr);
  if (!carregando) {
    carregando = pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress') self.postMessage({ tipo: 'progresso', pct: Math.round(p.progress || 0) });
      },
    }).then((a) => {
      asr = a;
      self.postMessage({ tipo: 'pronto' });
      return a;
    });
  }
  return carregando;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.tipo === 'carregar') await carregar();
    if (m.tipo === 'transcrever') {
      const a = await carregar();
      const r = await a(m.audio, { language: 'portuguese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
      self.postMessage({ tipo: 'texto', id: m.id, texto: (r.text || '').trim() });
    }
  } catch (err) {
    carregando = null;
    self.postMessage({ tipo: 'erro', id: m.id, mensagem: String((err && err.message) || err) });
  }
};

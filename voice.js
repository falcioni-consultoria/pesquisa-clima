// Reconhecimento de voz (Web Speech API) + interpretação da resposta falada

const PALAVRAS_NUMERO = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, três: 3, tres: 3, quatro: 4,
  cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
};

function normalizar(txt) {
  return (txt || '').toLowerCase().trim();
}

// Tenta achar uma nota de 0 a 10 no texto falado (dígito tem prioridade sobre palavra)
export function parseNota10(textoFalado) {
  const t = normalizar(textoFalado);
  if (!t) return null;
  const matchDigito = t.match(/\b(10|[0-9])\b/);
  if (matchDigito) return parseInt(matchDigito[1], 10);
  for (const palavra of Object.keys(PALAVRAS_NUMERO)) {
    if (new RegExp(`\\b${palavra}\\b`).test(t)) return PALAVRAS_NUMERO[palavra];
  }
  return null;
}

// Palavras-chave por tipo de escala, da mais específica para a mais genérica
// (evita que "concordo" capture antes de "concordo plenamente")
const CHAVES = {
  concordancia: [
    [5, ['concordo plenamente', 'concordo totalmente']],
    [1, ['discordo plenamente', 'discordo totalmente']],
    [4, ['concordo']],
    [2, ['discordo']],
    [3, ['neutro', 'indiferente', 'nem concordo nem discordo']],
  ],
  satisfacao: [
    [5, ['muito satisfeito']],
    [1, ['muito insatisfeito']],
    [2, ['insatisfeito']],
    [4, ['satisfeito']],
    [3, ['neutro', 'indiferente']],
  ],
  frequencia: [
    [5, ['sempre']],
    [1, ['nunca']],
    [4, ['frequentemente', 'frequente']],
    [2, ['raramente']],
    [3, ['às vezes', 'as vezes', 'ocasionalmente']],
  ],
};

export function parseLikert(textoFalado, tipo) {
  const t = normalizar(textoFalado);
  if (!t) return null;
  const regras = CHAVES[tipo];
  if (!regras) return null;
  for (const [valor, frases] of regras) {
    if (frases.some((f) => t.includes(f))) return valor;
  }
  // fallback: número falado de 1 a 5
  const matchDigito = t.match(/\b[1-5]\b/);
  if (matchDigito) return parseInt(matchDigito[0], 10);
  return null;
}

export function parseResposta(textoFalado, tipoPergunta) {
  if (tipoPergunta === 'nota10') return parseNota10(textoFalado);
  if (['concordancia', 'satisfacao', 'frequencia'].includes(tipoPergunta)) {
    return parseLikert(textoFalado, tipoPergunta);
  }
  return null;
}

export function reconhecimentoDisponivel() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Captura o microfone com ganho extra + compressor (deixa voz baixa mais alta) e mede o nível.
// Devolve { track, parar } ou null se o navegador negar/não tiver microfone.
async function iniciarReforco(onNivel) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const origem = ctx.createMediaStreamSource(stream);
    const ganho = ctx.createGain();
    ganho.gain.value = 4;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -50;
    compressor.knee.value = 40;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.25;
    const destino = ctx.createMediaStreamDestination();
    const analisador = ctx.createAnalyser();
    analisador.fftSize = 1024;
    origem.connect(ganho);
    ganho.connect(compressor);
    compressor.connect(destino);
    compressor.connect(analisador);

    const buf = new Uint8Array(analisador.fftSize);
    const inicio = Date.now();
    let picos = [];
    const timer = setInterval(() => {
      analisador.getByteTimeDomainData(buf);
      let soma = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; soma += v * v; }
      const nivel = Math.min(1, Math.sqrt(soma / buf.length) * 6);
      const agora = Date.now();
      picos.push({ t: agora, nivel });
      picos = picos.filter((p) => agora - p.t < 3000);
      const maximo = Math.max(...picos.map((p) => p.nivel));
      const baixo = agora - inicio > 4000 && maximo < 0.15;
      onNivel && onNivel({ nivel, baixo });
    }, 120);

    return {
      track: destino.stream.getAudioTracks()[0],
      parar() {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
      },
    };
  } catch (e) {
    return null;
  }
}

// SpeechRecognition contínuo em pt-BR que reinicia sozinho nas pausas (cliente que fala baixo/devagar)
// e, com `reforco`, alimenta o reconhecimento com áudio amplificado quando o navegador suporta.
export function criarReconhecedor({ onTranscricao, onErro, onFim, onNivel, reforco = false }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  let rec = null;
  let transcricaoFinal = '';
  let ultimoInterim = '';
  let querOuvir = false;
  let reforcoAtivo = null;
  let inicioRec = 0;
  let falhasRapidas = 0;

  function emitir() {
    onTranscricao && onTranscricao({
      final: transcricaoFinal,
      interim: ultimoInterim,
      completo: (transcricaoFinal + ' ' + ultimoInterim).trim(),
    });
  }

  function encerrar() {
    if (reforcoAtivo) { reforcoAtivo.parar(); reforcoAtivo = null; }
    onFim && onFim(transcricaoFinal);
  }

  function iniciarRec() {
    rec = new SR();
    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event) => {
      falhasRapidas = 0;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const resultado = event.results[i];
        if (resultado.isFinal) {
          const novo = resultado[0].transcript.trim();
          if (!novo || transcricaoFinal.endsWith(novo)) continue;
          transcricaoFinal = novo.startsWith(transcricaoFinal) ? novo : (transcricaoFinal + ' ' + novo).trim();
        } else {
          interim += resultado[0].transcript;
        }
      }
      ultimoInterim = interim;
      emitir();
    };

    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted' || event.error === 'network') return;
      querOuvir = false;
      onErro && onErro(event.error);
    };

    rec.onend = () => {
      if (ultimoInterim) {
        transcricaoFinal += (transcricaoFinal ? ' ' : '') + ultimoInterim.trim();
        ultimoInterim = '';
        emitir();
      }
      if (querOuvir) {
        if (Date.now() - inicioRec < 500) falhasRapidas++;
        if (falhasRapidas >= 5) { querOuvir = false; onErro && onErro('falha-audio'); encerrar(); return; }
        setTimeout(() => { if (querOuvir) iniciarRec(); else encerrar(); }, 0);
        return;
      }
      encerrar();
    };

    inicioRec = Date.now();
    const track = reforcoAtivo && reforcoAtivo.track;
    try {
      if (track) rec.start(track); else rec.start();
    } catch (e) {
      try { rec.start(); } catch (e2) { /* já iniciado */ }
    }
  }

  return {
    async start() {
      transcricaoFinal = '';
      ultimoInterim = '';
      falhasRapidas = 0;
      querOuvir = true;
      const usarReforco = typeof reforco === 'function' ? reforco() : reforco;
      if (usarReforco) {
        const r = await iniciarReforco(onNivel);
        if (!querOuvir) { if (r) r.parar(); return; }
        reforcoAtivo = r;
      }
      iniciarRec();
    },
    stop() {
      querOuvir = false;
      if (rec) { try { rec.stop(); } catch (e) { /* já parado */ } } else { encerrar(); }
    },
    reset() {
      transcricaoFinal = '';
      ultimoInterim = '';
    },
  };
}

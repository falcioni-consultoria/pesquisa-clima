// Transcrição ao vivo de alta precisão (Deepgram, modelo nova-3, pt-BR) + gravação do áudio inteiro.
// Não corta a fala em pausas: o áudio segue em fluxo contínuo até o consultor parar.

export function chaveDeepgram() {
  try { return localStorage.getItem('falclima_deepgram_key') || ''; } catch (e) { return ''; }
}

export function salvarChaveDeepgram(chave) {
  try {
    if (chave) localStorage.setItem('falclima_deepgram_key', chave); else localStorage.removeItem('falclima_deepgram_key');
  } catch (e) { /* sem storage */ }
}

export function criarPrecisoDeepgram() {
  let ws = null;
  let stream = null;
  let ctx = null;
  let recorder = null;
  let timer = null;
  let ativo = false;
  let finais = '';
  let parcial = '';
  let fila = [];
  let chunks = [];
  let opts = {};
  let aberto = false;
  let resolverFim = null;

  function emitir() {
    opts.onTranscricao && opts.onTranscricao({
      final: finais,
      interim: parcial,
      completo: (finais + ' ' + parcial).trim(),
    });
  }

  function liberar() {
    clearInterval(timer);
    timer = null;
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (e) { /* já parado */ } }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  }

  function concluir() {
    if (!ativo && !resolverFim) return;
    ativo = false;
    liberar();
    if (parcial) { finais = (finais + ' ' + parcial).trim(); parcial = ''; emitir(); }
    const audio = chunks.length ? new Blob(chunks, { type: 'audio/webm' }) : null;
    opts.onFim && opts.onFim(finais, audio);
    if (resolverFim) { resolverFim(); resolverFim = null; }
  }

  return {
    get ativo() { return ativo; },

    async start(o) {
      opts = o || {};
      const chave = chaveDeepgram();
      if (!chave) { opts.onErro && opts.onErro('sem-chave'); return; }
      finais = ''; parcial = ''; fila = []; chunks = []; aberto = false;
      ativo = true;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
      } catch (e) {
        ativo = false;
        opts.onErro && opts.onErro('not-allowed');
        return;
      }
      if (!ativo) { liberar(); return; }

      // ganho + compressor: deixa voz baixa mais forte antes de enviar
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const origem = ctx.createMediaStreamSource(stream);
      const ganho = ctx.createGain();
      ganho.gain.value = 3;
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
      timer = setInterval(() => {
        analisador.getByteTimeDomainData(buf);
        let soma = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; soma += v * v; }
        const nivel = Math.min(1, Math.sqrt(soma / buf.length) * 6);
        const agora = Date.now();
        picos.push({ t: agora, nivel });
        picos = picos.filter((p) => agora - p.t < 3000);
        const baixo = agora - inicio > 4000 && Math.max(...picos.map((p) => p.nivel)) < 0.15;
        opts.onNivel && opts.onNivel({ nivel, baixo });
      }, 120);

      const params = new URLSearchParams({
        model: 'nova-3', language: 'pt-BR', smart_format: 'true', punctuate: 'true', interim_results: 'true',
      });
      (opts.termos || []).forEach((t) => params.append('keyterm', t));

      ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', chave]);
      ws.onopen = () => {
        aberto = true;
        fila.forEach((c) => ws.send(c));
        fila = [];
        opts.onConectado && opts.onConectado();
      };
      ws.onmessage = (m) => {
        let d;
        try { d = JSON.parse(m.data); } catch (e) { return; }
        if (d.type !== 'Results') return;
        const t = ((d.channel && d.channel.alternatives && d.channel.alternatives[0] && d.channel.alternatives[0].transcript) || '').trim();
        if (d.is_final) {
          if (t) finais = (finais + ' ' + t).trim();
          parcial = '';
        } else {
          parcial = t;
        }
        emitir();
      };
      ws.onerror = () => { /* o motivo chega no onclose */ };
      ws.onclose = () => {
        if (ativo && !aberto) opts.onErro && opts.onErro('conexao');
        concluir();
      };

      let mime = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mime)) mime = '';
      recorder = new MediaRecorder(destino.stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => {
        if (!e.data.size) return;
        chunks.push(e.data);
        if (aberto && ws.readyState === 1) ws.send(e.data); else fila.push(e.data);
      };
      recorder.start(250);
    },

    // para de gravar e espera as últimas palavras chegarem (até ~2,5 s)
    stop() {
      if (!ativo) return Promise.resolve();
      return new Promise((resolve) => {
        resolverFim = resolve;
        try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) { /* já parado */ }
        setTimeout(() => {
          if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) { /* fechado */ } }
        }, 300);
        setTimeout(() => { try { if (ws) ws.close(); } catch (e) { /* fechado */ } concluir(); }, 2500);
      });
    },
  };
}

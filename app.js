import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, collection, doc, addDoc, updateDoc, onSnapshot,
  query, orderBy, serverTimestamp, getDoc, getDocs, increment, deleteDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { NIVEIS, TIPO_LABEL, montarModelo, novaPergunta, SEGMENTOS_PADRAO } from './questions.js';
import { parseResposta, reconhecimentoDisponivel, criarReconhecedor } from './voice.js';

const configPendente = firebaseConfig.apiKey === 'COLE_AQUI';
let db = null;
if (!configPendente) {
  const fbApp = initializeApp(firebaseConfig);
  db = getFirestore(fbApp);
}

// ---------- helpers de UI ----------
const $ = (id) => document.getElementById(id);
const telas = ['tela-config-aviso', 'tela-lista', 'tela-nova', 'tela-coleta', 'tela-relatorio'];

function mostrarTela(id) {
  telas.forEach((t) => $(t).classList.toggle('hidden', t !== id));
  $('btn-voltar').hidden = id === 'tela-lista' || id === 'tela-config-aviso';
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

function formatarData(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatarNumero(n, casas = 1) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toFixed(casas).replace('.', ',');
}

function atualizarLogoTopbar(logoUrl) {
  $('logo-placeholder').innerHTML = `<img src="${logoUrl || 'icons/falcioni-mark.png'}" alt="Logo">`;
}

function redimensionarImagem(file, maxLado = 300) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Falha ao ler arquivo'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Arquivo inválido'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxLado || height > maxLado) {
          const escala = maxLado / Math.max(width, height);
          width = Math.round(width * escala);
          height = Math.round(height * escala);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- router ----------
window.addEventListener('hashchange', rotear);
window.addEventListener('DOMContentLoaded', () => {
  if (configPendente) { mostrarTela('tela-config-aviso'); return; }
  rotear();
});

$('btn-voltar').addEventListener('click', () => {
  pararEscuta();
  location.hash = '#/';
});

function rotear() {
  if (configPendente) { mostrarTela('tela-config-aviso'); return; }
  const hash = location.hash.replace(/^#\/?/, '');
  const [rota, param] = hash.split('/');
  pararEscuta();
  modoGerenciar = false;
  $('btn-gerenciar').textContent = 'Gerenciar histórico';
  if (rota === 'nova') return telaNova();
  if (rota === 'coleta' && param) return telaColeta(param);
  if (rota === 'relatorio' && param) return telaRelatorio(param);
  return telaLista();
}

// ---------- tela: lista ----------
$('btn-nova-pesquisa').addEventListener('click', () => { location.hash = '#/nova'; });

async function telaLista() {
  $('topbar-title').textContent = 'Falclima';
  $('topbar-subtitle').textContent = 'Falcioni Consultoria';
  atualizarLogoTopbar(null);
  mostrarTela('tela-lista');
  const cont = $('lista-pesquisas');
  cont.innerHTML = '<p class="texto-vazio">Carregando...</p>';
  let snap;
  try {
    snap = await getDocs(query(collection(db, 'sessions'), orderBy('criadoEm', 'desc')));
  } catch (e) {
    cont.innerHTML = '';
    toast('Não foi possível carregar as pesquisas. Verifique a conexão ou a configuração do Firebase.');
    return;
  }
  cont.innerHTML = '';
  if (snap.empty) { $('lista-vazia').classList.remove('hidden'); return; }
  $('lista-vazia').classList.add('hidden');
  snap.forEach((docSnap) => {
    const s = docSnap.data();
    const item = document.createElement('div');
    item.className = 'pesquisa-item';
    item.innerHTML = `
      <div class="pesquisa-item-info">
        <div class="pesquisa-item-nome">${escapeHtml(s.clienteNome || 'Sem nome')}</div>
        <div class="pesquisa-item-meta">${formatarData(s.criadoEm)} · ${(s.perguntas || []).length} perguntas</div>
      </div>
      <span class="badge-status ${s.status === 'aberta' ? 'badge-aberta' : 'badge-encerrada'}">${s.status === 'aberta' ? 'Em coleta' : 'Encerrada'}</span>
      ${modoGerenciar ? '<button type="button" class="btn-apagar">Apagar</button>' : ''}
    `;
    item.addEventListener('click', () => {
      if (modoGerenciar) return;
      location.hash = s.status === 'aberta' ? `#/coleta/${docSnap.id}` : `#/relatorio/${docSnap.id}`;
    });
    item.querySelector('.btn-apagar')?.addEventListener('click', (e) => {
      e.stopPropagation();
      apagarPesquisa(docSnap.id, s.clienteNome || 'Sem nome');
    });
    cont.appendChild(item);
  });
}

let modoGerenciar = false;

$('btn-gerenciar').addEventListener('click', () => {
  modoGerenciar = !modoGerenciar;
  $('btn-gerenciar').textContent = modoGerenciar ? 'Concluir' : 'Gerenciar histórico';
  telaLista();
});

async function apagarPesquisa(id, nome) {
  if (!confirm(`Apagar a pesquisa "${nome}" e todas as respostas dela?\n\nNão dá para desfazer.`)) return;
  try {
    const resp = await getDocs(collection(db, 'sessions', id, 'respondentes'));
    await Promise.all(resp.docs.map((d) => deleteDoc(d.ref)));
    await deleteDoc(doc(db, 'sessions', id));
    toast('Pesquisa apagada.');
  } catch (e) {
    toast('Não foi possível apagar. Verifique a conexão e tente de novo.');
  }
  telaLista();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- tela: nova pesquisa ----------
let perguntasEdit = [];
let logoDataUrl = null;

function telaNova() {
  $('topbar-title').textContent = 'Nova pesquisa';
  $('topbar-subtitle').textContent = 'Falcioni Consultoria';
  atualizarLogoTopbar(null);
  mostrarTela('tela-nova');
  $('input-cliente').value = '';
  $('input-segmentos').value = SEGMENTOS_PADRAO.join(', ');
  $('input-forms').value = '';
  logoDataUrl = null;
  $('logo-upload-preview').innerHTML = '🏢';
  $('btn-remover-logo').classList.add('hidden');
  perguntasEdit = montarModelo('nota10');
  document.querySelectorAll('.modelo-opcao').forEach((b) => b.classList.toggle('selecionada', b.dataset.modelo === 'nota10'));
  renderPerguntasEdit();
}

$('input-logo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    logoDataUrl = await redimensionarImagem(file, 300);
    $('logo-upload-preview').innerHTML = `<img src="${logoDataUrl}" alt="Logo">`;
    $('btn-remover-logo').classList.remove('hidden');
  } catch (err) {
    toast('Não foi possível carregar essa imagem.');
  }
});

$('btn-remover-logo').addEventListener('click', () => {
  logoDataUrl = null;
  $('logo-upload-preview').innerHTML = '🏢';
  $('btn-remover-logo').classList.add('hidden');
});

document.querySelectorAll('.modelo-opcao').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modelo-opcao').forEach((b) => b.classList.remove('selecionada'));
    btn.classList.add('selecionada');
    perguntasEdit = montarModelo(btn.dataset.modelo);
    renderPerguntasEdit();
  });
});

$('btn-add-pergunta').addEventListener('click', () => {
  perguntasEdit.push(novaPergunta('nota10'));
  renderPerguntasEdit();
});

function renderPerguntasEdit() {
  const cont = $('lista-perguntas-edit');
  cont.innerHTML = '';
  perguntasEdit.forEach((p, idx) => {
    const item = document.createElement('div');
    item.className = 'pergunta-edit-item';
    item.innerHTML = `
      <div class="pergunta-edit-topo">
        <div class="pergunta-edit-reorder">
          <button type="button" data-acao="up" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-acao="down" ${idx === perguntasEdit.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
        <select data-acao="tipo">
          ${Object.entries(TIPO_LABEL).map(([v, l]) => `<option value="${v}" ${p.tipo === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button type="button" class="pergunta-edit-remover" data-acao="remover" title="Remover">✕</button>
      </div>
      <textarea rows="2" data-acao="texto" placeholder="Digite a pergunta...">${escapeHtml(p.texto)}</textarea>
    `;
    item.querySelector('[data-acao="texto"]').addEventListener('input', (e) => { p.texto = e.target.value; });
    item.querySelector('[data-acao="tipo"]').addEventListener('change', (e) => { p.tipo = e.target.value; });
    item.querySelector('[data-acao="remover"]').addEventListener('click', () => {
      perguntasEdit.splice(idx, 1); renderPerguntasEdit();
    });
    item.querySelector('[data-acao="up"]')?.addEventListener('click', () => {
      [perguntasEdit[idx - 1], perguntasEdit[idx]] = [perguntasEdit[idx], perguntasEdit[idx - 1]];
      renderPerguntasEdit();
    });
    item.querySelector('[data-acao="down"]')?.addEventListener('click', () => {
      [perguntasEdit[idx + 1], perguntasEdit[idx]] = [perguntasEdit[idx], perguntasEdit[idx + 1]];
      renderPerguntasEdit();
    });
    cont.appendChild(item);
  });
}

$('btn-criar-pesquisa').addEventListener('click', async () => {
  const clienteNome = $('input-cliente').value.trim();
  if (!clienteNome) { toast('Informe o nome do cliente.'); return; }
  const perguntasValidas = perguntasEdit.filter((p) => p.texto.trim());
  if (!perguntasValidas.length) { toast('Adicione ao menos uma pergunta.'); return; }
  const segmentos = $('input-segmentos').value.split(',').map((s) => s.trim()).filter(Boolean);
  const formsUrl = $('input-forms').value.trim();

  const btn = $('btn-criar-pesquisa');
  btn.disabled = true; btn.textContent = 'Criando...';
  try {
    const ref = await addDoc(collection(db, 'sessions'), {
      clienteNome,
      status: 'aberta',
      perguntas: perguntasValidas,
      segmentos,
      logo: logoDataUrl || null,
      formsUrl: formsUrl || null,
      proximoSeq: 1,
      criadoEm: serverTimestamp(),
    });
    location.hash = `#/coleta/${ref.id}`;
  } catch (e) {
    toast('Erro ao criar pesquisa: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Criar pesquisa e começar a coletar';
  }
});

// ---------- tela: coleta ----------
const coleta = {
  sessionId: null,
  session: null,
  respondenteRef: null,
  seq: 1,
  segmento: null,
  indicePergunta: 0,
  reconhecedor: null,
  ouvindo: false,
  valorAtual: null,
  respostasCache: {},
};

async function telaColeta(sessionId) {
  mostrarTela('tela-coleta');
  const sessRef = doc(db, 'sessions', sessionId);
  let snap;
  try {
    snap = await getDoc(sessRef);
  } catch (e) {
    toast('Sem conexão com o Firebase. Verifique a internet e tente novamente.');
    location.hash = '#/'; return;
  }
  if (!snap.exists()) { toast('Pesquisa não encontrada.'); location.hash = '#/'; return; }
  coleta.sessionId = sessionId;
  coleta.session = snap.data();
  $('topbar-title').textContent = coleta.session.clienteNome;
  $('topbar-subtitle').textContent = 'Coletando respostas';
  atualizarLogoTopbar(coleta.session.logo);
  coleta.seq = coleta.session.proximoSeq || 1;
  iniciarNovoRespondente();
}

$('btn-encerrar-pesquisa').addEventListener('click', async () => {
  if (!confirm('Encerrar esta pesquisa? Você ainda poderá ver o relatório depois.')) return;
  try {
    await updateDoc(doc(db, 'sessions', coleta.sessionId), { status: 'encerrada', encerradoEm: serverTimestamp() });
  } catch (e) {
    toast('Sem conexão — tente encerrar novamente em instantes.');
    return;
  }
  location.hash = `#/relatorio/${coleta.sessionId}`;
});

async function iniciarNovoRespondente() {
  pararEscuta();
  coleta.indicePergunta = 0;
  coleta.segmento = null;
  coleta.respostasCache = {};
  $('coleta-respondente-label').textContent = `Respondente ${coleta.seq}`;
  const segmentos = coleta.session.segmentos || [];

  let ref;
  try {
    ref = await addDoc(collection(db, 'sessions', coleta.sessionId, 'respondentes'), {
      seq: coleta.seq,
      segmento: null,
      respostas: {},
      abertas: {},
      criadoEm: serverTimestamp(),
      finalizadoEm: null,
    });
    await updateDoc(doc(db, 'sessions', coleta.sessionId), { proximoSeq: increment(1) });
  } catch (e) {
    toast('Sem conexão com o Firebase. Verifique a internet e toque para tentar novamente.');
    $('bloco-pergunta').classList.add('hidden');
    $('bloco-segmento').classList.add('hidden');
    return;
  }
  coleta.respondenteRef = ref;
  coleta.session.proximoSeq = coleta.seq + 1;

  if (segmentos.length) {
    mostrarBlocoSegmento(segmentos);
  } else {
    mostrarPergunta();
  }
}

function mostrarBlocoSegmento(segmentos) {
  $('bloco-pergunta').classList.add('hidden');
  $('bloco-segmento').classList.remove('hidden');
  const cont = $('chips-segmento');
  cont.innerHTML = '';
  segmentos.forEach((seg) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = seg;
    chip.addEventListener('click', async () => {
      coleta.segmento = seg;
      try { await updateDoc(coleta.respondenteRef, { segmento: seg }); } catch (e) { /* segue mesmo assim, tenta de novo nas próximas respostas */ }
      mostrarPergunta();
    });
    cont.appendChild(chip);
  });
}

$('btn-pular-segmento').addEventListener('click', () => mostrarPergunta());

function mostrarPergunta() {
  pararEscuta();
  $('bloco-segmento').classList.add('hidden');
  $('bloco-pergunta').classList.remove('hidden');
  const perguntas = coleta.session.perguntas;
  const p = perguntas[coleta.indicePergunta];
  coleta.valorAtual = null;

  $('pergunta-indice').textContent = `Pergunta ${coleta.indicePergunta + 1} de ${perguntas.length}`;
  $('pergunta-tipo-badge').textContent = TIPO_LABEL[p.tipo];
  $('pergunta-texto').textContent = p.texto;
  $('progresso-fill').style.width = `${Math.round((coleta.indicePergunta / perguntas.length) * 100)}%`;
  $('transcricao-texto').value = '';
  $('btn-anterior-pergunta').disabled = coleta.indicePergunta === 0;

  $('resposta-nota10').classList.add('hidden');
  $('resposta-likert').classList.add('hidden');
  $('resposta-aberta-aviso').classList.add('hidden');

  if (p.tipo === 'nota10') {
    renderRespostaNota10();
  } else if (p.tipo === 'aberta') {
    $('resposta-aberta-aviso').classList.remove('hidden');
  } else {
    renderRespostaLikert(p.tipo);
  }

  const cache = coleta.respostasCache[p.id];
  if (cache) {
    $('transcricao-texto').value = cache.texto || '';
    if (p.tipo !== 'aberta' && cache.valor !== undefined) selecionarValor(cache.valor);
  }

  $('voz-nao-suportada').classList.toggle('hidden', reconhecimentoDisponivel());
  $('btn-mic').disabled = !reconhecimentoDisponivel();
  $('mic-status').textContent = 'Toque no microfone e deixe o cliente responder';
}

function voltarPergunta() {
  if (coleta.indicePergunta <= 0) return;
  pararEscuta();
  coleta.indicePergunta--;
  mostrarPergunta();
}

$('btn-anterior-pergunta').addEventListener('click', voltarPergunta);

function renderRespostaNota10() {
  const cont = $('resposta-nota10');
  cont.classList.remove('hidden');
  cont.innerHTML = '';
  for (let n = 0; n <= 10; n++) {
    const b = document.createElement('button');
    b.className = 'nota-btn';
    b.textContent = n;
    b.addEventListener('click', () => selecionarValor(n));
    cont.appendChild(b);
  }
}

function renderRespostaLikert(tipo) {
  const cont = $('resposta-likert');
  cont.classList.remove('hidden');
  cont.innerHTML = '';
  NIVEIS[tipo].forEach((label, idx) => {
    const valor = idx + 1;
    const b = document.createElement('button');
    b.className = 'likert-btn';
    b.textContent = label;
    b.addEventListener('click', () => selecionarValor(valor));
    cont.appendChild(b);
  });
}

function selecionarValor(valor) {
  coleta.valorAtual = valor;
  document.querySelectorAll('#resposta-nota10 .nota-btn').forEach((b, i) => b.classList.toggle('selecionado', i === valor));
  document.querySelectorAll('#resposta-likert .likert-btn').forEach((b, i) => b.classList.toggle('selecionado', i === valor - 1));
}

// microfone
function pararEscuta() {
  const estavaOuvindo = coleta.ouvindo;
  if (coleta.reconhecedor && coleta.ouvindo) coleta.reconhecedor.stop();
  coleta.ouvindo = false;
  $('btn-mic')?.classList.remove('ouvindo');
  $('mic-nivel')?.classList.add('hidden');
  if (estavaOuvindo) $('mic-status').textContent = 'Toque no microfone para continuar a gravar';
}

function lerReforcoVoz() {
  try {
    const v = localStorage.getItem('falclima_reforco');
    if (v !== null) return v === '1';
  } catch (e) { /* sem storage */ }
  return !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}
let reforcoVoz = lerReforcoVoz();

function atualizarBotaoReforco() {
  $('btn-reforco').textContent = `🔊 Reforço de voz baixa: ${reforcoVoz ? 'ligado' : 'desligado'}`;
}
atualizarBotaoReforco();

$('btn-reforco').addEventListener('click', () => {
  reforcoVoz = !reforcoVoz;
  try { localStorage.setItem('falclima_reforco', reforcoVoz ? '1' : '0'); } catch (e) { /* sem storage */ }
  atualizarBotaoReforco();
  toast(reforcoVoz ? 'Reforço ligado — vale a partir da próxima gravação.' : 'Reforço desligado.');
});

$('btn-mic').addEventListener('click', () => {
  if (!reconhecimentoDisponivel()) return;
  if (coleta.ouvindo) { pararEscuta(); return; }

  if (!coleta.reconhecedor) {
    coleta.reconhecedor = criarReconhecedor({
      reforco: () => reforcoVoz,
      onTranscricao: ({ completo }) => {
        const base = coleta.textoBase;
        $('transcricao-texto').value = base ? `${base} ${completo}` : completo;
        const p = coleta.session.perguntas[coleta.indicePergunta];
        if (p && p.tipo !== 'aberta') {
          const valor = parseResposta(completo, p.tipo);
          if (valor !== null) selecionarValor(valor);
        }
      },
      onNivel: ({ nivel, baixo }) => {
        if (!coleta.ouvindo) return;
        $('mic-nivel').classList.remove('hidden');
        $('mic-nivel-barra').style.width = `${Math.round(nivel * 100)}%`;
        $('mic-nivel-barra').classList.toggle('baixo', baixo);
        $('mic-status').textContent = baixo ? 'Voz baixa — aproxime o microfone do cliente' : 'Ouvindo... toque novamente para parar';
      },
      onErro: (err) => {
        pararEscuta();
        $('mic-status').textContent = err === 'not-allowed' || err === 'service-not-allowed'
          ? 'Microfone bloqueado — libere o acesso ao microfone no navegador.'
          : `Erro no microfone (${err})`;
      },
      onFim: () => { pararEscuta(); },
    });
  }
  coleta.textoBase = $('transcricao-texto').value.trim();
  coleta.reconhecedor.start();
  coleta.ouvindo = true;
  $('btn-mic').classList.add('ouvindo');
  $('mic-status').textContent = 'Ouvindo... toque novamente para parar';
});

$('btn-pular-pergunta').addEventListener('click', () => avancarPergunta(true));
$('btn-confirmar-pergunta').addEventListener('click', () => avancarPergunta(false));

async function avancarPergunta(pular) {
  pararEscuta();
  const perguntas = coleta.session.perguntas;
  const p = perguntas[coleta.indicePergunta];
  const texto = $('transcricao-texto').value.trim();

  try {
    if (!pular) {
      if (p.tipo === 'aberta') {
        if (texto) {
          await updateDoc(coleta.respondenteRef, { [`abertas.${p.id}`]: texto });
          coleta.respostasCache[p.id] = { texto };
        }
      } else if (coleta.valorAtual !== null) {
        await updateDoc(coleta.respondenteRef, { [`respostas.${p.id}`]: { valor: coleta.valorAtual, texto } });
        coleta.respostasCache[p.id] = { valor: coleta.valorAtual, texto };
      }
    }
  } catch (e) {
    toast('Sem conexão — a resposta não foi salva. Tente confirmar novamente.');
    return;
  }

  coleta.indicePergunta++;
  if (coleta.indicePergunta >= perguntas.length) {
    try {
      await updateDoc(coleta.respondenteRef, { finalizadoEm: serverTimestamp() });
    } catch (e) {
      toast('Sem conexão ao finalizar — tente novamente em instantes.');
      coleta.indicePergunta--;
      return;
    }
    toast(`Respondente ${coleta.seq} salvo. Iniciando o próximo.`);
    coleta.seq++;
    iniciarNovoRespondente();
  } else {
    mostrarPergunta();
  }
}

// ---------- tela: relatório ----------
let relatorioUnsub = null;
let relatorioSession = null;
let relatorioRespondentes = [];

async function telaRelatorio(sessionId) {
  mostrarTela('tela-relatorio');
  if (relatorioUnsub) { relatorioUnsub(); relatorioUnsub = null; }

  const sessRef = doc(db, 'sessions', sessionId);
  let snap;
  try {
    snap = await getDoc(sessRef);
  } catch (e) {
    toast('Sem conexão com o Firebase. Verifique a internet e tente novamente.');
    location.hash = '#/'; return;
  }
  if (!snap.exists()) { toast('Pesquisa não encontrada.'); location.hash = '#/'; return; }
  relatorioSession = snap.data();
  $('topbar-title').textContent = relatorioSession.clienteNome;
  $('topbar-subtitle').textContent = 'Relatório em tempo real';
  $('relatorio-titulo').textContent = `Relatório — ${relatorioSession.clienteNome}`;
  atualizarLogoTopbar(relatorioSession.logo);
  const linkForms = $('link-forms');
  if (relatorioSession.formsUrl) {
    linkForms.href = relatorioSession.formsUrl;
    linkForms.classList.remove('hidden');
  } else {
    linkForms.classList.add('hidden');
  }

  const selFiltro = $('filtro-segmento');
  selFiltro.innerHTML = '<option value="">Todos</option>' +
    (relatorioSession.segmentos || []).map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  selFiltro.onchange = renderRelatorio;

  const q = query(collection(db, 'sessions', sessionId, 'respondentes'), orderBy('seq'));
  relatorioUnsub = onSnapshot(q, (qs) => {
    relatorioRespondentes = [];
    qs.forEach((d) => relatorioRespondentes.push(d.data()));
    renderRelatorio();
  });
}

$('btn-imprimir').addEventListener('click', () => window.print());

function carregarPptxGenJS() {
  return new Promise((resolve, reject) => {
    if (window.PptxGenJS) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('não foi possível carregar a biblioteca de PPT (verifique a internet)'));
    document.head.appendChild(s);
  });
}

$('btn-baixar-ppt').addEventListener('click', gerarPPT);

async function gerarPPT() {
  if (!relatorioSession) { toast('Aguarde o relatório carregar.'); return; }
  const btn = $('btn-baixar-ppt');
  const textoOriginal = btn.textContent;
  btn.disabled = true; btn.textContent = 'Gerando...';
  try {
    await carregarPptxGenJS();

    const NAVY = '1B3260';
    const GREEN = '2D8B5E';
    const GRAY = '6B7686';

    const filtro = $('filtro-segmento').value;
    const respondentes = filtro ? relatorioRespondentes.filter((r) => r.segmento === filtro) : relatorioRespondentes;

    const pptx = new window.PptxGenJS();
    pptx.defineLayout({ name: 'FALCLIMA', width: 10, height: 5.63 });
    pptx.layout = 'FALCLIMA';

    const capa = pptx.addSlide();
    capa.background = { color: NAVY };
    capa.addText(relatorioSession.clienteNome || 'Cliente', { x: 0.5, y: 2.0, w: 8.2, h: 1, fontSize: 32, bold: true, color: 'FFFFFF', fontFace: 'Arial' });
    capa.addText('Pesquisa de Clima Organizacional', { x: 0.5, y: 2.8, w: 8.2, h: 0.5, fontSize: 16, color: 'FFFFFF', fontFace: 'Arial' });
    capa.addText(`${respondentes.length} respondente(s) · ${new Date().toLocaleDateString('pt-BR')}${filtro ? ' · ' + filtro : ''}`, { x: 0.5, y: 3.3, w: 8.2, h: 0.4, fontSize: 12, color: 'CBD5E1', fontFace: 'Arial' });
    capa.addText('Falclima — Falcioni Consultoria', { x: 0.85, y: 5.08, w: 8.2, h: 0.3, fontSize: 10, color: '8FA3C8', fontFace: 'Arial' });
    try { capa.addImage({ path: 'icons/falcioni-mark.png', x: 0.5, y: 5.02, w: 0.3, h: 0.3 }); } catch (e) { /* ignora se não carregar */ }
    if (relatorioSession.logo) {
      try { capa.addImage({ data: relatorioSession.logo, x: 8.3, y: 0.4, w: 1.2, h: 1.2 }); } catch (e) { /* ignora logo inválida */ }
    }

    (relatorioSession.perguntas || []).forEach((p) => {
      const s = pptx.addSlide();
      s.background = { color: 'FFFFFF' };
      s.addText(p.texto, { x: 0.5, y: 0.35, w: 9, h: 0.9, fontSize: 18, bold: true, color: NAVY, fontFace: 'Arial' });

      if (p.tipo === 'aberta') {
        const comentariosAbertas = respondentes
          .map((r) => ({ r, texto: r.abertas && r.abertas[p.id] }))
          .filter((x) => x.texto)
          .slice(0, 14);
        if (!comentariosAbertas.length) {
          s.addText('Sem respostas ainda.', { x: 0.5, y: 1.4, w: 9, h: 0.5, fontSize: 14, color: GRAY, italic: true, fontFace: 'Arial' });
        } else {
          const bullets = comentariosAbertas.map((x) => ({ text: x.texto, options: { bullet: true, color: '333333', breakLine: true } }));
          s.addText(bullets, { x: 0.5, y: 1.35, w: 9, h: 3.9, fontSize: 12, valign: 'top', fontFace: 'Arial' });
        }
        return;
      }

      const valores = respondentes.map((r) => r.respostas && r.respostas[p.id]).filter((v) => v && typeof v.valor === 'number');
      const media = valores.length ? valores.reduce((a, v) => a + v.valor, 0) / valores.length : null;
      const max = p.tipo === 'nota10' ? 10 : 5;
      const escalaLabel = p.tipo === 'nota10' ? '0 a 10' : '1 a 5';

      s.addText(media === null ? '—' : formatarNumero(media), { x: 0.5, y: 1.3, w: 2.6, h: 1.1, fontSize: 44, bold: true, color: GREEN, fontFace: 'Arial' });
      s.addText(`média de ${valores.length} resposta(s)\nescala ${escalaLabel}`, { x: 0.5, y: 2.35, w: 2.6, h: 0.7, fontSize: 11, color: GRAY, fontFace: 'Arial' });

      const comentarios = respondentes
        .map((r) => ({ r, resp: r.respostas && r.respostas[p.id] }))
        .filter((x) => x.resp && x.resp.texto)
        .slice(0, 8);
      if (comentarios.length) {
        const bullets = comentarios.map((c) => ({ text: `"${c.resp.texto}"`, options: { bullet: true, color: '333333', breakLine: true } }));
        s.addText(bullets, { x: 3.3, y: 1.3, w: 6.2, h: 3.9, fontSize: 11, valign: 'top', fontFace: 'Arial' });
      }
    });

    const nomeArquivo = `Relatorio-${(relatorioSession.clienteNome || 'clima').replace(/[^a-zA-Z0-9]+/g, '-')}.pptx`;
    await pptx.writeFile({ fileName: nomeArquivo });
  } catch (e) {
    toast('Erro ao gerar PPT: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = textoOriginal;
  }
}

function renderRelatorio() {
  const filtro = $('filtro-segmento').value;
  const respondentes = filtro ? relatorioRespondentes.filter((r) => r.segmento === filtro) : relatorioRespondentes;
  $('resumo-total-respondentes').textContent = respondentes.length;

  const cont = $('relatorio-perguntas');
  cont.innerHTML = '';

  (relatorioSession.perguntas || []).forEach((p) => {
    const card = document.createElement('div');
    card.className = 'card pergunta-relatorio-card';

    if (p.tipo === 'aberta') {
      const textos = respondentes
        .map((r) => r.abertas && r.abertas[p.id])
        .filter(Boolean);
      card.innerHTML = `
        <div class="pergunta-relatorio-topo">
          <div class="pergunta-relatorio-titulo">${escapeHtml(p.texto)}</div>
          <div class="pergunta-relatorio-media"><div class="media-numero">${textos.length}</div><div class="media-sub">respostas</div></div>
        </div>
      `;
      const lista = document.createElement('div');
      lista.className = 'comentarios-lista';
      if (!textos.length) {
        lista.innerHTML = '<div class="comentario-item">Ainda sem respostas.</div>';
      } else {
        respondentes.forEach((r) => {
          const t = r.abertas && r.abertas[p.id];
          if (!t) return;
          const item = document.createElement('div');
          item.className = 'comentario-item';
          item.innerHTML = `<div class="comentario-autor">Respondente ${r.seq}${r.segmento ? ' · ' + escapeHtml(r.segmento) : ''}</div>${escapeHtml(t)}`;
          lista.appendChild(item);
        });
      }
      card.appendChild(lista);
      cont.appendChild(card);
      return;
    }

    const valores = respondentes
      .map((r) => r.respostas && r.respostas[p.id])
      .filter((v) => v && typeof v.valor === 'number');
    const media = valores.length ? valores.reduce((a, v) => a + v.valor, 0) / valores.length : null;
    const max = p.tipo === 'nota10' ? 10 : 5;

    card.innerHTML = `
      <div class="pergunta-relatorio-topo">
        <div class="pergunta-relatorio-titulo">${escapeHtml(p.texto)}</div>
        <div class="pergunta-relatorio-media">
          <div class="media-numero">${media === null ? '—' : formatarNumero(media)}</div>
          <div class="media-sub">média (${valores.length}) de ${max}</div>
        </div>
      </div>
    `;

    // distribuição
    const contagem = {};
    const inicio = p.tipo === 'nota10' ? 0 : 1;
    for (let i = inicio; i <= max; i++) contagem[i] = 0;
    valores.forEach((v) => { contagem[v.valor] = (contagem[v.valor] || 0) + 1; });
    const maiorContagem = Math.max(1, ...Object.values(contagem));

    const distDiv = document.createElement('div');
    distDiv.className = 'dist-barras';
    for (let i = max; i >= inicio; i--) {
      const label = p.tipo === 'nota10' ? String(i) : NIVEIS[p.tipo][i - 1];
      const qtd = contagem[i] || 0;
      const linha = document.createElement('div');
      linha.className = 'dist-linha';
      linha.innerHTML = `
        <span class="dist-label">${escapeHtml(label)}</span>
        <span class="dist-barra-fundo"><span class="dist-barra-preench" style="width:${(qtd / maiorContagem) * 100}%"></span></span>
        <span class="dist-count">${qtd}</span>
      `;
      distDiv.appendChild(linha);
    }
    card.appendChild(distDiv);

    const comentarios = respondentes
      .map((r) => ({ r, resp: r.respostas && r.respostas[p.id] }))
      .filter((x) => x.resp && x.resp.texto);

    if (comentarios.length) {
      const toggle = document.createElement('button');
      toggle.className = 'comentarios-toggle';
      toggle.textContent = `Ver ${comentarios.length} comentário(s)`;
      const lista = document.createElement('div');
      lista.className = 'comentarios-lista hidden';
      comentarios.forEach(({ r, resp }) => {
        const item = document.createElement('div');
        item.className = 'comentario-item';
        item.innerHTML = `<div class="comentario-autor">Respondente ${r.seq}${r.segmento ? ' · ' + escapeHtml(r.segmento) : ''} — nota ${resp.valor}</div>${escapeHtml(resp.texto)}`;
        lista.appendChild(item);
      });
      toggle.addEventListener('click', () => {
        lista.classList.toggle('hidden');
        toggle.textContent = lista.classList.contains('hidden') ? `Ver ${comentarios.length} comentário(s)` : 'Ocultar comentários';
      });
      card.appendChild(toggle);
      card.appendChild(lista);
    }

    cont.appendChild(card);
  });
}

// PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

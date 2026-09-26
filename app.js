import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from './vendor/firebase-app.js';
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, onSnapshot, query, orderBy, serverTimestamp,
  getDoc, getDocs, deleteDoc, waitForPendingWrites,
} from './vendor/firebase-firestore.js';
import { NIVEIS, TIPO_LABEL, montarModelo, novaPergunta, SEGMENTOS_PADRAO } from './questions.js';
import { lerPlanilha, sugerirColuna, acharColuna, converterValor, idDaLinha } from './importar.js';
import { carregarCorretor, ativarAutocorrecao, autocorrecaoLigada, definirAutocorrecao, desfazerCorrecao } from './autocorrecao.js';

const configPendente = firebaseConfig.apiKey === 'COLE_AQUI';
let db = null;
if (!configPendente) {
  const fbApp = initializeApp(firebaseConfig);
  try {
    // guarda tudo no aparelho: funciona sem internet e envia sozinho quando a conexão voltar
    db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    db = getFirestore(fbApp);
  }
}

// ---------- helpers de UI ----------
const $ = (id) => document.getElementById(id);
const telas = ['tela-config-aviso', 'tela-lista', 'tela-nova', 'tela-coleta', 'tela-relatorio', 'tela-editar'];

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
  location.hash = '#/';
});

function rotear() {
  if (configPendente) { mostrarTela('tela-config-aviso'); return; }
  const hash = location.hash.replace(/^#\/?/, '');
  const [rota, param, param2] = hash.split('/');
  modoGerenciar = false;
  $('btn-gerenciar').textContent = 'Gerenciar histórico';
  if (rota === 'nova') return telaNova();
  if (rota === 'coleta' && param) return telaColeta(param);
  if (rota === 'relatorio' && param) return telaRelatorio(param);
  if (rota === 'editar' && param) return telaEditar(param, parseInt(param2, 10) || 0);
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
      apagarPesquisa(docSnap.id, s.clienteNome || 'Sem nome', item);
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

async function apagarPesquisa(id, nome, itemEl) {
  if (!confirm(`Apagar a pesquisa "${nome}" e todas as respostas dela?\n\nNão dá para desfazer.`)) return;
  try {
    const resp = await getDocs(collection(db, 'sessions', id, 'respondentes'));
    resp.docs.forEach((d) => deleteDoc(d.ref).catch(falhaGravar));
    deleteDoc(doc(db, 'sessions', id)).catch(falhaGravar);
    itemEl.remove();
    if (!$('lista-pesquisas').children.length) $('lista-vazia').classList.remove('hidden');
    toast('Pesquisa apagada.');
  } catch (e) {
    toast('Não foi possível apagar agora. Tente de novo.');
  }
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
  const ref = doc(collection(db, 'sessions'));
  setDoc(ref, {
    clienteNome,
    status: 'aberta',
    perguntas: perguntasValidas,
    segmentos,
    logo: logoDataUrl || null,
    formsUrl: formsUrl || null,
    proximoSeq: 1,
    criadoEm: serverTimestamp(),
  }).catch(falhaGravar);
  btn.disabled = false; btn.textContent = 'Criar pesquisa e começar a coletar';
  location.hash = `#/coleta/${ref.id}`;
});

// ---------- tela: coleta ----------
const coleta = {
  sessionId: null,
  session: null,
  respondenteRef: null,
  respondenteCriado: false,
  seq: 1,
  segmento: null,
  nome: '',
  indicePergunta: 0,
  valorAtual: null,
  respostasCache: {},
};

function falhaGravar(e) {
  toast('Não foi possível salvar: ' + ((e && e.message) || e));
}

function lerLocal(chave) {
  try { return JSON.parse(localStorage.getItem(chave) || 'null'); } catch (e) { return null; }
}

function gravarLocal(chave, valor) {
  try {
    if (valor === null) localStorage.removeItem(chave); else localStorage.setItem(chave, JSON.stringify(valor));
  } catch (e) { /* sem storage */ }
}

// rascunho da pergunta atual (nota + texto ainda não confirmados): sobrevive a queda de energia
function salvarRascunho() {
  if (!coleta.session) return;
  gravarLocal('falclima_rascunho', {
    sessionId: coleta.sessionId, seq: coleta.seq, indice: coleta.indicePergunta,
    valor: coleta.valorAtual, texto: $('transcricao-texto').value,
  });
}

function limparRascunho() { gravarLocal('falclima_rascunho', null); }

async function telaColeta(sessionId) {
  mostrarTela('tela-coleta');
  let snap;
  try {
    snap = await getDoc(doc(db, 'sessions', sessionId));
  } catch (e) {
    toast('Esta pesquisa ainda não está guardada neste aparelho. Abra-a uma vez com internet.');
    location.hash = '#/'; return;
  }
  if (!snap.exists()) { toast('Pesquisa não encontrada.'); location.hash = '#/'; return; }
  coleta.sessionId = sessionId;
  coleta.session = snap.data();
  $('topbar-title').textContent = coleta.session.clienteNome;
  $('topbar-subtitle').textContent = 'Coletando respostas';
  atualizarLogoTopbar(coleta.session.logo);
  coleta.seq = coleta.session.proximoSeq || 1;
  const retomou = await tentarRetomar();
  if (!retomou) iniciarNovoRespondente();
}

// depois de queda de energia/fechamento: volta no respondente que estava em andamento
async function tentarRetomar() {
  const m = lerLocal('falclima_em_andamento');
  if (!m || m.sessionId !== coleta.sessionId) return false;
  const ref = doc(db, 'sessions', coleta.sessionId, 'respondentes', m.id);
  let snap;
  try { snap = await getDoc(ref); } catch (e) { return false; }
  if (!snap.exists() || snap.data().finalizadoEm) { gravarLocal('falclima_em_andamento', null); return false; }
  const d = snap.data();
  const perguntas = coleta.session.perguntas;
  coleta.respondenteRef = ref;
  coleta.respondenteCriado = true;
  coleta.seq = d.seq;
  coleta.segmento = d.segmento || null;
  coleta.nome = d.nome || '';
  $('input-nome-respondente').value = coleta.nome;
  coleta.respostasCache = {};
  perguntas.forEach((p) => {
    const r = (d.respostas || {})[p.id];
    if (r && typeof r.valor === 'number') coleta.respostasCache[p.id] = { valor: r.valor, texto: r.texto || '' };
    else if ((d.abertas || {})[p.id]) coleta.respostasCache[p.id] = { texto: d.abertas[p.id] };
  });
  let i = perguntas.findIndex((p) => !coleta.respostasCache[p.id]);
  if (i < 0) i = perguntas.length - 1;
  coleta.indicePergunta = i;
  $('coleta-respondente-label').textContent = `Respondente ${coleta.seq}`;
  toast(`Retomando o Respondente ${coleta.seq} de onde parou.`);
  mostrarPergunta();
  return true;
}

$('btn-encerrar-pesquisa').addEventListener('click', () => {
  if (!confirm('Encerrar esta pesquisa? Você ainda poderá ver o relatório depois.')) return;
  updateDoc(doc(db, 'sessions', coleta.sessionId), { status: 'encerrada', encerradoEm: serverTimestamp() }).catch(falhaGravar);
  location.hash = `#/relatorio/${coleta.sessionId}`;
});

$('btn-ver-respondidos').addEventListener('click', () => {
  if (coleta.sessionId) location.hash = `#/editar/${coleta.sessionId}`;
});

function iniciarNovoRespondente() {
  coleta.indicePergunta = 0;
  coleta.segmento = null;
  coleta.nome = '';
  $('input-nome-respondente').value = '';
  coleta.respostasCache = {};
  coleta.respondenteCriado = false;
  coleta.respondenteRef = doc(collection(db, 'sessions', coleta.sessionId, 'respondentes'));
  $('coleta-respondente-label').textContent = `Respondente ${coleta.seq}`;
  const segmentos = coleta.session.segmentos || [];
  if (segmentos.length) {
    mostrarBlocoSegmento(segmentos);
  } else {
    mostrarPergunta();
  }
}

// o respondente só é criado no banco quando existe a primeira resposta (evita registros vazios)
function gravarRespondente(dados) {
  if (!coleta.respondenteCriado) {
    coleta.respondenteCriado = true;
    setDoc(coleta.respondenteRef, {
      seq: coleta.seq,
      segmento: coleta.segmento || null,
      nome: coleta.nome || null,
      respostas: {},
      abertas: {},
      criadoEm: serverTimestamp(),
      finalizadoEm: null,
    }).catch(falhaGravar);
    updateDoc(doc(db, 'sessions', coleta.sessionId), { proximoSeq: coleta.seq + 1 }).catch(falhaGravar);
    coleta.session.proximoSeq = coleta.seq + 1;
    gravarLocal('falclima_em_andamento', { sessionId: coleta.sessionId, id: coleta.respondenteRef.id, seq: coleta.seq });
  }
  updateDoc(coleta.respondenteRef, dados).catch(falhaGravar);
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
    chip.addEventListener('click', () => {
      coleta.segmento = seg;
      if (coleta.respondenteCriado) gravarRespondente({ segmento: seg });
      mostrarPergunta();
    });
    cont.appendChild(chip);
  });
}

$('btn-pular-segmento').addEventListener('click', () => mostrarPergunta());

// o nome só é gravado junto com o respondente; digitar sem responder nada não cria registro vazio
$('input-nome-respondente').addEventListener('input', (e) => {
  coleta.nome = e.target.value;
  if (coleta.respondenteCriado) updateDoc(coleta.respondenteRef, { nome: coleta.nome.trim() || null }).catch(falhaGravar);
});


function mostrarPergunta() {
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
  } else {
    const rasc = lerLocal('falclima_rascunho');
    if (rasc && rasc.sessionId === coleta.sessionId && rasc.seq === coleta.seq && rasc.indice === coleta.indicePergunta) {
      $('transcricao-texto').value = rasc.texto || '';
      if (p.tipo !== 'aberta' && typeof rasc.valor === 'number') selecionarValor(rasc.valor);
    }
  }

  correcoesRecentes.length = 0;
  renderCorrecoes();
}

function voltarPergunta() {
  if (coleta.indicePergunta <= 0) return;
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
  salvarRascunho();
  document.querySelectorAll('#resposta-nota10 .nota-btn').forEach((b, i) => b.classList.toggle('selecionado', i === valor));
  document.querySelectorAll('#resposta-likert .likert-btn').forEach((b, i) => b.classList.toggle('selecionado', i === valor - 1));
}

// ---------- autocorreção da digitação ----------
const correcoesRecentes = [];

function renderCorrecoes() {
  const cont = $('correcoes');
  cont.innerHTML = '';
  correcoesRecentes.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-correcao';
    b.title = 'Toque para desfazer esta correção';
    b.textContent = `${c.original} → ${c.corrigido}  ✕`;
    b.addEventListener('click', () => {
      desfazerCorrecao($('transcricao-texto'), c);
      correcoesRecentes.splice(correcoesRecentes.indexOf(c), 1);
      renderCorrecoes();
    });
    cont.appendChild(b);
  });
}

function atualizarBotaoAutocorrecao() {
  $('btn-autocorrecao').textContent = `✍️ Autocorreção da digitação: ${autocorrecaoLigada() ? 'ligada' : 'desligada'}`;
}

$('btn-autocorrecao').addEventListener('click', () => {
  definirAutocorrecao(!autocorrecaoLigada());
  atualizarBotaoAutocorrecao();
});

$('transcricao-texto').addEventListener('input', salvarRascunho);
carregarCorretor();
atualizarBotaoAutocorrecao();
ativarAutocorrecao($('transcricao-texto'), {
  onCorrecao: (c) => {
    correcoesRecentes.unshift(c);
    if (correcoesRecentes.length > 6) correcoesRecentes.pop();
    renderCorrecoes();
  },
});

$('btn-pular-pergunta').addEventListener('click', () => avancarPergunta(true));
$('btn-confirmar-pergunta').addEventListener('click', () => avancarPergunta(false));

function avancarPergunta(pular) {
  const perguntas = coleta.session.perguntas;
  const p = perguntas[coleta.indicePergunta];
  const texto = $('transcricao-texto').value.trim();

  if (!pular) {
    if (p.tipo !== 'aberta' && coleta.valorAtual === null) {
      toast('Toque na nota/nível antes de confirmar (ou use "Pular").');
      return;
    }
    if (p.tipo === 'aberta') {
      if (texto) {
        gravarRespondente({ [`abertas.${p.id}`]: texto });
        coleta.respostasCache[p.id] = { texto };
      }
    } else {
      gravarRespondente({ [`respostas.${p.id}`]: { valor: coleta.valorAtual, texto } });
      coleta.respostasCache[p.id] = { valor: coleta.valorAtual, texto };
    }
  }
  limparRascunho();

  coleta.indicePergunta++;
  if (coleta.indicePergunta >= perguntas.length) {
    const n = coleta.seq;
    if (coleta.respondenteCriado) {
      gravarRespondente({ finalizadoEm: serverTimestamp() });
      gravarLocal('falclima_em_andamento', null);
      waitForPendingWrites(db).then(() => toast(`Respondente ${n} salvo e enviado.`)).catch(() => {});
    }
    toast(`Respondente ${n} concluído. Iniciando o próximo.`);
    coleta.seq = Math.max(coleta.seq, (coleta.session.proximoSeq || 1) - 1) + 1;
    iniciarNovoRespondente();
  } else {
    mostrarPergunta();
  }
}

// ---------- tela: relatório ----------
let relatorioUnsub = null;
let relatorioSession = null;
let relatorioSessionId = null;
let relatorioRespondentes = [];

function temResposta(r) {
  return Object.keys(r.respostas || {}).length > 0 || Object.keys(r.abertas || {}).length > 0;
}

function respondentesFiltrados(filtro) {
  const comResposta = relatorioRespondentes.filter(temResposta);
  return filtro ? comResposta.filter((r) => r.segmento === filtro) : comResposta;
}

$('btn-reabrir').addEventListener('click', () => {
  if (!relatorioSessionId) return;
  updateDoc(doc(db, 'sessions', relatorioSessionId), { status: 'aberta', encerradoEm: null }).catch(falhaGravar);
  location.hash = `#/coleta/${relatorioSessionId}`;
});

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
  relatorioSessionId = sessionId;
  $('link-editar').href = `#/editar/${sessionId}`;
  $('btn-reabrir').classList.toggle('hidden', relatorioSession.status !== 'encerrada');
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
    s.src = 'vendor/pptxgen.bundle.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('não foi possível carregar a biblioteca de PPT'));
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
    const respondentes = respondentesFiltrados(filtro);

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
  const respondentes = respondentesFiltrados(filtro);
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

// ---------- tela: editar histórico ----------
const editar = { sessionId: null, session: null, itens: [] };

async function telaEditar(sessionId, seqAbrir = 0) {
  mostrarTela('tela-editar');
  $('editar-lista').classList.remove('hidden');
  $('editar-detalhe').classList.add('hidden');
  let sSnap;
  let rSnap;
  try {
    sSnap = await getDoc(doc(db, 'sessions', sessionId));
    rSnap = await getDocs(query(collection(db, 'sessions', sessionId, 'respondentes'), orderBy('seq')));
  } catch (e) {
    toast('Esta pesquisa ainda não está guardada neste aparelho. Abra-a uma vez com internet.');
    location.hash = '#/'; return;
  }
  if (!sSnap.exists()) { toast('Pesquisa não encontrada.'); location.hash = '#/'; return; }
  editar.sessionId = sessionId;
  editar.session = sSnap.data();
  editar.itens = rSnap.docs.map((d) => ({ ref: d.ref, ...d.data() }));
  $('topbar-title').textContent = editar.session.clienteNome;
  $('topbar-subtitle').textContent = 'Editar respostas';
  $('editar-titulo').textContent = `Editar — ${editar.session.clienteNome}`;
  $('link-editar-relatorio').href = `#/relatorio/${sessionId}`;
  atualizarLogoTopbar(editar.session.logo);
  renderListaEditar();
  const alvo = seqAbrir && editar.itens.find((x) => x.seq === seqAbrir);
  if (alvo) abrirEdicao(alvo);
}

function ehVazio(r) {
  return Object.keys(r.respostas || {}).length + Object.keys(r.abertas || {}).length === 0;
}

$('btn-editar-coletar').addEventListener('click', () => {
  if (!editar.sessionId) return;
  if (editar.session.status !== 'aberta') {
    updateDoc(doc(db, 'sessions', editar.sessionId), { status: 'aberta', encerradoEm: null }).catch(falhaGravar);
  }
  location.hash = `#/coleta/${editar.sessionId}`;
});

$('btn-limpar-vazios').addEventListener('click', () => {
  const vazios = editar.itens.filter(ehVazio);
  if (!vazios.length) return;
  if (!confirm(`Apagar ${vazios.length} respondente(s) VAZIO(S), sem nenhuma resposta?\n\nOs respondentes que têm respostas não são mexidos.`)) return;
  vazios.forEach((r) => deleteDoc(r.ref).catch(falhaGravar));
  editar.itens = editar.itens.filter((r) => !ehVazio(r));
  const maior = editar.itens.reduce((m, r) => Math.max(m, r.seq || 0), 0);
  updateDoc(doc(db, 'sessions', editar.sessionId), { proximoSeq: maior + 1 }).catch(falhaGravar);
  toast('Respondentes vazios apagados.');
  renderListaEditar();
});

// ---------- importar planilha do Google Forms ----------
$('btn-importar-planilha').addEventListener('click', () => {
  $('arquivo-planilha').value = '';
  $('arquivo-planilha').click();
});

$('arquivo-planilha').addEventListener('change', async (e) => {
  const arquivo = e.target.files && e.target.files[0];
  if (!arquivo) return;
  try {
    abrirImportacao(await lerPlanilha(arquivo), arquivo.name);
  } catch (err) {
    toast((err && err.message) || 'Não consegui ler esta planilha.');
  }
});

function abrirImportacao(planilha, nomeArquivo) {
  const { cabecalho, linhas } = planilha;
  const perguntas = editar.session.perguntas || [];
  const det = $('editar-detalhe');
  det.innerHTML = '';
  $('editar-lista').classList.add('hidden');
  $('editar-acoes-lista').classList.add('hidden');
  det.classList.remove('hidden');
  window.scrollTo(0, 0);

  const usadas = new Set();
  const mapa = {};
  perguntas.forEach((p) => {
    const i = sugerirColuna(p.texto, cabecalho, usadas);
    mapa[p.id] = i;
    if (i >= 0) usadas.add(i);
  });
  const colNome = acharColuna(cabecalho, /^(nome|seu nome|name)\b/);
  const colSeg = acharColuna(cabecalho, /\b(setor|segmento|departamento|area)\b/);
  const escolha = { nome: colNome, segmento: colSeg };

  const opcoesCol = (sel) => `<option value="-1">— não importar —</option>` +
    cabecalho.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${escapeHtml(h || '(coluna ' + (i + 1) + ')')}</option>`).join('');

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Importar planilha</h2>
    <p class="ajuda">${escapeHtml(nomeArquivo)} — ${linhas.length} resposta(s) encontrada(s). Confira qual coluna da planilha corresponde a cada pergunta.</p>
    <label class="campo"><span>Nome do respondente (opcional)</span><select data-campo="nome">${opcoesCol(colNome)}</select></label>
    <label class="campo"><span>Setor / segmento (opcional)</span><select data-campo="segmento">${opcoesCol(colSeg)}</select></label>
    ${perguntas.map((p, idx) => `
      <label class="campo"><span>${idx + 1}. ${escapeHtml(p.texto)}</span><select data-pergunta="${p.id}">${opcoesCol(mapa[p.id])}</select></label>`).join('')}
    <p id="import-resumo" class="ajuda"></p>`;
  det.appendChild(card);

  const resumo = () => {
    const existentes = new Set(editar.itens.map((r) => r.importId).filter(Boolean));
    const prontos = [];
    let repetidas = 0;
    let vazias = 0;
    linhas.forEach((l) => {
      const id = idDaLinha(l);
      if (existentes.has(id)) { repetidas++; return; }
      const temResposta = perguntas.some((p) => mapa[p.id] >= 0 && converterValor(p, l[mapa[p.id]]) !== null);
      if (!temResposta) { vazias++; return; }
      prontos.push({ id, linha: l });
    });
    $('import-resumo').textContent = `Serão importados ${prontos.length} respondente(s)` +
      (repetidas ? `; ${repetidas} já importado(s) antes serão ignorados` : '') +
      (vazias ? `; ${vazias} sem nenhuma resposta reconhecida serão ignorados` : '') + '.';
    return prontos;
  };
  card.addEventListener('change', (ev) => {
    const s = ev.target;
    if (s.dataset.pergunta) mapa[s.dataset.pergunta] = parseInt(s.value, 10);
    else if (s.dataset.campo) escolha[s.dataset.campo] = parseInt(s.value, 10);
    resumo();
  });
  resumo();

  const acoes = document.createElement('div');
  acoes.className = 'coleta-acoes';
  acoes.innerHTML = `
    <button type="button" class="btn btn-secundario" data-acao="voltar">← Cancelar</button>
    <button type="button" class="btn btn-primario" data-acao="importar">Importar respostas</button>`;
  acoes.querySelector('[data-acao="voltar"]').addEventListener('click', renderListaEditar);
  acoes.querySelector('[data-acao="importar"]').addEventListener('click', () => {
    const prontos = resumo();
    if (!prontos.length) { toast('Nada para importar.'); return; }
    if (!confirm(`Importar ${prontos.length} respondente(s) para esta pesquisa?`)) return;
    importarLinhas(prontos, perguntas, mapa, escolha);
  });
  det.appendChild(acoes);
}

function importarLinhas(prontos, perguntas, mapa, escolha) {
  const maior = editar.itens.reduce((m, r) => Math.max(m, r.seq || 0), 0);
  let seq = Math.max(maior, (editar.session.proximoSeq || 1) - 1);
  const segmentos = [...(editar.session.segmentos || [])];
  prontos.forEach(({ id, linha }) => {
    seq++;
    const respostas = {};
    const abertas = {};
    perguntas.forEach((p) => {
      if (mapa[p.id] < 0) return;
      const v = converterValor(p, linha[mapa[p.id]]);
      if (v === null) return;
      if (p.tipo === 'aberta') abertas[p.id] = v; else respostas[p.id] = { valor: v, texto: '' };
    });
    const nome = escolha.nome >= 0 ? (linha[escolha.nome] || '').trim() || null : null;
    const segmento = escolha.segmento >= 0 ? (linha[escolha.segmento] || '').trim() || null : null;
    if (segmento && !segmentos.includes(segmento)) segmentos.push(segmento);
    const ref = doc(collection(db, 'sessions', editar.sessionId, 'respondentes'));
    const dados = { seq, nome, segmento, respostas, abertas, origem: 'importado', importId: id };
    setDoc(ref, { ...dados, criadoEm: serverTimestamp(), finalizadoEm: serverTimestamp() }).catch(falhaGravar);
    editar.itens.push({ ref, ...dados });
  });
  updateDoc(doc(db, 'sessions', editar.sessionId), { proximoSeq: seq + 1, segmentos }).catch(falhaGravar);
  editar.session.proximoSeq = seq + 1;
  editar.session.segmentos = segmentos;
  toast(`${prontos.length} respondente(s) importado(s).`);
  renderListaEditar();
}

function renderListaEditar() {
  $('editar-lista').classList.remove('hidden');
  $('editar-detalhe').classList.add('hidden');
  $('editar-acoes-lista').classList.remove('hidden');
  const vazios = editar.itens.filter(ehVazio).length;
  $('btn-limpar-vazios').classList.toggle('hidden', vazios === 0);
  $('btn-limpar-vazios').textContent = `🧹 Apagar ${vazios} respondente(s) vazio(s)`;
  const cont = $('editar-lista');
  cont.innerHTML = '';
  if (!editar.itens.length) {
    cont.innerHTML = '<p class="texto-vazio">Nenhum respondente ainda.</p>';
    return;
  }
  const total = (editar.session.perguntas || []).length;
  [...editar.itens].sort((a, b) => b.seq - a.seq).forEach((r) => {
    const respondidas = Object.keys(r.respostas || {}).length + Object.keys(r.abertas || {}).length;
    const item = document.createElement('div');
    item.className = 'pesquisa-item';
    item.innerHTML = `
      <div class="pesquisa-item-info">
        <div class="pesquisa-item-nome">Respondente ${r.seq}${r.nome ? ' — ' + escapeHtml(r.nome) : ''}${r.segmento ? ' · ' + escapeHtml(r.segmento) : ''}</div>
        <div class="pesquisa-item-meta">${respondidas === 0 ? 'vazio (nenhuma resposta)' : respondidas + ' de ' + total + ' respondidas'}</div>
      </div>
      <span class="badge-status badge-encerrada">Editar</span>
    `;
    item.addEventListener('click', () => abrirEdicao(r));
    cont.appendChild(item);
  });
}

function abrirEdicao(r) {
  const perguntas = editar.session.perguntas || [];
  const draft = { nome: r.nome || '', segmento: r.segmento || '', valores: {}, textos: {}, abertas: { ...(r.abertas || {}) } };
  perguntas.forEach((p) => {
    const atual = (r.respostas || {})[p.id];
    if (atual && typeof atual.valor === 'number') draft.valores[p.id] = atual.valor;
    draft.textos[p.id] = (atual && atual.texto) || '';
  });

  const det = $('editar-detalhe');
  det.innerHTML = '';
  $('editar-lista').classList.add('hidden');
  $('editar-acoes-lista').classList.add('hidden');
  det.classList.remove('hidden');
  window.scrollTo(0, 0);

  const segmentos = [...(editar.session.segmentos || [])];
  if (draft.segmento && !segmentos.includes(draft.segmento)) segmentos.push(draft.segmento);
  const topo = document.createElement('div');
  topo.className = 'card';
  topo.innerHTML = `
    <h2>Respondente ${r.seq}</h2>
    <label class="campo"><span>Nome (só para você, não aparece no relatório)</span>
      <input type="text" class="editar-nome" value="${escapeHtml(draft.nome)}" autocomplete="off">
    </label>
    <label class="campo"><span>Setor / segmento</span>
      <select>
        <option value="">(sem segmento)</option>
        ${segmentos.map((s) => `<option value="${escapeHtml(s)}" ${s === draft.segmento ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
      </select>
    </label>`;
  topo.querySelector('select').addEventListener('change', (e) => { draft.segmento = e.target.value; });
  topo.querySelector('.editar-nome').addEventListener('input', (e) => { draft.nome = e.target.value; });
  det.appendChild(topo);

  perguntas.forEach((p, idx) => {
    const bloco = document.createElement('div');
    bloco.className = 'card';
    bloco.innerHTML = `<div class="pergunta-relatorio-titulo">${idx + 1}. ${escapeHtml(p.texto)}</div>`;

    if (p.tipo === 'aberta') {
      const ta = document.createElement('textarea');
      ta.rows = 3;
      ta.className = 'editar-texto';
      ta.value = draft.abertas[p.id] || '';
      ta.addEventListener('input', () => { draft.abertas[p.id] = ta.value; });
      bloco.appendChild(ta);
    } else {
      const opcoes = p.tipo === 'nota10'
        ? Array.from({ length: 11 }, (_, i) => ({ valor: i, label: String(i) }))
        : NIVEIS[p.tipo].map((label, i) => ({ valor: i + 1, label }));
      const grade = document.createElement('div');
      grade.className = p.tipo === 'nota10' ? 'resposta-nota10' : 'resposta-likert';
      const botoes = opcoes.map((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = p.tipo === 'nota10' ? 'nota-btn' : 'likert-btn';
        b.textContent = o.label;
        b.addEventListener('click', () => {
          if (draft.valores[p.id] === o.valor) delete draft.valores[p.id]; else draft.valores[p.id] = o.valor;
          marcar();
        });
        grade.appendChild(b);
        return b;
      });
      const marcar = () => botoes.forEach((b, i) => b.classList.toggle('selecionado', draft.valores[p.id] === opcoes[i].valor));
      marcar();
      bloco.appendChild(grade);
      const ta = document.createElement('textarea');
      ta.rows = 2;
      ta.className = 'editar-texto';
      ta.placeholder = 'Comentário (opcional)';
      ta.value = draft.textos[p.id] || '';
      ta.addEventListener('input', () => { draft.textos[p.id] = ta.value; });
      bloco.appendChild(ta);
    }
    det.appendChild(bloco);
  });

  const acoes = document.createElement('div');
  acoes.className = 'coleta-acoes';
  acoes.innerHTML = `
    <button type="button" class="btn btn-secundario" data-acao="voltar">← Voltar</button>
    <button type="button" class="btn btn-apagar-grande" data-acao="apagar">Apagar respondente</button>
    <button type="button" class="btn btn-primario" data-acao="salvar">Salvar alterações</button>`;
  acoes.querySelector('[data-acao="voltar"]').addEventListener('click', renderListaEditar);
  acoes.querySelector('[data-acao="apagar"]').addEventListener('click', () => {
    if (!confirm(`Apagar o Respondente ${r.seq} e todas as respostas dele?\n\nNão dá para desfazer.`)) return;
    deleteDoc(r.ref).catch(falhaGravar);
    editar.itens = editar.itens.filter((x) => x !== r);
    toast('Respondente apagado.');
    renderListaEditar();
  });
  acoes.querySelector('[data-acao="salvar"]').addEventListener('click', () => {
    const respostas = {};
    const abertas = {};
    perguntas.forEach((p) => {
      if (p.tipo === 'aberta') {
        const t = (draft.abertas[p.id] || '').trim();
        if (t) abertas[p.id] = t;
      } else if (typeof draft.valores[p.id] === 'number') {
        respostas[p.id] = { valor: draft.valores[p.id], texto: (draft.textos[p.id] || '').trim() };
      }
    });
    const nome = draft.nome.trim() || null;
    updateDoc(r.ref, { nome, segmento: draft.segmento || null, respostas, abertas }).catch(falhaGravar);
    Object.assign(r, { nome, segmento: draft.segmento || null, respostas, abertas });
    toast('Alterações salvas.');
    renderListaEditar();
  });
  det.appendChild(acoes);
}

// ---------- conexão ----------
function atualizarStatusRede() {
  $('status-rede').classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('offline', atualizarStatusRede);
window.addEventListener('online', () => {
  atualizarStatusRede();
  if (db) waitForPendingWrites(db).then(() => toast('Conexão de volta — tudo foi enviado.')).catch(() => {});
});
atualizarStatusRede();

// PWA
if ('serviceWorker' in navigator) {
  const tinhaControlador = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (tinhaControlador) location.reload(); });
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

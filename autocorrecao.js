// Autocorreção de digitação rápida em português: corrige a palavra quando o consultor
// aperta espaço ou pontuação. Só corrige quando tem alta confiança; tudo pode ser desfeito.

const ALFABETO = 'abcdefghijklmnopqrstuvwxyzáàâãéêíóôõúüç';

const ATALHOS = {
  vc: 'você', vcs: 'vocês', q: 'que', pq: 'porque', tb: 'também', tbm: 'também', tmb: 'também',
  mto: 'muito', mt: 'muito', mta: 'muita', mtos: 'muitos', mtas: 'muitas', hj: 'hoje', n: 'não',
  nd: 'nada', td: 'tudo', tds: 'todos', msm: 'mesmo', dps: 'depois', cmg: 'comigo', ctz: 'certeza',
  qdo: 'quando', qnd: 'quando', ngm: 'ninguém', obs: 'observação', func: 'funcionário', funcs: 'funcionários',
};

const LINHAS = ['qwertyuiop', 'asdfghjklç', 'zxcvbnm'];
const VIZINHAS = (() => {
  const mapa = {};
  const add = (a, b) => { if (!a || !b) return; (mapa[a] = mapa[a] || new Set()).add(b); (mapa[b] = mapa[b] || new Set()).add(a); };
  LINHAS.forEach((linha, r) => {
    [...linha].forEach((tecla, c) => {
      add(tecla, linha[c + 1]);
      if (LINHAS[r + 1]) { add(tecla, LINHAS[r + 1][c - 1]); add(tecla, LINHAS[r + 1][c]); }
    });
  });
  return mapa;
})();

function vizinha(a, b) {
  const x = semAcento(a);
  const y = semAcento(b);
  return x === y || (VIZINHAS[x] && VIZINHAS[x].has(y));
}

function semAcento(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function aplicarCaixa(original, corrigida) {
  if (original[0] !== original[0].toLowerCase()) return corrigida[0].toUpperCase() + corrigida.slice(1);
  return corrigida;
}

export function criarCorretor(textoDicionario) {
  const freq = new Map();
  const porBase = new Map();
  for (const linha of textoDicionario.split('\n')) {
    const i = linha.indexOf('\t');
    if (i < 0) continue;
    const palavra = linha.slice(0, i);
    const c = parseInt(linha.slice(i + 1), 10);
    freq.set(palavra, c);
    const base = semAcento(palavra);
    if (base !== palavra) {
      const atual = porBase.get(base);
      if (!atual || freq.get(atual) < c) porBase.set(base, palavra);
    }
  }

  // candidatos que parecem erro de digitação rápida (não qualquer palavra parecida)
  function candidatos(w) {
    const out = new Set();
    const n = w.length;
    for (let i = 0; i < n; i++) {
      const igualVizinha = w[i] === w[i - 1] || w[i] === w[i + 1];
      const teclaProxima = (i > 0 && vizinha(w[i], w[i - 1])) || (i < n - 1 && vizinha(w[i], w[i + 1]));
      if (igualVizinha || teclaProxima) out.add(w.slice(0, i) + w.slice(i + 1));
    }
    for (let i = 0; i < n - 1; i++) out.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
    for (let i = 0; i < n; i++) for (const l of ALFABETO) if (l !== w[i] && vizinha(w[i], l)) out.add(w.slice(0, i) + l + w.slice(i + 1));
    for (let i = 0; i <= n; i++) for (const l of ALFABETO) out.add(w.slice(0, i) + l + w.slice(i));
    return out;
  }

  function melhor(cands, lower) {
    let a = null; let pa = 0; let pb = 0;
    for (const cand of cands) {
      const f = freq.get(cand);
      if (f === undefined) continue;
      const p = f * (cand[0] === lower[0] ? 1 : 0.05);
      if (p > pa) { pb = pa; pa = p; a = cand; } else if (p > pb) { pb = p; }
    }
    return { palavra: a, pontos: pa, segundo: pb };
  }

  return {
    tamanho: freq.size,

    corrigir(palavra, inicioFrase = false, ignorar = null) {
      if (!/^\p{L}+$/u.test(palavra)) return null;
      const ehSigla = palavra.length > 1 && palavra === palavra.toUpperCase();
      if (ehSigla) return null;
      const primeiraMaiuscula = palavra[0] !== palavra[0].toLowerCase();
      if (primeiraMaiuscula && palavra.slice(1) !== palavra.slice(1).toLowerCase()) return null;
      if (primeiraMaiuscula && !inicioFrase) return null;

      const lower = palavra.toLowerCase();
      if (ignorar && ignorar.has(lower)) return null;

      if (ATALHOS[lower]) return aplicarCaixa(palavra, ATALHOS[lower]);
      if (lower.length < 3) return null;

      const c = freq.get(lower);
      const conhecida = c !== undefined
        || (lower.endsWith('s') && freq.has(lower.slice(0, -1)))
        || (lower.endsWith('es') && freq.has(lower.slice(0, -2)));
      // palavra comum ou variação de palavra conhecida: nunca é mexida
      if (c === undefined ? conhecida : c >= 2000) return null;

      // 1) faltou acento (comunicacao -> comunicação)
      const comAcento = porBase.get(lower);
      if (comAcento && comAcento !== lower && c === undefined) return aplicarCaixa(palavra, comAcento);

      // 2) um erro de digitação (letra trocada, faltando, sobrando ou acento)
      const r1 = melhor(candidatos(lower), lower);
      if (!r1.palavra || r1.segundo * 4 > r1.pontos) return null;
      if (c !== undefined) return r1.pontos >= 1500 * c ? aplicarCaixa(palavra, r1.palavra) : null;
      const minimo = lower.length <= 4 ? 2000 : 20;
      if (r1.pontos >= minimo) return aplicarCaixa(palavra, r1.palavra);
      return null;
    },
  };
}

// ---------- ligação com a caixa de texto ----------
let corretor = null;
let carregando = null;

export function carregarCorretor() {
  if (corretor) return Promise.resolve(corretor);
  if (!carregando) {
    carregando = fetch('dicionario-pt.txt')
      .then((r) => r.text())
      .then((t) => { corretor = criarCorretor(t); return corretor; })
      .catch(() => { carregando = null; return null; });
  }
  return carregando;
}

export function autocorrecaoLigada() {
  try { return localStorage.getItem('falclima_autocorrecao') !== '0'; } catch (e) { return true; }
}

export function definirAutocorrecao(ligada) {
  try { localStorage.setItem('falclima_autocorrecao', ligada ? '1' : '0'); } catch (e) { /* sem storage */ }
}

function lerIgnorar() {
  try { return new Set(JSON.parse(localStorage.getItem('falclima_ignorar') || '[]')); } catch (e) { return new Set(); }
}

function salvarIgnorar(conjunto) {
  try { localStorage.setItem('falclima_ignorar', JSON.stringify([...conjunto])); } catch (e) { /* sem storage */ }
}

export function ativarAutocorrecao(textarea, { onCorrecao } = {}) {
  textarea.addEventListener('input', (e) => {
    if (!corretor || !autocorrecaoLigada()) return;
    const tipo = e.inputType || '';
    if (!/^insert(Text|LineBreak|Paragraph)$/.test(tipo)) return;
    const digitado = e.data || '\n';
    if (!/[\s.,;:!?)\]]/.test(digitado)) return;

    const pos = textarea.selectionStart;
    const antes = textarea.value.slice(0, pos - digitado.length);
    const m = antes.match(/(\p{L}+)$/u);
    if (!m) return;
    const palavra = m[1];
    const inicio = antes.length - palavra.length;
    const prefixo = antes.slice(0, inicio).trimEnd();
    const inicioFrase = prefixo === '' || /[.!?]$/.test(prefixo);

    const novo = corretor.corrigir(palavra, inicioFrase, lerIgnorar());
    if (!novo || novo === palavra) return;
    textarea.setRangeText(novo, inicio, inicio + palavra.length, 'preserve');
    const caret = pos + (novo.length - palavra.length);
    textarea.setSelectionRange(caret, caret);
    onCorrecao && onCorrecao({ original: palavra, corrigido: novo });
  });
}

// desfaz uma correção e passa a ignorar essa palavra
export function desfazerCorrecao(textarea, { original, corrigido }) {
  const texto = textarea.value;
  const re = new RegExp(`(^|[^\\p{L}])(${corrigido.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}])`, 'gu');
  let ultimo = null;
  let m;
  while ((m = re.exec(texto)) !== null) ultimo = m;
  if (ultimo) {
    const inicio = ultimo.index + ultimo[1].length;
    const caret = textarea.selectionStart;
    textarea.setRangeText(original, inicio, inicio + corrigido.length, 'preserve');
    const delta = original.length - corrigido.length;
    const novoCaret = caret > inicio ? caret + delta : caret;
    textarea.setSelectionRange(novoCaret, novoCaret);
  }
  const ignorar = lerIgnorar();
  ignorar.add(original.toLowerCase());
  salvarIgnorar(ignorar);
}

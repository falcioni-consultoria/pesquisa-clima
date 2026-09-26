// Leitura de planilhas exportadas do Google Forms (.csv ou .xlsx) e conversão para as respostas do app.
import { NIVEIS } from './questions.js';

export function normalizar(t) {
  return String(t == null ? '' : t)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCsv(texto) {
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  const primeira = texto.split(/\r?\n/, 1)[0] || '';
  const sep = (primeira.match(/;/g) || []).length > (primeira.match(/,/g) || []).length ? ';' : ',';
  const linhas = [];
  let linha = [];
  let campo = '';
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      linhas.push(linha); linha = [];
    } else campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

let xlsxCarregando = null;
function carregarXlsx() {
  if (window.XLSX && window.XLSX.read) return Promise.resolve(window.XLSX);
  if (!xlsxCarregando) {
    xlsxCarregando = new Promise((ok, erro) => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.mini.min.js';
      s.onload = () => ok(window.XLSX);
      s.onerror = () => { xlsxCarregando = null; erro(new Error('Não foi possível carregar o leitor de Excel.')); };
      document.head.appendChild(s);
    });
  }
  return xlsxCarregando;
}

// devolve { cabecalho: [texto...], linhas: [[texto...]...] }
export async function lerPlanilha(arquivo) {
  const nome = (arquivo.name || '').toLowerCase();
  let matriz;
  if (/\.xlsx?$/.test(nome)) {
    const XLSX = await carregarXlsx();
    const wb = XLSX.read(await arquivo.arrayBuffer(), { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    matriz = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  } else {
    matriz = parseCsv(await arquivo.text());
  }
  matriz = matriz
    .map((l) => l.map((c) => (c == null ? '' : String(c).trim())))
    .filter((l) => l.some((c) => c !== ''));
  if (matriz.length < 2) throw new Error('A planilha precisa ter o cabeçalho e ao menos uma resposta.');
  const cabecalho = matriz[0];
  const linhas = matriz.slice(1).map((l) => cabecalho.map((_, i) => l[i] || ''));
  return { cabecalho, linhas };
}

// procura, entre as colunas, a que mais se parece com o texto da pergunta (-1 se nenhuma)
export function sugerirColuna(textoPergunta, cabecalho, usadas = new Set()) {
  const alvo = normalizar(textoPergunta).replace(/^\d+ /, '');
  if (!alvo) return -1;
  const tokens = new Set(alvo.split(' ').filter((t) => t.length > 2));
  let melhor = -1;
  let pontos = 0;
  cabecalho.forEach((h, i) => {
    if (usadas.has(i)) return;
    const n = normalizar(h).replace(/^\d+ /, '');
    if (!n) return;
    let p = 0;
    if (n === alvo) p = 100;
    else if (n.includes(alvo) || alvo.includes(n)) p = 80;
    else {
      const th = new Set(n.split(' ').filter((t) => t.length > 2));
      const comum = [...tokens].filter((t) => th.has(t)).length;
      const uniao = new Set([...tokens, ...th]).size || 1;
      p = (comum / uniao) * 70;
    }
    if (p > pontos) { pontos = p; melhor = i; }
  });
  return pontos >= 45 ? melhor : -1;
}

export function acharColuna(cabecalho, regex) {
  return cabecalho.findIndex((h) => regex.test(normalizar(h)));
}

// converte o texto de uma célula na resposta esperada; null = vazio ou não entendido
export function converterValor(pergunta, texto) {
  const t = String(texto || '').trim();
  if (!t) return null;
  if (pergunta.tipo === 'aberta') return t;
  if (pergunta.tipo === 'nota10') {
    const m = t.match(/^\s*(\d+(?:[.,]\d+)?)/);
    if (!m) return null;
    const n = Math.round(parseFloat(m[1].replace(',', '.')));
    return n >= 0 && n <= 10 ? n : null;
  }
  const niveis = NIVEIS[pergunta.tipo] || [];
  const n = normalizar(t);
  const idx = niveis.findIndex((l) => normalizar(l) === n);
  if (idx >= 0) return idx + 1;
  const num = t.match(/^\s*([1-5])\b/);
  return num ? parseInt(num[1], 10) : null;
}

// identificador estável da linha, para não importar a mesma resposta duas vezes
export function idDaLinha(linha) {
  const s = linha.join('␟');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return 'i' + h.toString(36) + '_' + s.length;
}

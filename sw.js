const CACHE = 'pesquisa-clima-v11';
const ARQUIVOS = ['./index.html', './style.css', './app.js', './questions.js', './voice.js', './firebase-config.js', './manifest.json', './icons/falcioni-mark.png', './voice-gravacao.js', './whisper-worker.js', './autocorrecao.js', './dicionario-pt.txt'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// network-first: GitHub Pages não permite header Cache-Control customizado,
// então evitamos servir versão antiga do app preferindo sempre a rede quando disponível.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((resp) => {
        const copia = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copia));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

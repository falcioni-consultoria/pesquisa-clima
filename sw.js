const CACHE = 'pesquisa-clima-v15';
const ARQUIVOS = [
  './', './index.html', './style.css', './app.js', './questions.js', './importar.js', './vendor/xlsx.mini.min.js', './firebase-config.js', './manifest.json',
  './autocorrecao.js', './dicionario-pt.txt',
  './vendor/firebase-app.js', './vendor/firebase-firestore.js', './vendor/pptxgen.bundle.js',
  './icons/falcioni-mark.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.allSettled(ARQUIVOS.map((a) => cache.add(a))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Rede primeiro (pega versão nova), mas se a internet estiver fora ou lenta (4 s) usa o que está guardado,
// para o app abrir mesmo sem internet.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  const doCache = async () => {
    const cache = await caches.open(CACHE);
    const achado = await cache.match(event.request, { ignoreSearch: true });
    if (achado) return achado;
    if (event.request.mode === 'navigate') return cache.match('./index.html');
    return undefined;
  };
  event.respondWith((async () => {
    try {
      const rede = fetch(event.request, { cache: 'no-cache' });
      const resp = await Promise.race([
        rede,
        new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), 4000)),
      ]);
      if (resp && resp.ok) {
        const copia = resp.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copia));
      }
      return resp;
    } catch (e) {
      const guardado = await doCache();
      if (guardado) return guardado;
      return Response.error();
    }
  })());
});

const CACHE = 'digoo-v2';
const SHELL = [
  '/digoo-equipe/',
  '/digoo-equipe/index.html',
  '/digoo-equipe/style.css',
  '/digoo-equipe/manifest.json',
  '/digoo-equipe/icon-192.png',
  '/digoo-equipe/icon-512.png',
  '/digoo-equipe/apple-touch-icon.png',
  '/digoo-equipe/DIGOO.ttf',
];

// Instala e faz cache do shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Limpa caches antigos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Estratégia: sempre a versão mais nova da rede (network-first).
// A cópia guardada só é usada sem internet — assim uma atualização aparece já na primeira abertura.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Requisições externas (Firebase, Vercel, ML, Anthropic) — sempre rede, sem cache
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(cached => cached || caches.match('/digoo-equipe/index.html')))
  );
});

const CACHE = 'digoo-v1';
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

// Estratégia: network-first para API/Firebase, cache-first para assets do shell
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Requisições externas (Firebase, Vercel, ML, Anthropic) — sempre rede, sem cache
  if (url.origin !== self.location.origin) return;

  // Assets do shell — cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

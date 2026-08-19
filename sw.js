// Digoo OPS — Service Worker com cache busting automático
// A versão muda a cada deploy via GitHub Actions

const CACHE_VERSION = 'digoo-ops-ee37f74';
const CACHE_NAME = `digoo-${CACHE_VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './claude-chat.js',
  './manifest.json',
  './DIGOO.ttf',
  './css/theme.css',
  './css/layout.css',
  './css/cards.css',
  './css/tasks.css',
  './css/mercadolivre.css',
  './css/chat.css',
  './css/identity.css',
];

// Instala e faz cache dos assets principais
self.addEventListener('install', event => {
  self.skipWaiting(); // Ativa imediatamente sem esperar fechar abas
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

// Ativa e limpa caches antigos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('digoo-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim()) // Assume controle imediato de todas as abas
  );
});

// Estratégia: Network first, cache fallback
// Sempre tenta buscar versão nova; se falhar, usa cache
self.addEventListener('fetch', event => {
  // Ignora requests que não são GET ou são de outras origens
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Atualiza o cache com a versão nova
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request)) // Offline: usa cache
  );
});

// Recebe mensagem pra forçar atualização
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

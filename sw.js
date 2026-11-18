const CACHE = 'digoo-v4';
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

  // Navegação (abrir o app) vai direto, sem opções extras — o Safari do iPhone é chato com isso
  const buscar = e.request.mode === 'navigate' ? fetch(e.request) : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(
    buscar
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

// ── Notificações (enviadas pela VPS) ─────────────────────────────────────────
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Digoo OPS', {
    body: d.body || '',
    icon: '/digoo-equipe/icon-192.png',
    badge: '/digoo-equipe/icon-192.png',
    tag: d.tag || undefined,
    data: { abrir: d.abrir || null },
  }));
});

// Tocar na notificação: abre o OPS (ou traz pra frente) direto no lugar do aviso
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const abrir = e.notification.data?.abrir || null;
  const url = '/digoo-equipe/' + (abrir ? '?abrir=' + encodeURIComponent(JSON.stringify(abrir)) : '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
    const c = lista.find(x => x.url.includes('/digoo-equipe/'));
    if (c) { if (abrir) c.postMessage({ tipo: 'abrir-notificacao', abrir }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});

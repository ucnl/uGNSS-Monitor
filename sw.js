const CACHE = 'aws-v2';

const ASSETS = [
	'./',
	'./index.html',
	'./styles.css',
	'./webview-stub.js',
	'./gnss-parser.js',
	'./serial-bridge.js',
	'./app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    // 1. Не трогаем чужие origin'ы (CDN, GitHub, docs и т.д.)
    const url = new URL(event.request.url);
    if (url.origin !== location.origin) {
        return;
    }
    
    // 2. Навигационные запросы — всегда index.html из кэша
    //    (покрывает ?native=1, ?foo=bar, #hash и т.д.)
    if (event.request.mode === 'navigate') {
        event.respondWith(
            caches.match('./index.html', { ignoreSearch: true }).then((cached) => {
                return cached || fetch(event.request);
            })
        );
        return;
    }
    
    // 3. Остальные запросы — cache-first с игнором query string
    event.respondWith(
        caches.match(event.request, { ignoreSearch: true }).then((cached) => {
            return cached || fetch(event.request);
        })
    );
});
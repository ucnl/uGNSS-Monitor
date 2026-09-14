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
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request);
    })
  );
});
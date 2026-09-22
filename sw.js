// store/sw.js
const CACHE_NAME = 'volant-reads-v6';

// Pages that change with the signed-in user and must always hit the network.
const NO_CACHE_PAGES = [
    'dashboard.html',
    'profile.html'
];

// App shell cached at install so the bookstore opens offline even on first launch.
const APP_SHELL = [
    './index.html',
    './details.html',
    './reader.html'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .catch(err => {
                console.warn('⚠️ App shell cache partial:', err);
            })
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(name => name !== CACHE_NAME)
                    .map(name => {
                        console.log('🗑️ Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') {
        event.respondWith(fetch(event.request));
        return;
    }

    const url = new URL(event.request.url);
    const pathname = url.pathname;

    // Pages that should NEVER be cached (signed-in / private views)
    const isNoCachePage = NO_CACHE_PAGES.some(page => pathname.endsWith(page));

    // --- Page navigations: cache each URL under its own key so a user who
    // opens a page while online can return to THAT page after closing the app. ---
    if (event.request.mode === 'navigate' && !isNoCachePage) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                    return response;
                })
                .catch(async () => {
                    const hit = await caches.match(event.request);
                    if (hit) return hit;
                    return caches.match('./index.html');
                })
        );
        return;
    }

    if (isNoCachePage) {
        event.respondWith(fetch(event.request));
        return;
    }

    // PDF files - cache for offline
    if (event.request.url.includes('.pdf')) {
        event.respondWith(
            caches.match(event.request)
                .then(cached => cached || fetch(event.request).then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                }))
                .catch(() => new Response('Book not available offline.', { status: 503 }))
        );
        return;
    }

    // Static assets - cache first
    const isStaticAsset = pathname.includes('.css') ||
                          pathname.includes('.js') ||
                          pathname.includes('.png') ||
                          pathname.includes('.jpg') ||
                          pathname.includes('.svg') ||
                          pathname.includes('.webp') ||
                          pathname.includes('.woff') ||
                          pathname.includes('.woff2');

    if (isStaticAsset) {
        event.respondWith(
            caches.match(event.request)
                .then(cached => cached || fetch(event.request).then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                }))
                .catch(() => new Response('Resource not available.', { status: 503 }))
        );
        return;
    }

    // Everything else - network first with cache fallback
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
            .catch(() => new Response('Content not available.', { status: 503 }))
    );
});
// store/sw.js
const CACHE_NAME = 'volant-reads-v4';

const NO_CACHE_PAGES = [
    'index.html',
    'details.html',
    'dashboard.html',
    'submit.html',
    'profile.html'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                // ✅ FIX: Use relative path './reader.html'
                // Since sw.js and reader.html are in the same folder
                console.log('📦 Caching reader.html');
                return cache.addAll([
                    './reader.html'
                    // OR use the full path that matches your structure
                    // '/store/reader.html'
                ]);
            })
            .catch(err => {
                console.warn('⚠️ Cache install failed:', err);
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
    
    // Pages that should NEVER be cached
    const isNoCachePage = NO_CACHE_PAGES.some(page => pathname.endsWith(page));
    const isRoot = pathname === '/store/' || pathname === '/';
    
    if (isNoCachePage || isRoot) {
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
                          pathname.includes('.webp');
    
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
    
    // Everything else - network first
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
            .catch(() => new Response('Content not available.', { status: 503 }))
    );
});
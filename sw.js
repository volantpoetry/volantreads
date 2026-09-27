// store1/sw.js
// v20: every previous version of this app's caches is dropped when this worker
// takes over, and the new shell is always fetched past the HTTP disk cache.
//
// Cache ownership matters here: this worker is scoped to the store, but
// CacheStorage is shared by every worker on the origin. An earlier version
// deleted *every* cache that was not its own, which meant a store worker could
// wipe the Poetry app's cache and the other store's cache. Cleanup is now
// limited to the prefixes this app owns.
const APP_TAG = 'store1';
const CACHE_PREFIX = `volant-${APP_TAG}-`;
const CACHE_NAME = `${CACHE_PREFIX}v20`;

// Downloaded books are user data, not a version, so this cache survives upgrades.
const BOOK_CACHE = 'volant-reads-pdfs';

// Prefixes this app is allowed to clean.
//
// This app is hosted on its own origin (Reads), where nothing else runs, so it
// also owns the old 'volant-reads-' names its earlier versions shipped. The
// store worker reclaims those same names on the Poetry origin instead, but the
// two never meet: neither worker is ever registered on the other's origin, so
// there is no race and no shared cache to protect.
const OWNED_PREFIXES = [CACHE_PREFIX, 'volant-reads-'];
const PROTECTED_CACHES = [CACHE_NAME, BOOK_CACHE];

// Pages that change with the signed-in user and must always hit the network.
const NO_CACHE_PAGES = [
    'dashboard.html',
    'profile.html'
];

// App shell cached at install so the bookstore opens offline even on first launch.
const APP_SHELL = [
    './index.html',
    './details.html',
    './reader.html',
    './library.html',
    './pdfjs/local-viewer.html',
    './pdfjs/pdf.min.js',
    './pdfjs/pdf.worker.min.js',
    './epubjs/epub.min.js',
    './epubjs/jszip.min.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

// Cross-origin hosts we are allowed to intercept for offline use.
const CROSS_ORIGIN_CACHE = {
    'cdnjs.cloudflare.com': CACHE_NAME,   // font-awesome
    'volantpoetry.vercel.app': CACHE_NAME, // /shared/ + style.css
    'www.gstatic.com': CACHE_NAME,        // firebase SDK modules (offline boot)
    'fonts.googleapis.com': CACHE_NAME,   // Google Fonts CSS
    'fonts.gstatic.com': CACHE_NAME       // font files (woff2)
};

function isCacheable(response) {
    // Whole (200) responses are preferred so a partial Range 206 can never be
    // mistaken for the full book offline; opaque (no-cors) responses are also
    // stored so images loaded via CSS/img tags work offline too.
    return (response && response.status === 200 && (response.type === 'basic' || response.type === 'cors')) ||
           (response && response.type === 'opaque');
}

async function putInCache(cacheName, request, response) {
    try {
        if (!isCacheable(response)) return;
        const copy = response.clone();
        const cache = await caches.open(cacheName);
        await cache.put(request, copy);
    } catch (err) {
        console.warn('SW cache put failed:', err);
    }
}

// Always look inside one named cache. A global caches.match() would happily
// serve a copy of the request that belongs to another app on this origin.
function matchIn(cacheName, request) {
    return caches.open(cacheName).then((cache) => cache.match(request)).catch(() => undefined);
}

// Cache-first, then network (falls back to a 503 if offline and uncached).
function cacheFirst(request, cacheName) {
    return matchIn(cacheName, request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
            putInCache(cacheName, request, response);
            return response;
        }).catch(() => new Response('Resource not available offline.', { status: 503 }));
    });
}

// Network-first, cache fallback (falls back to a 503 if offline and uncached).
function networkFirst(request, cacheName) {
    return fetch(request).then((response) => {
        putInCache(cacheName, request, response);
        return response;
    }).catch(() => matchIn(cacheName, request).then((cached) => cached || new Response('Content not available offline.', { status: 503 })));
}

// Stale-while-revalidate: serve the cached copy instantly (online or offline)
// and refresh the cache with the network response in the background.
async function staleWhileRevalidate(request, cacheName) {
    try {
        const cache = await caches.open(cacheName);
        const cached = await cache.match(request);
        const networkPromise = fetch(request).then((response) => {
            putInCache(cacheName, request, response);
            return response;
        }).catch(() => null);
        if (cached) return cached;
        return (await networkPromise) || new Response('Image not available offline.', { status: 503 });
    } catch (err) {
        const hit = await matchIn(cacheName, request);
        return hit || new Response('Image not available offline.', { status: 503 });
    }
}

// Navigation: cache that exact URL, fall back to the offline home page.
function navigateFirst(request) {
    return fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
    }).catch(async () => {
        const hit = await matchIn(CACHE_NAME, request);
        if (hit) return hit;
        const url = new URL(request.url);
        const pathHit = await matchIn(CACHE_NAME, new Request(url.origin + url.pathname));
        if (pathHit) return pathHit;
        const fallback = await matchIn(CACHE_NAME, './index.html');
        if (fallback) return fallback;
        return new Response('Offline', { status: 503 });
    });
}

// Book files (PDF/EPUB) - network-first with offline cache fallback.
function isBookFile(url) {
    return url.pathname.toLowerCase().endsWith('.pdf') ||
           url.pathname.toLowerCase().endsWith('.epub');
}

// Covers + avatars from Cloudinary or Google - stale-while-revalidate so they
// display instantly from cache offline and refresh in the background when online.
function isCoverOrAvatar(url) {
    return (url.hostname === 'res.cloudinary.com' ||
            url.hostname.endsWith('.googleusercontent.com')) &&
           !isBookFile(url);
}

// Drops the caches this app owns that are not the ones this version needs.
// Nothing outside OWNED_PREFIXES is ever touched, so Poetry and the other store
// keep their caches, and downloaded books survive the upgrade.
async function purgeStaleCaches() {
    const names = await caches.keys();
    const stale = names.filter((name) =>
        !PROTECTED_CACHES.includes(name) && OWNED_PREFIXES.some((p) => name.startsWith(p))
    );
    if (!stale.length) return [];
    await Promise.all(stale.map((name) => caches.delete(name).catch(() => false)));
    console.log('[store1 sw] removed superseded caches:', stale.join(', '));
    return stale;
}

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        // Reclaim the previous versions before filling the new cache, so a
        // returning user never sees files from an older deployment.
        await purgeStaleCaches();

        const cache = await caches.open(CACHE_NAME);

        // cache: 'reload' is the important part. Without it the browser may
        // satisfy these from its own HTTP disk cache, so the worker can
        // "update" into a brand new cache full of the OLD html/css/js and the
        // user never sees this deployment at all.
        // allSettled instead of addAll: one missing file must not abort the rest.
        const results = await Promise.allSettled(
            APP_SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))
        );
        const failed = APP_SHELL.filter((_, i) => results[i].status === 'rejected');
        if (failed.length) {
            console.warn('[store1 sw] app-shell misses:', failed.join(', '));
        }

        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        // Runs again here because install's cleanup happens before this worker
        // owns the scope, and an older version may have re-created a cache.
        await purgeStaleCaches();
        await self.clients.claim();
    })());
});

// Lets a page hand over to the waiting worker without a full reload cycle.
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') {
        event.respondWith(fetch(event.request));
        return;
    }

    const url = new URL(event.request.url);
    const hostname = url.hostname;
    const pathname = url.pathname;
    const request = event.request;

    // --- Book files (PDF/EPUB): network-first, cache-first from the dedicated
    // --- book cache when offline. ---
    if (isBookFile(url)) {
        event.respondWith(networkFirst(request, BOOK_CACHE));
        return;
    }

    // --- Covers + avatars (Cloudinary/Google): serve cached instantly and
    // --- refresh in the background when online (auto-updates). ---
    if (isCoverOrAvatar(url)) {
        event.respondWith(staleWhileRevalidate(request, CACHE_NAME));
        return;
    }

    // --- Allowed cross-origin hosts: cache-first with network update. ---
    const crossCache = CROSS_ORIGIN_CACHE[hostname];
    if (crossCache) {
        event.respondWith(cacheFirst(request, crossCache));
        return;
    }

    // Other cross-origin: leave to the browser.
    if (url.origin !== self.location.origin) {
        return;
    }

    // Pages that should NEVER be cached (signed-in / private views)
    const isNoCachePage = NO_CACHE_PAGES.some(page => pathname.endsWith(page));

    if (isNoCachePage) {
        event.respondWith(fetch(request));
        return;
    }

    // --- Page navigations: cache each URL under its own key ---
    if (request.mode === 'navigate') {
        event.respondWith(navigateFirst(request));
        return;
    }

    // --- Static assets: cache-first with network update. ---
    const isStaticAsset = pathname.includes('.css') ||
                          pathname.includes('.js') ||
                          pathname.includes('.mjs') ||
                          pathname.includes('.png') ||
                          pathname.includes('.jpg') ||
                          pathname.includes('.jpeg') ||
                          pathname.includes('.svg') ||
                          pathname.includes('.webp') ||
                          pathname.includes('.woff') ||
                          pathname.includes('.woff2') ||
                          pathname.includes('.ttf') ||
                          pathname.includes('.eot') ||
                          pathname.includes('.ico') ||
                          pathname.includes('.json');

    if (isStaticAsset) {
        event.respondWith(cacheFirst(request, CACHE_NAME));
        return;
    }

    // Everything else - network first with cache fallback
    event.respondWith(networkFirst(request, CACHE_NAME));
});
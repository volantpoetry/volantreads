// ============================================================
// FILE: store1/middleware.js  (volantreads.vercel.app)
// ============================================================
// Edge middleware sits outermost in Vercel's request pipeline, so it
// runs BEFORE cleanUrls (which 308-redirects /details.html -> /details),
// filesystem lookups and vercel.json rewrites.
//
// It proxies the SEO/SSR paths below to the api/ssr-page serverless
// function, keeping the original URL in the browser. The function
// returns fully-rendered HTML with per-book titles, meta, structured
// data (Book / CollectionPage / Person / Article), a live sitemap and
// robots. Unmatched requests fall through to the static files.
//
// The original request path is forwarded in the `__path` query param;
// any existing query params (?id=, ?q=) ride along unchanged.
//
// Node-free: uses only edge-runtime globals (URL, fetch, Request) —
// no dependencies, no imports.
// ============================================================

export function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const isSsrPath =
    pathname === '/details' ||
    pathname === '/details.html' ||
    pathname === '/browse' ||
    pathname.startsWith('/browse/') ||
    pathname.startsWith('/collections/') ||
    pathname.startsWith('/author/') ||
    pathname === '/search' ||
    pathname === '/best-ghanaian-poetry-books' ||
    pathname === '/sitemap.xml' ||
    pathname === '/robots.txt';

  if (!isSsrPath) return;

  const search = url.search ? url.search : '';
  const target = new URL(
    '/api/ssr-page?__path=' + encodeURIComponent(pathname) + search,
    request.url
  );
  return fetch(target, {
    redirect: 'follow',
    headers: {
      'user-agent': request.headers.get('user-agent') || ''
    }
  });
}

export default middleware;

export const config = {
  matcher: [
    '/details',
    '/details.html',
    '/browse',
    '/browse/:path*',
    '/collections/:path*',
    '/author/:path*',
    '/search',
    '/best-ghanaian-poetry-books',
    '/sitemap.xml',
    '/robots.txt'
  ]
};
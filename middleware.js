// ============================================================
// FILE: store1/middleware.js  (volantreads.vercel.app)
// ============================================================
// Edge middleware sits outermost in Vercel's request pipeline, so
// it runs BEFORE cleanUrls (which 308-redirects /details.html ->
// /details), filesystem lookups and vercel.json rewrites.
//
// For book detail URLs carrying an ?id=, it proxies the request to
// the /api/ssr-book serverless function (keeping the original URL
// in the browser), so the initial HTML contains the injected
// Schema.org Book JSON-LD. Without ?id= it lets the request fall
// through to the normal static files.
//
// Node-free: uses only edge-runtime globals (URL, fetch, Request) —
// no dependencies, no imports.
// ============================================================

export function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const isDetails = pathname === '/details' || pathname === '/details.html';
  if (!isDetails) return;

  if (!url.search) return;

  const target = new URL('/api/ssr-book' + url.search, request.url);
  return fetch(target, {
    redirect: 'follow',
    headers: {
      'user-agent': request.headers.get('user-agent') || ''
    }
  });
}

export default middleware;

export const config = {
  matcher: ['/details', '/details.html']
};
// ============================================================
// FILE: api/sample-book.js  (root + store1, src is identical)
// ============================================================
// Builds a TRULY truncated sample (first pages/chapters only) for a book and
// serves it to preview visitors. The endpoint never streams the full file and
// never returns the full Cloudinary URL.
//
//   GET /api/sample-book?id=<bookId>                 -> guest sample file
//   GET /api/sample-book?id=<bookId>&meta=1          -> {totalPages, previewPages, sampleUrl}
//   GET /api/sample-book?id=&token=<idToken>         -> meta + signed sampleUrl (verified sign-in)
//   GET /api/sample-book?id=&uid=&exp=&sig=          -> the iframe request for a signed sample
//
// A signed URL only unlocks a LARGER SAMPLE, tied to one uid, expiring; a
// forged/expired signature degrades to the guest slice. The SAMPLE_SIGN_SECRET
// env var (both Vercel projects) protects the signature.
// ============================================================

const { loadAdmin } = require('./../lib/store-admin.js');
const {
  previewSlice,
  verifySampleSig,
  buildSampleUrl,
  isEpubBook,
  truncatePdf,
  truncateEpub,
  epubSpineCount,
  measureFile,
  sampleSig
} = require('./../lib/sample-lib.js');

const SECRET = process.env.SAMPLE_SIGN_SECRET || '';
const PROJECT_ID = 'silent-depth';

const firestoreDocUrl = (bookId) =>
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/books/${encodeURIComponent(bookId)}`;

function decodeProtoValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('mapValue' in v) return decodeProtoMap(v.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeProtoValue);
  return null;
}

function decodeProtoMap(fields) {
  const out = {};
  for (const key of Object.keys(fields)) out[key] = decodeProtoValue(fields[key]);
  return out;
}

// ---- in-memory LRU for the built samples ----
const cache = new Map();
const CACHE_MAX = 150;
function cacheGet(key) {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  return null;
}
function cachePut(key, val) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, val);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function fetchBookDoc(bookId) {
  try {
    loadAdmin();
    const snap = await loadAdmin().firestore().collection('books').doc(bookId).get();
    if (snap.exists) return snap.data();
  } catch (err) { /* fall through to REST */ }
  try {
    const res = await fetch(firestoreDocUrl(bookId));
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.fields) return null;
    return decodeProtoMap(body.fields);
  } catch (err) {
    return null;
  }
}

async function resolveFullUrl(bookId, book) {
  // Prefer the protected files/full subcollection (Phase 2), which Admin can
  // read regardless of client rules; fall back to a legacy book.pdfUrl before
  // the migration has run.
  try {
    loadAdmin();
    const snap = await loadAdmin().firestore().collection('books').doc(bookId)
      .collection('files').doc('full').get();
    if (snap.exists && snap.data().url) return snap.data().url;
  } catch (err) {
    // Swallowing this hid the real cause behind a generic 422. Admin needs
    // SERVICE_ACCOUNT_KEY (or SERVICE_ACCOUNT / GOOGLE_CREDENTIALS) to read the
    // protected files/full doc, so log it instead of failing silently.
    console.error('[sample-book] files/full lookup failed for', bookId, '-', err.message);
  }
  if (book && book.pdfUrl) return book.pdfUrl;
  return null;
}

const json = (res, code, body, headers) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (headers) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.end(JSON.stringify(body));
};

module.exports = async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = new URL(req.url, `${proto}://${host}`);
  const id = url.searchParams.get('id');
  const wantMeta = url.searchParams.get('meta') === '1';
  const token = url.searchParams.get('token') || null;
  const uid = url.searchParams.get('uid') || null;
  const exp = url.searchParams.get('exp') || null;
  const sig = url.searchParams.get('sig') || null;

  if (!id) return json(res, 400, { error: 'missing id' });

  const book = await fetchBookDoc(id);
  const fullUrl = await resolveFullUrl(id, book);
      if (!fullUrl) return json(res, 422, {
        error: 'book file unavailable',
        reason: 'no url on books/' + id + '/files/full, and no legacy pdfUrl on the book',
        hint: 'check SERVICE_ACCOUNT_KEY is set on this deployment'
      });

  const isEpub = isEpubBook(book, fullUrl);

  // ---- determine the privilege tier ----
  // A valid signed uid (minted by a previous ?token= call) or a verified
  // Firebase ID token both count as "signed in" for the short-book slice.
  // signedUid is the identity the minted sample URL will be bound to; it must
  // be the VERIFIED uid, never the raw query param, so a sample URL cannot be
  // lifted from one account and replayed against an unbound uid.
  let signedIn = false;
  let signedUid = null;
  if (uid && verifySampleSig(id, uid, exp, sig, SECRET)) {
    signedIn = true;
    signedUid = uid;
  } else if (token && SECRET) {
    try {
      loadAdmin();
      const decoded = await loadAdmin().auth().verifyIdToken(token);
      if (decoded && decoded.uid) {
        signedIn = true;
        // keep the minted signature uid == decoded.uid; exp 30 min
        signedUid = decoded.uid;
      }
    } catch (err) { signedIn = false; }
  }

  // The built bytes only depend on the tier, but the meta response embeds a
  // uid-bound sampleUrl, so meta is cached per uid and file bytes per tier.
  const tierKey = `${id}|${isEpub ? 'e' : 'p'}|${signedIn ? 's' : 'g'}`;
  const cacheKey = tierKey;
  const metaKey = `${tierKey}|${signedIn ? signedUid : 'g'}`;

  // The sample body is entitlement-dependent: the same URL returns a different
  // number of pages depending on whether a token is present. It must therefore
  // never be stored as a year-long immutable public response - the browser
  // would then replay one visitor's truncated sample to everyone else, and a
  // single empty response got cached and reused for a whole year, which is what
  // surfaced as "Unexpected server response (204)" in the preview. Revalidate
  // cheaply with the ETag instead.
  const longCache = signedIn
    ? 'private, no-store'
    : 'private, max-age=0, must-revalidate';

  // ---- meta first (tells details.html everything it needs) ----
  if (wantMeta) {
    const cachedMeta = cacheGet(metaKey + '|m');
    if (cachedMeta) return json(res, 200, cachedMeta, { 'Cache-Control': 'private, no-store' });

    let fullBuffer;
    try {
      const r = await fetch(fullUrl);
      if (!r.ok) throw new Error('fetch failed ' + r.status);
      fullBuffer = Buffer.from(await r.arrayBuffer());
    } catch (err) {
      return json(res, 502, { error: 'book file fetch failed' });
    }

    const measured = await measureFile(isEpub, fullBuffer);
    const totalPages = measured.totalPages || 1;
    const previewPages = Math.min(previewSlice(totalPages, signedIn), totalPages);

    // Everyone may preview, so the meta endpoint must answer anonymous callers
    // too - it is the only place the real page count is measured, and refusing it
    // forced signed-out visitors (the ones worth converting) to fall back to the
    // stored document count. The sample itself is the truncated preview and is
    // not entitled content, so binding it to a uid is not required for access.
    // When a uid IS available we still mint a short-lived uid-bound URL, which
    // stops a preview URL being lifted from one account and replayed against
    // another, but its absence is not an error.
    let sampleUrl;
    if (signedIn && signedUid) {
      const signed = { uid: signedUid, exp: String(Date.now() + 30 * 60 * 1000), sig: null };
      signed.sig = sampleSig(id, signed.uid, signed.exp, SECRET);
      sampleUrl = buildSampleUrl(proto, host, id, signed);
    } else {
      sampleUrl = buildSampleUrl(proto, host, id, null);
    }

    const meta = { totalPages, previewPages, sampleUrl, format: isEpub ? 'epub' : 'pdf' };
    cachePut(metaKey + '|m', meta);
    return json(res, 200, meta, { 'Cache-Control': 'private, no-store' });
  }

  // ---- file mode ----
  const cached = cacheGet(cacheKey);
  if (cached) {
    // The ETag is scoped to this exact tier (and, when signed in, to this user),
    // so a conditional request can be answered with a cheap 304 instead of
    // resending the whole sample. longCache is must-revalidate, so the browser
    // revalidates every time and gets a 200 whenever the sample actually changed.
    const inm = String(req.headers['if-none-match'] || '');
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === cached.etag)) {
      res.statusCode = 304;
      res.setHeader('Cache-Control', longCache);
      res.setHeader('ETag', cached.etag);
      return res.end();
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', isEpub ? 'application/epub+zip' : 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="sample.${isEpub ? 'epub' : 'pdf'}"`);
    res.setHeader('Cache-Control', longCache);
    res.setHeader('ETag', cached.etag);
    return res.end(cached.buffer);
  }

  let fullBuffer;
  try {
    const r = await fetch(fullUrl);
    if (!r.ok) throw new Error('fetch failed ' + r.status);
    fullBuffer = Buffer.from(await r.arrayBuffer());
  } catch (err) {
    return json(res, 502, { error: 'book file fetch failed' });
  }

  let totalPages = 1;
  let sampleBuffer;
  try {
    if (isEpub) {
      totalPages = await epubSpineCount(fullBuffer);
      const result = await truncateEpub(fullBuffer, Math.min(previewSlice(totalPages, signedIn), totalPages));
      sampleBuffer = result.buffer;
    } else {
      totalPages = (await measureFile(isEpub, fullBuffer)).totalPages || 1;
      const keep = Math.min(previewSlice(totalPages, signedIn), totalPages);
      sampleBuffer = await truncatePdf(fullBuffer, keep);
    }
  } catch (err) {
    return json(res, 422, { error: 'sample build failed: ' + err.message });
  }

  const etag = require('crypto').createHash('sha256').update(sampleBuffer).digest('base64');
  cachePut(cacheKey, { buffer: sampleBuffer, etag });

  const inmFresh = String(req.headers['if-none-match'] || '');
  if (inmFresh.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    res.statusCode = 304;
    res.setHeader('Cache-Control', longCache);
    res.setHeader('ETag', etag);
    return res.end();
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', isEpub ? 'application/epub+zip' : 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="sample.${isEpub ? 'epub' : 'pdf'}"`);
  res.setHeader('Cache-Control', longCache);
  res.setHeader('ETag', etag);
  res.end(sampleBuffer);
};
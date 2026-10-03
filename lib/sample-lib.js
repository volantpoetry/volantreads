// ============================================================
// FILE: lib/sample-lib.js
// ============================================================
// Shared server-side logic for the /api/sample-book endpoint.
// Both the root (volantpoetry) and store1 (volantreads) Vercel
// projects require('./../lib/sample-lib.js') from their api
// functions, mirroring the store-admin.js pattern.
//
// Everything here is pure Node (no Firestore, no Cloudinary) so
// it can be unit-tested directly. The point of the module is to
// build TRULY truncated book samples: a preview visitor may only
// ever receive the first few pages/chapters of a book, and tampered
// URL parameters only ever re-serve that same short slice. The full
// file URL is never returned by anything in this module.
// ============================================================

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Preview slice rules (mirrors details.html's tier logic)
// ---------------------------------------------------------------------------
// <= 9 pages: guest keeps total-3, signed-in reader keeps total-4
// exactly 10: guest 8, signed-in 7
// 11+:       ceil(10%), at least 10
function previewSlice(totalPages, signedIn) {
  const n = Math.max(1, Math.floor(Number(totalPages) || 1));
  if (n <= 9) return Math.min(n, Math.max(n - (signedIn ? 4 : 3), 1));
  if (n === 10) return (signedIn ? 7 : 8);
  return Math.min(n, Math.max(Math.ceil(n * 0.1), 10));
}

// ---------------------------------------------------------------------------
// Sample URL signing. A signed-uid sample URL only authorises a LARGER
// SAMPLE - never the full book - and expires, so a shared link cannot be
// hoarded. Everything else degrades to the guest slice.
// ---------------------------------------------------------------------------
function sampleSig(id, uid, exp, secret) {
  return crypto.createHmac('sha256', String(secret || ''))
    .update(String(id) + '|' + String(uid) + '|' + String(exp || ''))
    .digest('hex');
}

function verifySampleSig(id, uid, exp, sig, secret) {
  if (!id || !uid || !exp || !sig || !secret) return false;
  const expected = sampleSig(id, uid, exp, secret);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > Date.now();
}

function buildSampleUrl(protocol, host, id, signed) {
  let url = `${protocol}://${host}/api/sample-book?id=${encodeURIComponent(id)}`;
  if (signed) {
    url += `&uid=${encodeURIComponent(signed.uid)}&exp=${encodeURIComponent(signed.exp)}&sig=${encodeURIComponent(signed.sig)}`;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Format sniffing. The same rule the clients use: bookFormat field wins,
// then the file extension.
// ---------------------------------------------------------------------------
function isEpubBook(book, fullUrl) {
  const fmt = String((book && book.bookFormat) || '').toLowerCase();
  if (fmt === 'epub') return true;
  if (fmt === 'pdf') return false;
  return /\.epub(\?|#|$)/i.test(String(fullUrl || (book && book.pdfUrl) || ''));
}

// ---------------------------------------------------------------------------
// PDF truncation (pdf-lib). The caller passes the number of pages to KEEP.
// ---------------------------------------------------------------------------
async function pdfPageCount(buffer) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}

async function truncatePdf(buffer, keepPages) {
  const { PDFDocument } = require('pdf-lib');
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const count = src.getPageCount();
  const keep = Math.max(0, Math.min(Math.floor(keepPages) || 0, count));
  if (keep < 1) throw new Error('sample-pdf: no pages to keep');
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, Array.from({ length: keep }, (_, i) => i));
  pages.forEach((p) => out.addPage(p));
  const bytes = await out.save();
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// EPUB truncation (jszip). Keeps the first `keepChapters` spine items plus
// the cover, every CSS/font, and any image actually referenced by a kept
// document. content.opf is rewritten to the kept manifest/spine, out-of-slice
// nav/toc files are dropped, and everything else is removed from the zip so
// only the sample's own bytes exist in the re-packed EPUB.
// ---------------------------------------------------------------------------

function posixDir(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function posixJoin(base, rel) {
  const parts = [];
  for (const seg of (base ? base + '/' + rel : rel).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function parseOpf(opfXml) {
  const manifest = [];
  const spine = [];
  const reItem = /<item\b([^>]*)\/?>/g;
  const reRef = /<itemref\b([^>]*)\/?>/g;
  const grab = (attrs, name) => {
    const m = new RegExp('\\b' + name + '="([^"]*)"').exec(attrs);
    return m ? m[1] : '';
  };
  let m;
  while ((m = reItem.exec(opfXml))) {
    const attrs = m[1];
    manifest.push({ id: grab(attrs, 'id'), href: grab(attrs, 'href'), mediaType: grab(attrs, 'media-type'), properties: grab(attrs, 'properties') });
  }
  while ((m = reRef.exec(opfXml))) {
    spine.push({ idref: grab(m[1], 'idref'), linear: grab(m[1], 'linear') || 'yes' });
  }
  return { manifest, spine };
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function referencedPaths(html, baseDir) {
  const paths = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (!raw || /^[a-z]+:|^data:|^#|^javascript:/i.test(raw)) continue;
    paths.add(posixJoin(baseDir, raw.split(/[?#]/)[0]));
  }
  return paths;
}

async function epubSpineCount(buffer) {
  const meta = await epubMeta(buffer);
  return meta.spineCount;
}

async function epubMeta(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  return _epubParse(zip, false);
}

async function _epubParse(zip, truncate, keepChapters) {
  const containerEntry = zip.file('META-INF/container.xml');
  if (!containerEntry) throw new Error('sample-epub: missing META-INF/container.xml');
  const containerXml = await containerEntry.async('string');
  const rootMatch = /full-path\s*=\s*"([^"]+)"/.exec(containerXml);
  if (!rootMatch) throw new Error('sample-epub: no rootfile in container.xml');
  const opfPath = rootMatch[1];
  const opfEntry = zip.file(opfPath);
  if (!opfEntry) throw new Error('sample-epub: missing OPF at ' + opfPath);
  const opfXml = await opfEntry.async('string');
  const baseDir = posixDir(opfPath);
  const { manifest, spine } = parseOpf(opfXml);

  if (!truncate) {
    return {
      format: 'epub',
      spineCount: spine.length,
      spineHrefs: spine.map((ref) => {
        const item = manifest.find((it) => it.id === ref.idref);
        return item ? item.href : '';
      })
    };
  }

  const keep = Math.max(0, Math.min(Math.floor(keepChapters) || 0, spine.length));
  if (keep < 1) throw new Error('sample-epub: no spine items to keep');
  const JSZip = require('jszip');

  const keepIds = [];
  const keptHrefs = [];
  const keptFiles = new Set();
  const referenced = new Set();

  for (let i = 0; i < keep; i++) {
    const idref = spine[i].idref;
    keepIds.push(idref);
    const item = manifest.find((it) => it.id === idref);
    if (!item) continue;
    const abs = posixJoin(baseDir, item.href.split(/[?#]/)[0]);
    keptHrefs.push(abs);
    keptFiles.add(abs);
    const entry = zip.file(abs);
    if (entry) {
      try {
        const html = await entry.async('string');
        for (const p of referencedPaths(html, posixDir(abs))) referenced.add(p);
      } catch (err) { /* keep going without referenced assets */ }
    }
  }

  const keepSetForFiles = new Set(keptFiles);

  for (const item of manifest) {
    const abs = posixJoin(baseDir, item.href.split(/[?#]/)[0]);
    const isCover = /cover/i.test(item.properties);
    const isCss = /text\/css/i.test(item.mediaType);
    const isFont = /font|opentype|truetype|woff/i.test(item.mediaType);
    const isImage = /^image\//i.test(item.mediaType);
    const isNav = /nav/i.test(item.properties);
    const inSlice = keptHrefs.indexOf(abs) !== -1;
    if (inSlice) { keepSetForFiles.add(abs); continue; }
    if (isCover || isCss || isFont) { keepSetForFiles.add(abs); continue; }
    if (isImage && referenced.has(abs)) { keepSetForFiles.add(abs); continue; }
    if (isImage && isCover) { keepSetForFiles.add(abs); continue; }
    if (!isNav && referenced.has(abs)) { keepSetForFiles.add(abs); continue; }
  }

  keepSetForFiles.add('META-INF/container.xml');
  keepSetForFiles.add('mimetype');
  keepSetForFiles.add(opfPath);

  const keepManifest = [];
  for (const item of manifest) {
    const abs = posixJoin(baseDir, item.href.split(/[?#]/)[0]);
    if (keepSetForFiles.has(abs)) {
      keepManifest.push({ id: item.id, href: item.href, mediaType: item.mediaType, properties: item.properties });
    }
  }

  const keepSpine = [];
  for (let i = 0; i < keep; i++) {
    const idref = keepIds[i];
    const item = manifest.find((it) => it.id === idref);
    if (item) {
      const abs = posixJoin(baseDir, item.href.split(/[?#]/)[0]);
      if (keepSetForFiles.has(abs)) keepSpine.push({ idref });
    }
  }

  // Rebuild the <package> element, guaranteeing the OPF default namespace is
  // declared. Historically xmlns= was prepended unconditionally, so any book
  // that already declared it ended up with a second, empty xmlns attribute
  // ("<package xmlns=... xmlns=... version=2.0>"). That makes the default
  // namespace ambiguous: epub.js's OPF parser then finds no metadata and
  // openPackaging rejects with "No Metadata Found", leaving the preview blank
  // even though the zip itself unpacked fine. Keep the namespace only once.
  const origPackage = /<package\b([^>]*)>/.exec(opfXml);
  let packageTag;
  if (!origPackage) {
    packageTag = '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">';
  } else {
    const OPF_NS = 'http://www.idpf.org/2007/opf';
    // Drop every existing OPF xmlns declaration, then declare it exactly once
    // in front of the remaining attributes.
    const rest = origPackage[1]
      .replace(new RegExp('\\s*xmlns\\s*=\\s*["\']' + OPF_NS.replace(/[/.]/g, (c) => '\\' + c) + '["\']', 'g'), '')
      .trim();
    packageTag = `<package xmlns="${OPF_NS}"${rest ? ' ' + rest : ''}>`;
  }
  // The metadata block is reused verbatim, but a self-closing or namespaced
  // <metadata> must still yield usable inner content for the new document.
  const metadataMatch = /<metadata\b[^>]*>([\s\S]*?)<\/metadata>/.exec(opfXml);
  const metadataInner = metadataMatch
    ? metadataMatch[1].trim()
    : '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Sample</dc:title>';

  const esc = (s) => decodeXmlEntities(s);
  const itemLines = keepManifest.map((it) =>
    `    <item id="${esc(it.id)}" href="${esc(it.href)}" media-type="${esc(it.mediaType)}"${it.properties ? ` properties="${esc(it.properties)}"` : ''} />`
  ).join('\n');
  const spineLines = keepSpine.map((it) => `    <itemref idref="${esc(it.idref)}" />`).join('\n');

  const newOpf = `${packageTag}\n  <metadata>\n${metadataInner.replace(/^/gm, '    ')}\n  </metadata>\n  <manifest>\n${itemLines}\n  </manifest>\n  <spine>\n${spineLines}\n  </spine>\n</package>\n`;

  const out = new JSZip();
  out.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  const zipEntryNames = Object.keys(zip.files);
  const keptNames = zipEntryNames.filter((name) => {
    if (keepSetForFiles.has(name)) return true;
    return false;
  });
  keptNames.sort();
  for (const name of keptNames) {
    if (name === 'mimetype') continue;
    if (name === opfPath) { out.file(name, newOpf); continue; }
    const entry = zip.file(name);
    if (!entry || entry.dir) continue;
    const bytes = await entry.async('uint8array');
    out.file(name, bytes, { compression: 'DEFLATE' });
  }

  const buf = await out.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  return { format: 'epub', spineCount: spine.length, keptChapters: keep, buffer: Buffer.from(buf) };
}

async function truncateEpub(buffer, keepChapters) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const result = await _epubParse(zip, true, keepChapters);
  return result;
}

// ---------------------------------------------------------------------------
// The API handler builds meta from the FULL file's cheap measures, because
// meta must know the real total so the client can show accurate percentages.
// ---------------------------------------------------------------------------
async function measureFile(isEpub, buffer) {
  if (isEpub) {
    const meta = await epubMeta(buffer);
    return { totalPages: meta.spineCount, ok: true };
  }
  try {
    const n = await pdfPageCount(buffer);
    return { totalPages: n, ok: true };
  } catch (err) {
    return { totalPages: 1, ok: false };
  }
}

module.exports = {
  previewSlice,
  sampleSig,
  verifySampleSig,
  buildSampleUrl,
  isEpubBook,
  pdfPageCount,
  truncatePdf,
  epubMeta,
  epubSpineCount,
  truncateEpub,
  measureFile
};
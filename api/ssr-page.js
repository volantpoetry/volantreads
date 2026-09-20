// ============================================================
// FILE: store1/api/ssr-page.js  (volantreads.vercel.app)
// ============================================================
// Server-side rendering + structured data for the whole SEO surface:
//   /details?id=<id>                    book detail (Book schema, per-book title/meta)
//   /browse                             all approved books
//   /browse/<genre>                     genre listing (CollectionPage + ItemList)
//   /browse/<genre>/<year>              genre + year
//   /browse/tag/<slug>                  keyword/tag listing (seo-keywords.js pool)
//   /collections/new-releases           newest approved
//   /collections/preorders              preorder books
//   /author/<slug>                      author page (Person schema)
//   /best-ghanaian-poetry-books         listicle (seo-listicles.js)
//   /search                             search landing + results
//   /sitemap.xml                        dynamic XML sitemap
//   /robots.txt                         robots (mirrors live + new sections)
//
// Reached via store1/middleware.js (edge). The middleware forwards the
// ORIGINAL request path in the __path query param so this function can
// route even though all proxied requests hit /api/ssr-page.
//
// Books are fetched from the public Firestore REST API (keyless, rules
// allow reads), with the Firebase Admin SDK as the first, optional path.
// ============================================================

const fs = require('fs');
const path = require('path');
const { loadAdmin, db } = require('./../lib/store-admin.js');
const {
  matchBook,
  expandedKeywords,
  normalizeGenre,
  findTag,
  KEYWORD_POOL
} = require('./../seo-keywords.js');
const LISTICLES = require('./../seo-listicles.js');

const CLOUD_NAME = 'dzoq4pgjn';
const PROJECT_ID = 'silent-depth';

const TARGET = '<script type="application/ld+json" id="structured-data-book"></script>';

const PAGE_CACHE = 'public, s-maxage=600, stale-while-revalidate=86400';
const LONG_CACHE = 'public, s-maxage=3600, stale-while-revalidate=86400';

const firestoreDocsUrl = () =>
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/books?pageSize=1000`;

// ===== Firestore REST (proto JSON) -> plain object =====
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
  if ('mapValue' in v) return decodeProtoMap(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeProtoValue);
  return null;
}

function decodeProtoMap(fields) {
  const out = {};
  for (const key of Object.keys(fields)) out[key] = decodeProtoValue(fields[key]);
  return out;
}

let detailsHtml = null;
function loadDetailsHtml() {
  if (detailsHtml === null) {
    try {
      detailsHtml = fs.readFileSync(path.join(process.cwd(), 'details.html'), 'utf8');
    } catch (err) {
      detailsHtml = '';
    }
  }
  return detailsHtml;
}

async function fetchAllBooks() {
  // Path 1: Firebase Admin SDK (service account configured on Vercel).
  try {
    loadAdmin();
    const snap = await db().collection('books').where('status', '==', 'approved').get();
    if (snap.size > 0) {
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    }
  } catch (err) {
    // fall through to the public REST endpoint
  }

  // Path 2: keyless public Firestore REST (rules allow public reads).
  try {
    const res = await fetch(firestoreDocsUrl());
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.documents) return null;
    return (body.documents || [])
      .map((d) => ({ ...decodeProtoMap(d.fields), id: d.name.split('/').pop() }))
      .filter((b) => b.status === 'approved');
  } catch (err) {
    return null;
  }
}

// ===== value helpers =====
function formatDate(value) {
  if (value === undefined || value === null) return null;
  try {
    let date;
    if (typeof value.toDate === 'function') {
      date = value.toDate();
    } else if (value instanceof Date) {
      date = value;
    } else if (typeof value === 'number') {
      const ms = value < 1e12 ? value * 1000 : value;
      date = new Date(ms);
    } else if (typeof value === 'string' && value.trim() !== '') {
      date = new Date(value);
    } else {
      return null;
    }
    if (isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  } catch (err) {
    return null;
  }
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function pickImage(data) {
  if (data.imageUrl) return data.imageUrl;
  if (data.coverUrl) return data.coverUrl;
  if (data.cloudinaryImageId) {
    return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/f_auto,q_auto/${data.cloudinaryImageId}`;
  }
  return null;
}

function synopsisOf(book) {
  const raw = book.synopsis || book.summary || book.description || '';
  return raw.replace(/\s+/g, ' ').trim();
}

function metaDescriptionOf(text, fallback) {
  const clean = synopsisOf({ synopsis: text }) || fallback || '';
  const noWrap = clean.replace(/\n+/g, ' ');
  return noWrap.length > 152 ? noWrap.slice(0, 152).trim() + '…' : noWrap;
}

function priceOf(book) {
  const amount =
    book.pricing && book.pricing.amount !== undefined && book.pricing.amount !== null
      ? book.pricing.amount
      : book.price;
  const currency =
    (book.pricing && book.pricing.currency) || book.currency || 'GHS';
  return { amount, currency };
}

function pubYear(book) {
  const d = formatDate(book.publishDate || book.preorderReleaseDate || book.approvedAt);
  return d ? d.slice(0, 4) : '';
}

function authorSlug(book) {
  return slugify(book.authorName || book.author || 'Unknown');
}

function sortByApprovedDesc(books) {
  return [...books].sort((a, b) => {
    const x = formatDate(a.approvedAt || a.submittedAt) || '';
    const y = formatDate(b.approvedAt || b.submittedAt) || '';
    return y.localeCompare(x);
  });
}

function sortByPubDesc(books) {
  return [...books].sort((a, b) =>
    (formatDate(b.publishDate || b.preorderReleaseDate) || '').localeCompare(
      formatDate(a.publishDate || a.preorderReleaseDate) || ''
    )
  );
}

// ===== Schema.org builders =====
function buildBookSchema(book, pageUrl) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Book',
    '@id': pageUrl,
    url: pageUrl,
    name: book.title,
    bookFormat: 'https://schema.org/EBook',
    availability: 'https://schema.org/InStock',
    inLanguage: book.languageCode || book.language || 'en',
    publisher: {
      '@type': 'Organization',
      name: book.publisherName || 'Volant Foundry',
      url: 'https://volantfoundry.vercel.app/'
    }
  };

  const image = pickImage(book);
  if (image) schema.image = image;

  const author = { '@type': 'Person', name: book.authorName || book.author || 'Anonymous' };
  if (book.authorPoetryProfile) author.sameAs = book.authorPoetryProfile;
  schema.author = author;

  const datePublished = formatDate(book.publishDate || book.preorderReleaseDate || book.approvedAt);
  if (datePublished) schema.datePublished = datePublished;

  const description = synopsisOf(book);
  if (description) schema.description = description;

  if (book.isbn13 || (book.isbn && String(book.isbn).trim())) {
    schema.isbn = book.isbn13 || book.isbn;
  }

  if (book.genre) schema.genre = book.genre;

  if (Number(book.pageCount) > 0) schema.numberOfPages = Number(book.pageCount);

  const keywords = expandedKeywords(book);
  if (keywords.length > 0) schema.keywords = keywords.join(', ');

  const ratingValue = book.ratingValue || (book.rating && book.rating.value);
  const reviewCount = book.reviewCount || (book.rating && book.rating.count);
  if (Number(ratingValue) > 0 && Number(reviewCount) > 0) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(ratingValue),
      reviewCount: Number(reviewCount)
    };
  }

  const { amount, currency } = priceOf(book);
  if (amount !== undefined && amount !== null && amount !== '') {
    schema.offers = {
      '@type': 'Offer',
      price: amount,
      priceCurrency: currency
    };
  }

  return schema;
}

// ===== HTML layout =====
const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #faf7f2; color: #3e362e; line-height: 1.6; }
  a { color: #7a3b1e; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .topbar { background: #fff; border-bottom: 1px solid #ece5da; }
  .topbar-inner { max-width: 1160px; margin: 0 auto; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .brand { font-family: 'Playfair Display', serif; font-size: 1.5rem; font-weight: 700; color: #3e362e; }
  .brand span { color: #b76e4b; }
  .nav a { margin-left: 18px; font-size: 0.9rem; color: #5d5244; }
  .nav a:hover { color: #7a3b1e; text-decoration: none; border-bottom: 2px solid #b76e4b; padding-bottom: 2px; }
  main { max-width: 1160px; margin: 0 auto; padding: 36px 24px 60px; }
  .crumbs { font-size: 0.78rem; color: #8a7f70; margin-bottom: 18px; }
  .crumbs a { color: #8a7f70; }
  .page-title { font-family: 'Playfair Display', serif; font-size: 2rem; font-weight: 700; margin-bottom: 6px; }
  .page-sub { color: #6f6455; margin-bottom: 26px; font-size: 0.98rem; }
  .intro { color: #4c443a; margin-bottom: 28px; max-width: 820px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 26px; }
  .card { background: #fff; border: 1px solid #ece5da; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
  .card img { width: 100%; aspect-ratio: 2/3; object-fit: cover; background: #eee8dd; }
  .card-body { padding: 14px 16px 18px; display: flex; flex-direction: column; flex: 1; }
  .card h3 { font-family: 'Playfair Display', serif; font-size: 1.05rem; line-height: 1.3; }
  .card h3 a { color: #3e362e; }
  .card h3 a:hover { text-decoration: none; color: #7a3b1e; }
  .card .author { font-size: 0.82rem; color: #8a7f70; margin-top: 3px; }
  .card .meta { margin-top: 10px; font-size: 0.82rem; color: #5d5244; display: flex; justify-content: space-between; }
  .price { font-weight: 600; color: #7a3b1e; }
  .free { color: #1f7a3d; font-weight: 700; }
  .count { font-size: 0.85rem; color: #8a7f70; margin-bottom: 24px; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0 8px; }
  .chip { background: #fff; border: 1px solid #e0d7c9; color: #5d5244; padding: 7px 15px; border-radius: 999px; font-size: 0.85rem; }
  .chip:hover { border-color: #b76e4b; color: #7a3b1e; text-decoration: none; }
  .rank { display: flex; gap: 18px; align-items: flex-start; padding: 18px; background: #fff; border: 1px solid #ece5da; border-radius: 12px; margin-bottom: 18px; }
  .rank .num { font-family: 'Playfair Display', serif; font-size: 1.6rem; color: #b76e4b; min-width: 40px; }
  .rank h3 { font-family: 'Playfair Display', serif; font-size: 1.15rem; }
  .rank .blurb { font-size: 0.92rem; color: #4c443a; margin-top: 6px; }
  .searchbox { display: flex; gap: 10px; max-width: 560px; margin: 8px 0 22px; }
  .searchbox input { flex: 1; padding: 12px 16px; border: 1px solid #d8cebe; border-radius: 8px; font-size: 0.95rem; font-family: inherit; }
  .searchbox button { background: #3e362e; color: #fff; border: 0; border-radius: 8px; padding: 0 22px; cursor: pointer; font-weight: 600; }
  .listicle-blurb { font-size: 1rem; color: #4c443a; }
  footer { border-top: 1px solid #ece5da; background: #fff; margin-top: 40px; }
  .footer-inner { max-width: 1160px; margin: 0 auto; padding: 26px 24px; display: flex; flex-wrap: wrap; gap: 14px; justify-content: space-between; font-size: 0.8rem; color: #8a7f70; }
  .footer-inner a { color: #8a7f70; margin-left: 12px; }
  @media (max-width: 640px) { .nav a { margin-left: 10px; } main { padding: 24px 16px 48px; } }
`;

function layout(opts) {
  const {
    title,
    metaDescription,
    canonical,
    h1,
    sub,
    crumbs,
    intro,
    schema,
    bodyHtml,
    noindex
  } = opts;

  const schemaBlock = (schema ? (Array.isArray(schema) ? schema : [schema]) : [])
    .map((s) => `<script type="application/ld+json">${JSON.stringify(s).replace(/</g, '\\u003c')}</script>`)
    .join('\n');

  const crumbHtml = crumbs && crumbs.length
    ? `<nav class="crumbs">${crumbs.map((c) => (c.href ? `<a href="${c.href}">${c.label}</a>` : `<span>${c.label}</span>`)).join(' › ')}</nav>`
    : '';

  const introHtml = intro ? `<div class="intro">${intro}</div>` : '';
  const subHtml = sub ? `<p class="page-sub">${sub}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <meta name="description" content="${metaDescription}" />
  ${noindex ? '  <meta name="robots" content="noindex, nofollow" />\n' : ''}
  <link rel="canonical" href="${canonical}" />
  <link rel="sitemap" type="application/xml" title="Sitemap" href="https://volantreads.vercel.app/sitemap.xml" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${metaDescription}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:site_name" content="Volant Reads" />
  <link rel="icon" type="image/png" href="https://volantpoetry.vercel.app/images/volant-reads-favicon.png" />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <style>${BASE_CSS}</style>
${schemaBlock}
</head>
<body>
  <div class="topbar"><div class="topbar-inner">
    <a class="brand" href="/">Volant<span>Reads</span></a>
    <nav class="nav">
      <a href="/browse">Browse Books</a>
      <a href="/collections/new-releases">New Releases</a>
      <a href="/collections/preorders">Preorders</a>
      <a href="/best-ghanaian-poetry-books">Best Poetry</a>
      <a href="/search">Search</a>
    </nav>
  </div></div>
  <main>
    ${crumbHtml}
    <h1 class="page-title">${h1}</h1>
    ${subHtml}
    ${introHtml}
    ${bodyHtml}
  </main>
  <footer>
    <div class="footer-inner">
      <span>© ${new Date().getUTCFullYear()} Volant Reads · A Volant Foundry imprint
        <a href="/faq.html">FAQ</a><a href="/refund.html">Refund</a><a href="/submit.html">Publish With Us</a>
        <a href="https://volantfoundry.vercel.app/">Volant Foundry</a>
      </span>
    </div>
  </footer>
</body>
</html>`;
}

// ===== HTML fragments =====
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tagFromBook(book) {
  const year = pubYear(book);
  const { amount } = priceOf(book);
  const isFree = amount === 0;
  return `
    <div class="card">
      <a href="/details?id=${encodeURIComponent(book.id)}">
        <img src="${esc(pickImage(book) || 'https://volantpoetry.vercel.app/images/volant-reads-favicon.png')}" alt="${esc(book.title)}" loading="lazy" />
      </a>
      <div class="card-body">
        <h3><a href="/details?id=${encodeURIComponent(book.id)}">${esc(book.title)}</a></h3>
        <div class="author">${esc(book.authorName || book.author || '')}</div>
        <div class="meta">
          <span>${year} · ${esc(book.genre || '')}</span>
          <span class="${isFree ? 'free' : 'price'}">${isFree ? 'Free' : `GH₵ ${amount}`}</span>
        </div>
      </div>
    </div>`;
}

function bookGrid(books) {
  if (!books || books.length === 0) return '<p class="page-sub">No books here yet — check back soon.</p>';
  return `<div class="grid">${books.map(tagFromBook).join('\n')}</div>`;
}

function crumbHome(label) {
  return [{ label: 'Home', href: '/' }, { label }];
}

// ===== pages =====
function renderDetails(book, host, protocol) {
  const html = loadDetailsHtml();
  if (!html) {
    return { status: 500, body: 'details.html not bundled with this function.' };
  }

  const id = String(book.id);
  const pageUrl = `${protocol}://${host}/details?id=${encodeURIComponent(id)}`;
  const title = `${book.title}${book.subtitle ? ' — ' + book.subtitle : ''} by ${book.authorName || 'Volant Reads'}`;
  const description = metaDescriptionOf(
    book.synopsis || '',
    `Buy ${book.title} by ${book.authorName || 'author'} on Volant Reads — an instant ${book.genre || 'ebook'} download in GHS.`
  );
  const json = JSON.stringify(buildBookSchema(book, pageUrl)).replace(/<\/script/gi, '<\\/script');

  const metaBlock = `  <title>${esc(title)} | Volant Reads</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${esc(pageUrl)}" />
  <link rel="sitemap" type="application/xml" title="Sitemap" href="https://volantreads.vercel.app/sitemap.xml" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:type" content="book" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:image" content="${esc(pickImage(book) || '')}" />`;

  let out = html.replace('<title>Volant Reads · Book Details</title>', metaBlock);
  out = out.replace(
    TARGET,
    `<script type="application/ld+json" id="structured-data-book">\n${json}\n</script>`
  );
  return { status: 200, body: out };
}

function renderBrowse(books, host, protocol) {
  const canonical = `${protocol}://${host}/browse`;
  const sorted = sortByApprovedDesc(books);
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Browse Books — Volant Reads',
    url: canonical,
    mainEntity: {
      '@type': 'ItemList',
      name: 'All books on Volant Reads',
      numberOfItems: sorted.length,
      itemListElement: sorted.map((b, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: { '@type': 'Book', name: b.title, url: `${protocol}://${host}/details?id=${encodeURIComponent(b.id)}` }
      }))
    }
  };
  const body = `
    <p class="count">${sorted.length} book${sorted.length === 1 ? '' : 's'} available</p>
    ${chipsFor(books, host, protocol)}
    ${bookGrid(sorted)}`;
  return {
    status: 200,
    body: layout({
      title: 'Browse Books | Volant Reads',
      metaDescription: 'Browse every book on Volant Reads — poetry, prose, fiction and more from Ghanaian authors, downloadable as instant ebooks.',
      canonical,
      h1: 'Browse Books',
      crumbs: crumbHome('Browse'),
      schema,
      bodyHtml: body
    })
  };
}

function chipsFor(books, host, protocol) {
  const tags = KEYWORD_POOL.filter((t) => books.some((b) => matchBook(b, t)));
  if (tags.length === 0) return '';
  const chips = tags
    .slice(0, 10)
    .map((t) => `<a class="chip" href="/browse/tag/${t.slug}">${esc(t.label)}</a>`)
    .join('\n');
  return `<div class="chips">${chips}</div>`;
}

function renderGenre(books, genreSlug, year, host, protocol) {
  const genre = normalizeGenre(genreSlug === 'prose' ? 'Prose' : genreSlug);
  let list = books.filter((b) => normalizeGenre(b.genre).slug === genre.slug);
  if (list.length === 0) return null;

  let canonicalPath = `/browse/${genre.slug}`;
  if (year) {
    const y = String(year).trim();
    list = list.filter((b) => pubYear(b) === y);
    if (list.length === 0) return null;
    canonicalPath += `/${y}`;
  }

  const sorted = sortByPubDesc(list);
  const canonical = `${protocol}://${host}${canonicalPath}`;
  const yearLabel = year ? ` Published in ${year}` : '';
  const title = year
    ? `${genre.label} Books Published in ${year} | Volant Reads`
    : `${genre.label} Books Online | Volant Reads`;

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${genre.label}${yearLabel}`,
    url: canonical,
    mainEntity: {
      '@type': 'ItemList',
      name: `${genre.label} books${yearLabel.toLowerCase()} on Volant Reads`,
      numberOfItems: sorted.length,
      itemListElement: sorted.map((b, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: { '@type': 'Book', name: b.title, url: `${protocol}://${host}/details?id=${encodeURIComponent(b.id)}` }
      }))
    }
  };

  const crumbs = [ { label: 'Home', href: '/' }, { label: 'Browse', href: '/browse' }, { label: genre.label } ];

  const yearNav = year
    ? `<p class="page-sub"><a href="/browse/${genre.slug}">All ${genre.label} books</a></p>`
    : '';

  const body = `
    <p class="count">${sorted.length} book${sorted.length === 1 ? '' : 's'}
      ${year ? `published in ${year}` : ''}</p>
    ${yearNav}
    ${chipsFor(list, host, protocol)}
    ${bookGrid(sorted)}`;

  return {
    status: 200,
    body: layout({
      title,
      metaDescription: `${genre.blurb} ${sorted.length} ${genre.label.toLowerCase()} book${sorted.length === 1 ? '' : 's'}${year ? ` from ${year}` : ''} on Volant Reads, ready to read in minutes.`,
      canonical,
      h1: genre.label,
      sub: `${genre.blurb}${yearLabel.toLowerCase()}`,
      crumbs,
      schema,
      intro: genre.blurb
    }),
    genre
  };
}

function renderTag(books, slug, host, protocol) {
  const tag = findTag(slug);
  if (!tag) return null;
  let list = books.filter((b) => matchBook(b, tag));
  if (list.length === 0) return null;

  const sorted = sortByApprovedDesc(list);
  const canonical = `${protocol}://${host}/browse/tag/${tag.slug}`;
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: tag.label,
    url: canonical,
    mainEntity: {
      '@type': 'ItemList',
      name: `${tag.label} — books on Volant Reads`,
      numberOfItems: sorted.length,
      itemListElement: sorted.map((b, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: { '@type': 'Book', name: b.title, url: `${protocol}://${host}/details?id=${encodeURIComponent(b.id)}` }
      }))
    }
  };

  return {
    status: 200,
    body: layout({
      title: tag.title,
      metaDescription: `${tag.label} — ${sorted.length} book${sorted.length === 1 ? '' : 's'} on Volant Reads, including ${sorted.slice(0, 3).map((b) => b.title).join(', ')}.`,
      canonical,
      h1: tag.label,
      crumbs: [ { label: 'Home', href: '/' }, { label: 'Browse', href: '/browse' }, { label: tag.label } ],
      schema,
      intro: `Books tagged ${tag.label.toLowerCase()} on Volant Reads — instant ebooks from Ghanaian authors.`,
      bodyHtml: `<p class="count">${sorted.length} book${sorted.length === 1 ? '' : 's'}</p>${bookGrid(sorted)}`
    }),
    tag
  };
}

function renderCollection(books, key, host, protocol) {
  let list;
  let title;
  let h1;
  let metaDescription;
  let intro;

  if (key === 'new-releases') {
    list = sortByApprovedDesc(books);
    title = 'New Book Releases | Volant Reads';
    h1 = 'New Releases';
    metaDescription = 'The newest books on Volant Reads — fresh poetry and prose from Ghanaian authors, ready to download.';
    intro = 'The latest additions to the Volant Reads shelf.';
  } else if (key === 'preorders') {
    list = books.filter((b) => b.preorder === true);
    title = 'Preorder Books | Volant Reads';
    h1 = 'Preorder Now';
    metaDescription = 'Preorder upcoming books on Volant Reads and be first in line when they release.';
    intro = 'Upcoming books you can reserve before they release, at a preorder price.';
  } else {
    return null;
  }

  if (list.length === 0) return null;

  const canonical = `${protocol}://${host}/collections/${key}`;
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: h1,
    url: canonical,
    mainEntity: {
      '@type': 'ItemList',
      name: h1,
      numberOfItems: list.length,
      itemListElement: list.map((b, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: { '@type': 'Book', name: b.title, url: `${protocol}://${host}/details?id=${encodeURIComponent(b.id)}` }
      }))
    }
  };

  return {
    status: 200,
    body: layout({
      title,
      metaDescription,
      canonical,
      h1,
      crumbs: [ { label: 'Home', href: '/' }, { label: h1 } ],
      schema,
      intro,
      bodyHtml: bookGrid(list)
    })
  };
}

function renderAuthor(books, slug, host, protocol) {
  let author = null;
  let list = books.filter((b) => authorSlug(b) === slug);
  if (list.length === 0) {
    // tolerate trailing "-books" style slugs by exact author name match
    const matched = books.find((b) => slugify(b.authorName || b.author) === slug || slugify(b.authorName || b.author) === slug.replace(/-books$/, ''));
    if (matched) list = books.filter((b) => (b.authorName || b.author) === (matched.authorName || matched.author));
  }
  if (list.length === 0) return null;
  author = list[0];

  const name = author.authorName || author.author || 'Unknown';
  const canonical = `${protocol}://${host}/author/${slug}`;
  const bio = author.authorBio || `${name} is a ${(author.country || 'Ghanaian author')} on Volant Reads.`;

  const sorted = sortByPubDesc(list);
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Author',
    name,
    url: canonical,
    description: bio,
    sameAs: author.authorPoetryProfile ? [author.authorPoetryProfile] : undefined
  };
  if (schema.sameAs === undefined) delete schema.sameAs;

  return {
    status: 200,
    body: layout({
      title: `${name} — Books | Volant Reads`,
      metaDescription: metaDescriptionOf(bio, `${name}'s books on Volant Reads`),
      canonical,
      h1: `Books by ${name}`,
      crumbs: [ { label: 'Home', href: '/' }, { label: 'Authors', href: '/browse' }, { label: name } ],
      schema,
      intro: esc(bio) + (sorted.length > 1 ? ` Here are ${sorted.length} of their books.` : ''),
      bodyHtml: `<p class="count">${sorted.length} book${sorted.length === 1 ? '' : 's'} by ${esc(name)}</p>${bookGrid(sorted)}`
    })
  };
}

function renderListicle(books, slug, host, protocol) {
  const entry = LISTICLES.find((l) => l.slug === slug);
  if (!entry) return null;

  let list;
  if (entry.books && entry.books.length > 0) {
    list = entry.books
      .map((id) => books.find((b) => b.id === id))
      .filter(Boolean);
  }
  if (!list || list.length === 0) {
    list = books.filter((b) => {
      if (entry.filters && entry.filters.genre) {
        return normalizeGenre(b.genre).slug === normalizeGenre(entry.filters.genre).slug;
      }
      return true;
    });
  }
  list = list.length ? list : books;
  if (entry.sort === 'published') list = sortByPubDesc(list);

  if (list.length === 0) return null;

  const canonical = `${protocol}://${host}/${entry.slug}`;
  const rows = list
    .map((b, i) => {
      const blurb = synopsisOf(b).split(/[.!?\n]/)[0];
      return `
      <div class="rank">
        <div class="num">${i + 1}</div>
        <div>
          <h3><a href="/details?id=${encodeURIComponent(b.id)}">${esc(b.title)}</a></h3>
          <div class="page-sub" style="margin:4px 0 0;">${esc(b.authorName || '')}${b.subtitle ? ' — ' + esc(b.subtitle) : ''}</div>
          <p class="blurb">${esc(blurb)}</p>
        </div>
      </div>`;
    })
    .join('\n');

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    name: entry.h1,
    headline: entry.h1,
    description: entry.metaDescription,
    url: canonical,
    about: 'Ghanaian Poetry books',
    author: { '@type': 'Organization', name: 'Volant Reads', url: 'https://volantreads.vercel.app/' },
    publisher: { '@type': 'Organization', name: 'Volant Foundry', url: 'https://volantfoundry.vercel.app/' },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: list.length,
      itemListElement: list.map((b, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: { '@type': 'Book', name: b.title, url: `${protocol}://${host}/details?id=${encodeURIComponent(b.id)}` }
      }))
    }
  };

  return {
    status: 200,
    body: layout({
      title: entry.title,
      metaDescription: entry.metaDescription,
      canonical,
      h1: entry.h1,
      crumbs: [ { label: 'Home', href: '/' }, { label: entry.h1 } ],
      schema,
      intro: esc(entry.intro),
      bodyHtml: `<p class="listicle-blurb">${esc(entry.intro2 || '')}</p>\n${rows}`
    })
  };
}

function renderSearch(books, q, host, protocol) {
  const canonical = `${protocol}://${host}/search`;
  let results = null;

  if (q) {
    const needle = String(q).toLowerCase().trim();
    results = books.filter((b) => {
      const haystack = [
        b.title,
        b.subtitle,
        b.authorName,
        b.genre,
        b.country,
        b.synopsis
      ]
        .map((v) => String(v || '').toLowerCase())
        .join(' ');
      const kw = (Array.isArray(b.keywords) ? b.keywords : []).map((k) => String(k).toLowerCase()).join(' ');
      return haystack.includes(needle) || kw.includes(needle);
    });
  }

  const tags = KEYWORD_POOL.filter((t) => books.some((b) => matchBook(b, t)));
  const chips = tags
    .slice(0, 12)
    .map((t) => `<a class="chip" href="/browse/tag/${t.slug}">${esc(t.label)}</a>`)
    .join('\n');

  const resultsHtml = q
    ? `<p class="count">${results.length} result${results.length === 1 ? '' : 's'} for "${esc(q)}"</p>${bookGrid(results)}`
    : `<div class="chips">${chips}</div>`;

  return {
    status: 200,
    body: layout({
      title: q ? `Search: ${esc(q)} | Volant Reads` : 'Search Books | Volant Reads',
      metaDescription: q
        ? `Search results for ${esc(q)} on Volant Reads.`
        : 'Search the Volant Reads catalog — poetry, prose, fiction and more from Ghanaian authors.',
      canonical,
      h1: q ? `Results for "${esc(q)}"` : 'Search Books',
      crumbs: [ { label: 'Home', href: '/' }, { label: 'Search' } ],
      noindex: true,
      bodyHtml: `
        <form class="searchbox" action="/search" method="get">
          <input type="search" name="q" value="${esc(q || '')}" placeholder="Search titles, authors, themes…" />
          <button type="submit">Search</button>
        </form>
        ${resultsHtml}`
    })
  };
}

// ===== sitemap & robots =====
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSitemap(books, host, protocol) {
  const origin = `${protocol}://${host}`;
  const urls = [];

  const add = (loc, lastmod, priority) => {
    urls.push(`  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <lastmod>${lastmod || new Date().toISOString().slice(0, 10)}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${priority || '0.6'}</priority>\n  </url>`);
  };

  add(`${origin}/`, null, '1.0');
  ['submit.html', 'faq.html', 'refund.html', 'pwu.html'].forEach((p) => add(`${origin}/${p}`));

  add(`${origin}/browse`, null, '0.8');

  const genres = {};
  books.forEach((b) => {
    const g = normalizeGenre(b.genre).slug;
    genres[g] = genres[g] || { years: new Set() };
    const y = pubYear(b);
    if (y) genres[g].years.add(y);
  });
  Object.keys(genres).forEach((g) => {
    add(`${origin}/browse/${g}`, null, '0.7');
    genres[g].years.forEach((y) => add(`${origin}/browse/${g}/${y}`, null, '0.6'));
  });

  const tags = KEYWORD_POOL.filter((t) => books.some((b) => matchBook(b, t)));
  tags.forEach((t) => add(`${origin}/browse/tag/${t.slug}`, null, '0.6'));

  add(`${origin}/collections/new-releases`, null, '0.7');
  if (books.some((b) => b.preorder === true)) add(`${origin}/collections/preorders`, null, '0.6');

  const authors = new Set(books.map((b) => authorSlug(b)));
  authors.forEach((a) => add(`${origin}/author/${a}`, null, '0.7'));

  LISTICLES.forEach((l) => add(`${origin}/${l.slug}`, null, '0.8'));

  books.forEach((b) => {
    add(`${origin}/details?id=${encodeURIComponent(b.id)}`, formatDate(b.approvedAt || b.submittedAt), '0.8');
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function renderRobots() {
  return `# Robots.txt for Volant Reads
User-agent: *
Allow: /

# Root
Allow: /$
Allow: /index.html

# Store pages
Allow: /submit.html
Allow: /faq.html
Allow: /refund.html
Allow: /pwu.html

# SEO landing pages
Allow: /browse$
Allow: /browse/
Allow: /collections/
Allow: /author/
Allow: /best-ghanaian-poetry-books
Allow: /search
Allow: /details.html
Allow: /details

Allow: /sitemap.xml

# NOTE: Shared pages (about, contact, terms, privacy) live on
# volantpoetry.vercel.app/shared/* — not on this domain.

# Block admin and private pages
Disallow: /admin
Disallow: /dashboard
Disallow: /manage
Disallow: /login
Disallow: /signup
Disallow: /verify
Disallow: /reset
Disallow: /approvals.html
Disallow: /dashboard.html
Disallow: /shared/verify-email.html
Disallow: /shared/universal-login.html
Disallow: /shared/universal-signup.html
Disallow: /shared/users-reset.html
Disallow: /user-profile.html

# Block Google verification
Disallow: /google*.html

# Block non-HTML files
Disallow: /*.js$
Disallow: /*.css$
Disallow: /*.json$

# Block node_modules
Disallow: /node_modules/

# Block images
Disallow: /images/

# Block 404
Disallow: /404.html

Sitemap: https://volantreads.vercel.app/sitemap.xml
`;
}

// ===== router =====
module.exports = async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;

  const u = new URL(req.url, `${protocol}://${host}`);
  const params = u.searchParams;
  const realPath = params.get('__path') || u.pathname;
  const cleanPath = realPath.startsWith('/') ? realPath : '/' + realPath;

  const books = (await fetchAllBooks()) || [];

  const send = (status, body) => {
    res.status(status);
    res.end(body);
  };

  const setPageCache = () => res.setHeader('Cache-Control', PAGE_CACHE);
  const setLongCache = () => res.setHeader('Cache-Control', LONG_CACHE);

  // details
  if (cleanPath === '/details' || cleanPath === '/details.html') {
    const id = params.get('id');
    const book = id ? books.find((b) => b.id === id) : null;
    if (!book) {
      // unknown/hidden: serve the static page untouched (client fallback runs)
      const html = loadDetailsHtml();
      return html
        ? send(200, html)
        : send(500, 'Unable to render.');
    }
    const out = renderDetails(book, host, protocol);
    setPageCache();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return send(out.status, out.body);
  }

  // robots
  if (cleanPath === '/robots.txt') {
    setLongCache();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return send(200, renderRobots());
  }

  // sitemap
  if (cleanPath === '/sitemap.xml') {
    setLongCache();
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return send(200, renderSitemap(books, host, protocol));
  }

  const segments = cleanPath.split('/').filter(Boolean);

  // /browse...
  if (segments[0] === 'browse') {
    let result = null;
    if (segments.length === 1) {
      result = renderBrowse(books, host, protocol);
    } else if (segments[1] === 'tag' && segments[2]) {
      result = renderTag(books, segments[2], host, protocol);
    } else if (segments[1] && segments[2] && /^\d{4}$/.test(segments[2])) {
      result = renderGenre(books, segments[1], segments[2], host, protocol);
    } else if (segments[1] && !segments[2]) {
      result = renderGenre(books, segments[1], null, host, protocol);
    }
    if (result) {
      setPageCache();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return send(result.status, result.body);
    }
    return send(404, 'Not found.');
  }

  // /collections/...
  if (segments[0] === 'collections' && segments[1]) {
    const result = renderCollection(books, segments[1], host, protocol);
    if (result) {
      setPageCache();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return send(result.status, result.body);
    }
    return send(404, 'Not found.');
  }

  // /author/<slug>
  if (segments[0] === 'author' && segments[1]) {
    const result = renderAuthor(books, segments[1], host, protocol);
    if (result) {
      setPageCache();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return send(result.status, result.body);
    }
    return send(404, 'Not found.');
  }

  // /search
  if (segments[0] === 'search') {
    const q = params.get('q') || '';
    const result = renderSearch(books, q, host, protocol);
    setPageCache();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return send(result.status, result.body);
  }

  // listicles
  if (segments.length === 1 && LISTICLES.some((l) => l.slug === segments[0])) {
    const result = renderListicle(books, segments[0], host, protocol);
    if (result) {
      setPageCache();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return send(result.status, result.body);
    }
    return send(404, 'Not found.');
  }

  return send(404, 'Not found.');
};
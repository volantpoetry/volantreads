// ============================================================
// FILE: store1/api/ssr-book.js  (volantreads.vercel.app)
// ============================================================
// Server-side Schema.org Book JSON-LD injection.
//
// Rewritten from /details.html?id=<id> in store1/vercel.json so
// Googlebot (and users) receive the JSON-LD statically in the
// initial HTML instead of after a client-side Firestore fetch,
// which the Google renderer often misses.
//
// Flow:
//   1. read the static details.html (bundled via
//      "includeFiles": "details.html" in store1/vercel.json)
//   2. fetch the book: Firebase Admin SDK first, then the public
//      Firestore REST endpoint as a keyless fallback
//   3. if the book exists and status === 'approved', inject the
//      JSON-LD into <script id="structured-data-book">
//
// When the id is missing, the book is missing/hidden, or Firestore
// is unreachable, the original HTML is returned untouched and the
// existing client-side module (book-schema.js) still acts as the
// fallback.
// ============================================================

const fs = require('fs');
const path = require('path');
const { loadAdmin, db } = require('./../lib/store-admin.js');

const CLOUD_NAME = 'dzoq4pgjn';
const PROJECT_ID = 'silent-depth';
const TARGET = '<script type="application/ld+json" id="structured-data-book"></script>';

const firestoreDocUrl = (bookId) =>
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/books/${encodeURIComponent(bookId)}`;

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

function pickImage(data) {
  if (data.imageUrl) return data.imageUrl;
  if (data.coverUrl) return data.coverUrl;
  if (data.cloudinaryImageId) {
    return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/f_auto,q_auto/${data.cloudinaryImageId}`;
  }
  return null;
}

function buildBookSchema(data, bookId, protocol, host) {
  const pageUrl = `${protocol}://${host}/details.html?id=${encodeURIComponent(bookId)}`;

  const schema = {
    "@context": "https://schema.org",
    "@type": "Book",
    "@id": pageUrl,
    "url": pageUrl,
    "name": data.title,
    "bookFormat": "https://schema.org/EBook",
    "availability": "https://schema.org/InStock",
    "inLanguage": data.languageCode || data.language || "en",
    "publisher": {
      "@type": "Organization",
      "name": "Volant Foundry",
      "url": "https://volantfoundry.vercel.app/"
    }
  };

  const image = pickImage(data);
  if (image) schema.image = image;

  const author = {
    "@type": "Person",
    "name": data.authorName || data.author || "Anonymous"
  };
  if (data.authorPoetryProfile) author.sameAs = data.authorPoetryProfile;
  schema.author = author;

  const datePublished = formatDate(data.publishDate || data.publishedAt || data.createdAt || data.approvedAt);
  if (datePublished) schema.datePublished = datePublished;

  const description = data.summary || data.description;
  if (description) schema.description = description;

  if (data.isbn13) schema.isbn = data.isbn13;

  const ratingValue = data.ratingValue || (data.rating && data.rating.value);
  const reviewCount = data.reviewCount || (data.rating && data.rating.count);
  if (Number(ratingValue) > 0 && Number(reviewCount) > 0) {
    schema.aggregateRating = {
      "@type": "AggregateRating",
      "ratingValue": Number(ratingValue),
      "reviewCount": Number(reviewCount)
    };
  }

  const price = (data.pricing && data.pricing.amount !== undefined && data.pricing.amount !== null)
    ? data.pricing.amount
    : data.price;
  if (price !== undefined && price !== null && price !== "") {
    schema.offers = {
      "@type": "Offer",
      "price": price,
      "priceCurrency": (data.pricing && data.pricing.currency) || data.currency || "GHS"
    };
  }

  return JSON.stringify(schema);
}

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

async function fetchBookDoc(bookId) {
  // Path 1: Firebase Admin SDK (service account configured).
  try {
    loadAdmin();
    const snap = await db().collection('books').doc(bookId).get();
    if (snap.exists) return snap.data();
  } catch (err) {
    // fall through to the public REST endpoint
  }

  // Path 2: keyless public Firestore REST (rules allow public reads).
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

module.exports = async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;

  let html = null;
  try {
    html = fs.readFileSync(path.join(process.cwd(), 'details.html'), 'utf8');
  } catch (err) {
    return res.status(500).send('details.html is not bundled with this function (vercel.json includeFiles missing).');
  }

  const bookId = (new URL(req.url, `${protocol}://${host}`)).searchParams.get('id');

  if (bookId) {
    const data = await fetchBookDoc(bookId);
    if (data && data.status === 'approved') {
      const json = buildBookSchema(data, bookId, protocol, host)
        .replace(/<\/script/gi, '<\\/script');
      html = html.replace(
        TARGET,
        `<script type="application/ld+json" id="structured-data-book">\n${json}\n</script>`
      );
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
  res.status(200).send(html);
};
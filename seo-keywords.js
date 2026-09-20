// ============================================================
// FILE: store1/seo-keywords.js
// ============================================================
// SEO keyword taxonomy for volantreads.vercel.app.
//
// Used by api/ssr-page.js to generate /browse/tag/<slug> pages.
// A tag page lists every approved book that matches the tag.
// Matching is intentionally broad: a book matches via its
// Firestore `keywords` array, genre, country, language, title,
// subtitle or author — so under-tagged books still surface.
//
// The KEYWORD_POOL is the site-wide bucket of head/mid-tail terms
// we want to rank for. Add entries freely: only tags with at
// least one matching approved book produce pages in the sitemap.
// ============================================================

function norm(str) {
  return String(str || '').toLowerCase().trim();
}

function includesTerm(fields, term) {
  return fields.some((value) => norm(value).includes(norm(term)));
}

// Does `book` (decoded Firestore doc) match this tag entry?
function matchBook(book, entry) {
  if (entry.match && entry.match(book)) return true;
  if (!entry.terms) return false;

  const haystack = [
    ...(Array.isArray(book.keywords) ? book.keywords : []),
    book.genre,
    book.country,
    book.language,
    book.title,
    book.subtitle,
    book.authorName,
    String(book.price === undefined ? '' : book.price),
    book.publisherName
  ].filter((v) => v !== undefined && v !== null && v !== '');

  return entry.terms.some((term) => includesTerm(haystack, term));
}

// Extra keywords injected per book for SEO contexts (tag matching
// and JSON-LD `keywords`), so coverage grows even for books whose
// authors only filled in a couple of keywords on the submit form.
function expandedKeywords(book) {
  const base = Array.isArray(book.keywords)
    ? book.keywords.map((k) => String(k))
    : [];

  const set = new Set(base.map(norm));

  const add = (phrase) => {
    if (phrase && !set.has(norm(phrase))) set.add(norm(phrase));
  };

  if (norm(book.genre) === 'poetry') {
    add('poetry');
    add('poems');
    add('verse');
    add('poetry collection');
  }
  if (norm(book.country) === 'ghana') {
    add('ghanaian poetry');
    add('ghanaian author');
    add('ghanaian writer');
  }
  if (norm(book.language) === 'english') {
    add('english poetry');
  }
  if (book.authorName) {
    add('poetry by ' + book.authorName.toLowerCase());
  }
  if (book.preorder === true) {
    add('preorder');
  }
  const price = book.price;
  if (price === 0) {
    add('free ebook');
    add('free poetry');
  }

  return Array.from(set);
}

// === Genre normalization for /browse/<genre> and /browse/<genre>/<year> ===
const GENRE_MAP = {
  poetry: {
    slug: 'poetry',
    label: 'Poetry',
    blurb: 'Poetry from Ghanaian and African voices living today — chapbooks, full collections, and verse about love, loss, identity, and everything in between.'
  },
  prose: {
    slug: 'prose',
    label: 'Prose',
    blurb: 'Short fiction, essays, and longer works by contemporary writers.'
  },
  fiction: {
    slug: 'fiction',
    label: 'Fiction',
    blurb: 'Fiction by emerging and established authors.'
  },
  'non-fiction': {
    slug: 'non-fiction',
    label: 'Non-fiction',
    blurb: 'Essays, memoirs, and non-fiction writing.'
  },
  biography: {
    slug: 'biography',
    label: 'Biography',
    blurb: 'Biographies and life stories.'
  },
  'children': {
    slug: 'children',
    label: 'Children & Young Adult',
    blurb: 'Stories and verse for younger readers.'
  },
  'young-adult': {
    slug: 'young-adult',
    label: 'Young Adult',
    blurb: 'Young adult fiction and poetry.'
  }
};

function normalizeGenre(raw) {
  const r = norm(raw);
  if (GENRE_MAP[r]) return GENRE_MAP[r];
  // fallback to raw title-cased label
  const label = raw
    ? raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Books';
  return { slug: r, label, blurb: `Browse ${label} books available on Volant Reads.` };
}

// === Site-wide tag pool ===
const KEYWORD_POOL = [
  {
    id: 'poetry',
    slug: 'poetry',
    label: 'Poetry',
    title: 'Poetry Books Online in Ghana | Volant Reads',
    terms: ['poetry', 'poems', 'verse', 'poetry collection']
  },
  {
    id: 'ghanaian-poetry',
    slug: 'ghanaian-poetry',
    label: 'Ghanaian Poetry',
    title: 'Ghanaian Poetry Books | Volant Reads',
    terms: ['ghana', 'ghanaian']
  },
  {
    id: 'african-poetry',
    slug: 'african-poetry',
    label: 'African Poetry',
    title: 'African Poetry Books | Volant Reads',
    terms: ['african']
  },
  {
    id: 'poetry-ebooks',
    slug: 'poetry-ebooks',
    label: 'Poetry Ebooks',
    title: 'Poetry Ebooks Online | Volant Reads',
    terms: ['poetry', 'ebook', 'ebooks']
  },
  {
    id: 'love-and-loss-poetry',
    slug: 'love-and-loss-poetry',
    label: 'Poetry About Love & Loss',
    title: 'Poetry About Love & Loss | Volant Reads',
    terms: ['love and loss', 'loss', 'heartbreak', 'breaking']
  },
  {
    id: 'sad-poetry',
    slug: 'sad-poetry',
    label: 'Sad & Reflective Poetry',
    title: 'Sad & Reflective Poetry Books | Volant Reads',
    terms: ['sad', 'heartbreak', 'grief', 'grieving', 'reflective', 'reflection', 'sorrow']
  },
  {
    id: 'contemporary-poetry',
    slug: 'contemporary-poetry',
    label: 'Contemporary Poetry',
    title: 'Contemporary Poetry Books | Volant Reads',
    terms: ['contemporary', 'modern', 'indie']
  },
  {
    id: 'wisdom-quotes',
    slug: 'wisdom-quotes',
    label: 'Wisdom Quotes & Fragment Poetry',
    title: 'Wisdom Quotes & Fragment Poetry | Volant Reads',
    terms: ['wisdom', 'quotes', 'fragment', 'meditative']
  },
  {
    id: 'grief-poetry',
    slug: 'grief-poetry',
    label: 'Poetry for Grief & Healing',
    title: 'Poetry for Grief & Healing | Volant Reads',
    terms: ['grief', 'grieving', 'healing', 'loss']
  },
  {
    id: 'emotional-poetry',
    slug: 'emotional-poetry',
    label: 'Emotional Poetry',
    title: 'Emotional & Reflective Poetry | Volant Reads',
    terms: ['emotional']
  },
  {
    id: 'modern-indie-poetry',
    slug: 'modern-indie-poetry',
    label: 'Modern Indie Poetry',
    title: 'Modern Indie Poetry Books | Volant Reads',
    terms: ['indie', 'modern']
  },
  {
    id: 'free-poetry-books',
    slug: 'free-poetry-books',
    label: 'Free Poetry Books',
    title: 'Free Poetry Books | Volant Reads',
    terms: ['free'],
    match: (book) => book.price === 0
  },
  {
    id: 'ghanaian-poets',
    slug: 'ghanaian-poets',
    label: 'Ghanaian Poets',
    title: 'Ghanaian Poets & Their Books | Volant Reads',
    terms: ['ghana', 'ghanaian']
  },
  {
    id: 'short-poems',
    slug: 'short-poems',
    label: 'Short Poems & Chapbooks',
    title: 'Short Poems & Chapbooks | Volant Reads',
    terms: ['short', 'fragment', 'quote', 'chapbook'],
    match: (book) => Number(book.pageCount || 0) <= 20
  },
  {
    id: 'english-poetry',
    slug: 'english-poetry',
    label: 'English & Contemporary Verse',
    title: 'English Poetry Books | Volant Reads',
    terms: ['english']
  },
  {
    id: 'preorder-books',
    slug: 'preorder-books',
    label: 'Preorder Books',
    title: 'Preorder New Releases | Volant Reads',
    match: (book) => book.preorder === true
  },
  {
    id: 'poetry-by-rence-blunt',
    slug: 'poetry-by-rence-blunt',
    label: 'Poetry by Rence Blunt',
    title: 'Books by Rence Blunt | Volant Reads',
    terms: ['rence blast', 'rence', 'blunt']
  }
];

function findTag(slug) {
  return KEYWORD_POOL.find((t) => t.slug === slug);
}

module.exports = {
  matchBook,
  expandedKeywords,
  normalizeGenre,
  GENRE_MAP,
  KEYWORD_POOL,
  findTag
};
// ============================================================
// FILE: store1/seo-listicles.js
// ============================================================
// Curated "listicle" page data for volantreads.vercel.app.
//
// Each entry drives one editorial page (e.g. /best-ghanaian-poetry-books).
// `books` is an ordered list of approved book ids — first id is #1.
// If `auto` is true the page automatically fills with the books that
// match `filters` (fallback when `books` is empty). `intro` is
// hand-written editorial copy shown above the list.
//
// Edit the featured order and blurbs directly here — no admin UI needed.
// ============================================================

module.exports = [
  {
    slug: 'best-ghanaian-poetry-books',
    title: 'Best Ghanaian Poetry Books 2026 | Volant Reads',
    h1: 'Best Ghanaian Poetry Books',
    year: 2026,
    metaDescription:
      'The best contemporary Ghanaian poetry books on Volant Reads — verse about love, loss, resilience and everyday African life, available as instant ebooks.',
    intro:
      'Ghanaian poetry is having a moment. From shards of love and grief to wide-eyed poems about ordinary mornings, these are the collections we keep coming back to. Every book below is written by a Ghanaian author, lives on the Volant Reads shelf, and downloads as an insta-read ebook.',
    intro2:
      'New collections land on the shelf all the time — check back for the 2027 edition, and browse the collection below.',
    auto: true,
    filters: { genre: 'Poetry' },
    sort: 'approvedAt',
    books: ['0NHKCxiPxLRsKd9ZlTsp', 'lBp0Kq3NsqhpwiPnu3o6', 'FpYHUybFutxwiDDdHMbO', 'o9qWTPKDZ0hJeDc3ybpn', 'TjXT7MciML4rB0kAuvpu']
  }
];
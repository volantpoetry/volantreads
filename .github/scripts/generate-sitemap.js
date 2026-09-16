/**
 * 🔥 Auto Sitemap Generator for Volant Reads
 * ONLY includes URLs from the volantreads.vercel.app domain
 * Uses Firebase Admin SDK with Service Account from GitHub Secrets
 * Runs on GitHub Actions (inside the store repo)
 */

const fs = require('fs');
const path = require('path');

// ---- CONFIG ----
const domain = 'https://volantreads.vercel.app';
const publicFolder = './';
const MAX_BOOKS = 5000;

// ✅ STATIC PAGES TO INDEX (all under volantreads.vercel.app)
const allowedPages = [
  // Store root
  'index.html',

  // Store core pages
  'submit.html',
  'faq.html',
  'refund.html',
  'details.html',

  // Shared pages (if they exist in this repo)
  'shared/about.html',
  'shared/contact.html',
  'shared/terms.html',
  'shared/privacy.html'
];

// ❌ NO EXTERNAL URLS
// A sitemap can only contain URLs from the same domain as the sitemap itself.
const externalUrls = [];

// ---- XML ESCAPE FUNCTION ----
function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================
// 📚 FETCH BOOKS FROM FIRESTORE (Volant Reads)
// ============================================================
async function fetchBooksFromFirestore() {
  console.log('\n📚 Starting fetchBooksFromFirestore...');

  try {
    console.log('📦 Loading firebase-admin...');
    const admin = require('firebase-admin');
    console.log('✅ firebase-admin loaded');

    let serviceAccount;

    const secretKey = process.env.FIREBASE_KEY ||
                     process.env.FIREBASE_SERVICE_ACCOUNT ||
                     process.env.SERVICE_ACCOUNT_KEY;

    console.log(`🔐 Secret available: ${!!secretKey}`);

    if (secretKey) {
      try {
        serviceAccount = JSON.parse(secretKey);
        console.log('✅ Parsed service account JSON');
      } catch (parseError) {
        console.log('⚠️ Not JSON, trying base64 decode...');
        try {
          const decoded = Buffer.from(secretKey, 'base64').toString('utf8');
          serviceAccount = JSON.parse(decoded);
          console.log('✅ Decoded base64 service account');
        } catch (base64Error) {
          console.log('❌ Failed to parse service account:', base64Error.message);
          return [];
        }
      }
    } else {
      const keyPath = path.join(process.cwd(), 'service-account-key.json');
      if (fs.existsSync(keyPath)) {
        serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        console.log('✅ Loaded service account from local file');
      } else {
        console.log('❌ No service account key found');
        return [];
      }
    }

    if (!admin.apps || admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('✅ Firebase Admin initialized');
    }

    const db = admin.firestore();
    const allBooks = [];

    console.log('🔥 Fetching approved books...');
    const snapshot = await db.collection('books')
      .where('status', '==', 'approved')
      .get();

    if (snapshot.empty) {
      console.log('⚠️ No approved books found');
      return [];
    }

    console.log(`📄 Found ${snapshot.size} approved books`);

    snapshot.forEach(doc => {
      const data = doc.data();
      const docId = doc.id;

      let timestamp = new Date().toISOString();
      if (data.createdAt) {
        if (typeof data.createdAt === 'object' && data.createdAt.toDate) {
          timestamp = data.createdAt.toDate().toISOString();
        } else if (typeof data.createdAt === 'string') {
          timestamp = data.createdAt;
        } else if (typeof data.createdAt === 'number') {
          timestamp = new Date(data.createdAt).toISOString();
        }
      } else if (data.approvedAt) {
        if (typeof data.approvedAt === 'object' && data.approvedAt.toDate) {
          timestamp = data.approvedAt.toDate().toISOString();
        } else if (typeof data.approvedAt === 'string') {
          timestamp = data.approvedAt;
        }
      } else if (data.updatedAt) {
        if (typeof data.updatedAt === 'object' && data.updatedAt.toDate) {
          timestamp = data.updatedAt.toDate().toISOString();
        } else if (typeof data.updatedAt === 'string') {
          timestamp = data.updatedAt;
        }
      }

      allBooks.push({
        id: docId,
        bookId: data.bookId || docId,
        title: data.title || 'Untitled',
        timestamp: timestamp
      });
    });

    console.log(`✅ Total books fetched: ${allBooks.length}`);
    return allBooks;

  } catch (err) {
    console.error('❌ Failed to fetch books:', err.message);
    return [];
  }
}

// ============================================================
// 📚 Generate book URLS
// ============================================================
function generateBookUrls(books) {
  const results = [];
  let count = 0;

  for (const book of books) {
    if (count >= MAX_BOOKS) break;

    const url = `${domain}/details.html?id=${encodeURIComponent(book.id)}`;

    let lastmod = new Date().toISOString();
    if (book.timestamp) {
      try {
        const date = new Date(book.timestamp);
        if (!isNaN(date.getTime())) {
          lastmod = date.toISOString();
        }
      } catch (e) {}
    }

    results.push({
      loc: url,
      lastmod: lastmod,
      changefreq: 'weekly',
      priority: '0.8'
    });

    count++;
  }

  return results;
}

// ---- Get static URL ----
function getUrlWithHtml(filePath) {
  let cleanPath = filePath.replace(/^\.\//, '');
  if (cleanPath === 'index.html') return '';
  if (cleanPath.endsWith('/index.html')) return cleanPath.replace(/\/index\.html$/, '/');
  return cleanPath;
}

// ---- Build XML ----
function buildXML(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">

${urls.map(u => `
  <url>
    <loc>${escapeXml(u.loc)}</loc>
    <lastmod>${escapeXml(u.lastmod)}</lastmod>
    <changefreq>${escapeXml(u.changefreq)}</changefreq>
    <priority>${escapeXml(u.priority)}</priority>
  </url>
`).join('')}

</urlset>`;
}

// ---- Generate robots.txt ----
function generateRobotsTxt() {
  const robots = `# Robots.txt for Volant Reads
User-agent: *
Allow: /

# Root
Allow: /$
Allow: /index.html

# Store pages
Allow: /submit.html
Allow: /faq.html
Allow: /refund.html
Allow: /details.html

# Shared pages
Allow: /shared/about.html
Allow: /shared/contact.html
Allow: /shared/terms.html
Allow: /shared/privacy.html

# Block admin and private
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
Disallow: /*.xml$

# Block node_modules
Disallow: /node_modules/

# Block images
Disallow: /images/

# Block 404
Disallow: /404.html

Sitemap: ${domain}/sitemap.xml`;

  fs.writeFileSync(path.join(publicFolder, 'robots.txt'), robots, 'utf8');
  console.log('✅ robots.txt generated');
}

// ---- MAIN ----
async function generateSitemap() {
  try {
    console.log("🧠 Generating SEO sitemap for Volant Reads...");
    console.log(`📁 Domain: ${domain}`);
    console.log(`📄 Targeting ${allowedPages.length} static pages...`);

    // 1. Static pages
    const staticResults = [];
    for (const page of allowedPages) {
      const fullPath = path.join(publicFolder, page);
      if (!fs.existsSync(fullPath)) {
        console.log(`⚠️ Warning: ${page} not found, skipping...`);
        continue;
      }

      const stats = fs.statSync(fullPath);
      const urlPath = getUrlWithHtml(page);
      const url = urlPath === '' ? domain : `${domain}/${urlPath}`;

      let priority = '0.8';

      // Homepage = highest
      if (page === 'index.html' || urlPath === '') {
        priority = '1.0';
      }
      // Core store pages
      else if (page === 'details.html' || page === 'submit.html') {
        priority = '0.9';
      }
      // Secondary
      else if (page === 'faq.html' || page === 'refund.html') {
        priority = '0.8';
      }
      // Legal / contact
      else if (page.startsWith('shared/')) {
        priority = '0.6';
      }

      staticResults.push({
        loc: url,
        lastmod: stats.mtime.toISOString(),
        changefreq: 'weekly',
        priority: priority
      });
    }

    console.log(`✅ ${staticResults.length} static pages generated`);
    staticResults.forEach(r => {
      console.log(`   ${r.priority} → ${r.loc}`);
    });

    // 2. Dynamic books
    console.log("\n📚 Fetching books from Firestore...");
    const books = await fetchBooksFromFirestore();
    const bookResults = generateBookUrls(books);
    console.log(`✅ ${bookResults.length} book URLs generated (priority 0.8)`);

    if (bookResults.length === 0) {
      console.log("\n⚠️ WARNING: No book URLs generated!");
      console.log("📋 Check the logs above for errors.");
    }

    // 3. Combine (no external URLs)
    const allUrls = [...staticResults, ...bookResults];

    console.log(`\n📊 Total: ${allUrls.length} URLs`);
    console.log(`   Static: ${staticResults.length}`);
    console.log(`   Dynamic Books: ${bookResults.length}`);

    // 4. Build sitemap
    const xml = buildXML(allUrls);
    fs.writeFileSync(path.join(publicFolder, 'sitemap.xml'), xml, 'utf8');
    console.log('✅ sitemap.xml generated');

    // 5. Sample
    console.log('\n📋 Sample URLs:');
    const sampleCount = Math.min(15, allUrls.length);
    for (let i = 0; i < sampleCount; i++) {
      console.log(`   - ${allUrls[i].loc} (priority: ${allUrls[i].priority})`);
    }
    if (allUrls.length > sampleCount) {
      console.log(`   ... and ${allUrls.length - sampleCount} more`);
    }

    // 6. robots.txt
    generateRobotsTxt();

    // 7. Summary
    console.log('\n📊 Sitemap Statistics:');
    console.log(`   Total URLs: ${allUrls.length}`);
    console.log(`   Static: ${staticResults.length}`);
    console.log(`   Dynamic Books: ${bookResults.length}`);

  } catch (err) {
    console.error('❌ Sitemap error:', err);
    process.exit(1);
  }
}

generateSitemap();

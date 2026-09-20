// ============================================================
// FILE: store1/api/auto-release-books.js  (volantreads.vercel.app)
// ============================================================
// Vercel CRON + on-demand endpoint for pre-order auto-release.
//
// Triggered by:
//   • Vercel Cron (see "crons" in store1/vercel.json)  -> GET
//   • store front-end safety net                        -> POST {}
//   • admin "Release now"                               -> POST { bookId }
//
// What it does for every book whose release date has passed:
//   1. marks the book released:true
//   2. unlocks every buyer's pre-order purchase: released:true
//   3. writes a notification for each buyer
//   4. sends release emails via Resend (if configured)
//
// Requires a Firebase service account in the env var
// SERVICE_ACCOUNT_KEY (base64 JSON) / SERVICE_ACCOUNT (JSON).
// Without it the function returns 200 with { configured:false }
// and the client-side scanner (store/index.html) still unlocks
// books + sends in-app notifications.
// ============================================================

const { db, loadAdmin, serverTimestamp } = require('./../lib/store-admin.js');
const { sendReleaseEmails } = require('./../lib/send-email.js');

function todayStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Use GET (cron) or POST.' });
    }

    // Optional shared secret to prevent random public triggering.
    if (process.env.RELEASE_CRON_SECRET) {
        const sent = (req.headers['x-cron-secret'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
        if (sent !== process.env.RELEASE_CRON_SECRET) {
            return res.status(401).json({ success: false, message: 'Unauthorized.' });
        }
    }

    try {
        loadAdmin();
    } catch (err) {
        console.warn('auto-release: Firebase Admin not configured ->', err.message);
        return res.json({ success: true, configured: false, released: 0, message: 'Service account not configured. Use the client-side scanner.' });
    }

    const today = todayStr();
    const requestedId = (typeof req.body === 'object' && req.body !== null && req.body.bookId)
        ? String(req.body.bookId) : null;

    try {
        const dbx = db();

        // Fetch all pre-order books (few), filter due in code to avoid index requirements.
        const booksSnap = await dbx.collection('books').where('preorder', '==', true).get();
        const due = [];

        for (const ds of booksSnap.docs) {
            const b = ds.data() || {};
            if (requestedId && ds.id !== requestedId) continue;
            if (b.released === true) continue;
            if (b.status && b.status !== 'approved') continue;
            if (!b.preorderReleaseDate) continue;
            if (String(b.preorderReleaseDate) > today) continue;
            due.push({ id: ds.id, book: b });
        }

        let booksDone = 0, buyersDone = 0, emailsSent = 0;
        const batchSize = 400;
        const notifications = [];

        for (const { id, book } of due) {
            const bookRef = dbx.collection('books').doc(id);
            const batch = dbx.batch();
            batch.update(bookRef, {
                released: true,
                preorder: false,
                releasedAt: serverTimestamp(),
                releasedBy: requestedId ? 'admin' : 'cron'
            });

            const purchases = await dbx.collection('purchases')
                .where('bookId', '==', id)
                .where('preorder', '==', true)
                .get();

            let buyerEmails = [];
            let ops = 1;
            for (const ps of purchases.docs) {
                const pd = ps.data() || {};
                const ownerId = pd.userId || (ps.id.includes('_') ? ps.id.split('_')[0] : null);
                batch.update(ps.ref, {
                    released: true,
                    releasedAt: serverTimestamp()
                });
                ops++;
                if (ownerId) {
                    if (pd.customerEmail) buyerEmails.push(pd.customerEmail);
                    notifications.push({ ownerId, title: book.title || 'Your pre-ordered book' });
                }
            }

            if (ops < batchSize) {
                await batch.commit();
            } else {
                await bookRef.update({
                    released: true,
                    preorder: false,
                    releasedAt: serverTimestamp(),
                    releasedBy: requestedId ? 'admin' : 'cron'
                });
                for (const ps of purchases.docs) {
                    await ps.ref.update({
                        released: true,
                        releasedAt: serverTimestamp()
                    });
                }
            }
            booksDone++;

            for (const { ownerId, title } of notifications) {
                await dbx.collection('notifications').add({
                    userId: ownerId,
                    forUser: ownerId,
                    type: 'preorder_released',
                    message: `🎉 "${title}" is now available! Your pre-order is ready — download it from your library.`,
                    timestamp: serverTimestamp(),
                    read: false
                });
            }
            notifications.length = 0;

            buyersDone += purchases.docs.length;
            if (buyerEmails.length) {
                const r = await sendReleaseEmails({
                    bookTitle: book.title || 'Your pre-ordered book',
                    authorName: book.authorName || '',
                    emails: buyerEmails
                });
                emailsSent += r.sent || 0;
            }
        }

        return res.json({
            success: true,
            configured: true,
            released: booksDone,
            notifiedBuyers: buyersDone,
            emailsSent
        });
    } catch (err) {
        console.error('auto-release error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
    }
};
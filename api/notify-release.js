// ============================================================
// FILE: store1/api/notify-release.js  (volantreads.vercel.app)
// ============================================================
// Called by the Volant Reads store after a pre-order book is
// marked released. Sends the release email to each buyer via
// Resend. Requires RESEND_API_KEY (+ optional MAIL_FROM) set on
// the volantreads project. Skips gracefully if no key.
// Sends CORS headers so the store (volantpoetry.vercel.app) can
// call this endpoint cross-origin. No Firestore access needed.
// ============================================================

const { sendReleaseEmails } = require('./../lib/send-email.js');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Use POST.' });

    try {
        const body = req.body || {};
        const bookTitle = typeof body.bookTitle === 'string' ? body.bookTitle : 'Your pre-ordered book';
        const authorName = typeof body.authorName === 'string' ? body.authorName : '';
        const emails = Array.isArray(body.emails) ? body.emails : [];

        const result = await sendReleaseEmails({ bookTitle, authorName, emails });
        return res.json({ success: true, ...result });
    } catch (err) {
        console.error('notify-release error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
    }
};
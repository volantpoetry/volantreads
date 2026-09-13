// ============================================================
// FILE: store1/api/notify-activity.js  (volantreads.vercel.app)
// ============================================================
// Activity notification emails for comments, replies, contact
// inquiries and direct messages. Mirrored identically in
// api/notify-activity.js (volantpoetry.vercel.app) so both projects
// can call the same relative /api/notify-activity path.
//
// POST /api/notify-activity
//   body: { toUid, fromUid, type, data }   (fire-and-forget, best effort)
//   type ∈ comment | reply | message | dm
//   - comments / replies email immediately (no throttle)
//   - messages / dms throttle to max 1 per 30 min per recipient
//   - reads users/{uid}.emailPrefs (defaults: everything on)
//   - resolves recipient email from users/{uid}.email
//
// GET /api/notify-activity?unsub=1&uid=<uid>&t=<token>
//   Turns off ALL activity emails for that user (emailPrefs.all=false).
//
// Requires RESEND_API_KEY (+ optional MAIL_FROM). Skips gracefully
// when missing. Shared Firebase Admin bootstrap via lib/store-admin.
// ============================================================

const crypto = require('crypto');
const { db, serverTimestamp } = require('./../lib/store-admin.js');
const { sendResendEmail } = require('./../lib/send-email.js');

const TYPES = ['comment', 'reply', 'message', 'dm'];
const THROTTLE_MS = 30 * 60 * 1000;
const BASE_POETRY = 'https://volantpoetry.vercel.app';
const BASE_READS = 'https://volantreads.vercel.app';

function tokenFor(uid) {
    const secret = process.env.NOTIFY_EMAIL_SECRET || 'volant-notify-dev-secret';
    return crypto.createHmac('sha256', secret).update(String(uid)).digest('hex');
}

function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function prefsEnabled(prefs, key) {
    if (!prefs || typeof prefs !== 'object') return true;
    if (prefs.all === false) return false;
    if (key === 'all') return true; // nothing more to check after all all=false
    return prefs[key] !== false;
}

function buildEmail(input) {
    const { type, siteName, fromUserName, poemTitle, bookTitle, text, link, unsub } = input;
    const buttonLabel = (type === 'message' || type === 'dm') ? 'View message' : 'View poem';
    let heading, intro;
    if (type === 'comment') {
        heading = `New comment on “${esc(poemTitle || 'your poem')}”`;
        intro = `<strong>${esc(fromUserName)}</strong> commented on your poem${poemTitle ? ` “${esc(poemTitle)}”` : ''}.`;
    } else if (type === 'reply') {
        heading = 'New reply to your comment';
        intro = `<strong>${esc(fromUserName)}</strong> replied to your comment${poemTitle ? ` on “${esc(poemTitle)}”` : ''}.`;
    } else if (type === 'message') {
        heading = `New inquiry about “${esc(bookTitle || 'your book')}”`;
        intro = `<strong>${esc(fromUserName)}</strong> sent you a message about “${esc(bookTitle || 'your book')}”.`;
    } else {
        heading = `New message from ${esc(fromUserName)}`;
        intro = `<strong>${esc(fromUserName)}</strong> sent you a new message.`;
    }

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#faf7f2;border-radius:12px;">
            <h2 style="color:#3e362e;margin-top:0;">${heading}</h2>
            <p style="color:#555;font-size:16px;">${intro}</p>
            <div style="background:#fff;border:1px solid #eee;border-left:3px solid #3e362e;border-radius:8px;padding:16px;margin:16px 0;color:#444;font-size:15px;line-height:1.5;">“${esc(text || '')}”</div>
            <a href="${esc(link)}" style="background:#3e362e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;display:inline-block;font-size:15px;font-weight:bold;">${buttonLabel}</a>
            <p style="margin-top:28px;color:#8a8a8a;font-size:12px;line-height:1.6;">You are receiving this because you have an account on ${esc(siteName)}.<br>
            Want to control these emails? <a href="${esc(unsub)}" style="color:#8a8a8a;">Unsubscribe from activity emails</a>.</p>
        </div>
    `;

    return { html, intro: `${fromUserName}: ${text || ''}` };
}

function apiBaseFor(site) {
    return site === 'reads' ? BASE_READS : BASE_POETRY;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // ---- Unsubscribe -------------------------------------------------
    if (req.method === 'GET') {
        const uid = typeof req.query.uid === 'string' ? req.query.uid : '';
        const t = typeof req.query.t === 'string' ? req.query.t : '';
        if (!req.query.unsub || !uid) return res.status(400).send('Bad request.');
        if (t !== tokenFor(uid)) return res.status(403).send('Invalid unsubscribe link.');
        try {
            const ref = db().collection('users').doc(uid);
            await ref.set({ 'emailPrefs.all': false }, { merge: true });
        } catch (err) {
            console.error('notify-activity unsubscribe error:', err);
            return res.status(500).send('Could not unsubscribe. Please try again.');
        }
        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(
            '<!doctype html><html><body style="font-family:Arial,sans-serif;background:#faf7f2;text-align:center;padding:60px 20px;color:#3e362e;">' +
            '<h2>You have been unsubscribed</h2>' +
            '<p>You will no longer receive activity emails. Your in-app notifications still work.</p>' +
            '</body></html>'
        );
    }

    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Use POST.' });

    try {
        const body = req.body || {};
        const toUid = typeof body.toUid === 'string' ? body.toUid : '';
        const fromUid = typeof body.fromUid === 'string' ? body.fromUid : '';
        const type = TYPES.includes(body.type) ? body.type : '';
        const data = body.data && typeof body.data === 'object' ? body.data : {};

        if (!toUid || !type) {
            return res.status(400).json({ success: false, message: 'toUid and type are required.' });
        }
        if (fromUid && toUid === fromUid) {
            return res.json({ success: true, sent: 0, skipped: 1, reason: 'self' });
        }

        const userDoc = await db().collection('users').doc(toUid).get();
        if (!userDoc.exists) {
            return res.json({ success: true, sent: 0, skipped: 1, reason: 'no-user' });
        }
        const user = userDoc.data();
        const email = typeof user.email === 'string' ? user.email : '';
        if (!/.+@.+\..+/.test(email)) {
            return res.json({ success: true, sent: 0, skipped: 1, reason: 'no-email' });
        }

        const prefs = user.emailPrefs || {};
        if (!prefsEnabled(prefs, type)) {
            return res.json({ success: true, sent: 0, skipped: 1, reason: 'prefs-off' });
        }

        const site = data.site === 'reads' ? 'reads' : 'poetry';
        const siteName = site === 'reads' ? 'Volant Reads' : 'Volant Poetry';
        const mailFrom = data.site === 'reads'
            ? 'Volant Reads <no-reply@resend.dev>'
            : 'Volant Poetry <no-reply@resend.dev>';

        const fromUserName = typeof data.fromUserName === 'string' && data.fromUserName
            ? data.fromUserName
            : (typeof user.username === 'string' && user.username ? user.username : 'Someone');

        const poemTitle = typeof data.poemTitle === 'string' ? data.poemTitle : '';
        const poemId = typeof data.poemId === 'string' ? data.poemId : '';
        const bookTitle = typeof data.bookTitle === 'string' ? data.bookTitle : '';
        const text = typeof data.text === 'string' ? data.text
            : typeof data.commentText === 'string' ? data.commentText
            : typeof data.replyText === 'string' ? data.replyText
            : typeof data.message === 'string' ? data.message
            : '';

        // Throttle messages / dms to protect the recipient's inbox.
        if (type === 'message' || type === 'dm') {
            const last = user.lastActivityEmailAt;
            if (last) {
                const ms = typeof last.toMillis === 'function' ? last.toMillis() : new Date(last).getTime();
                if (Date.now() - ms < THROTTLE_MS) {
                    return res.json({ success: true, sent: 0, skipped: 1, reason: 'throttled' });
                }
            }
        }

        let subject, link;
        if (type === 'comment' || type === 'reply') {
            link = `${BASE_POETRY}/poem.html?collection=recentPoems&slug=${encodeURIComponent(poemId || '')}`;
            if (type === 'comment') {
                subject = `New comment on “${poemTitle || 'your poem'}”`;
            } else {
                subject = poemTitle ? `New reply to your comment on “${poemTitle}”` : 'New reply to your comment';
            }
        } else if (type === 'message') {
            subject = `New inquiry about “${bookTitle || 'your book'}”`;
            link = `${apiBaseFor(site)}/messages.html`;
        } else {
            subject = `New message from ${fromUserName}`;
            link = `${apiBaseFor(site)}/messages.html`;
        }

        const unsub = `${apiBaseFor(site)}/api/notify-activity?unsub=1&uid=${encodeURIComponent(toUid)}&t=${tokenFor(toUid)}`;
        const { html } = buildEmail({
            type, siteName, fromUserName, poemTitle, bookTitle, text, link, unsub
        });

        const result = await sendResendEmail({ to: email, subject, html, from: mailFrom });

        if (type === 'message' || type === 'dm') {
            try {
                await db().collection('users').doc(toUid).update({ lastActivityEmailAt: serverTimestamp() });
            } catch (err) {
                console.warn('notify-activity throttle marker update failed:', err.message);
            }
        }

        return res.json({ success: true, ...result });
    } catch (err) {
        console.error('notify-activity error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
    }
};
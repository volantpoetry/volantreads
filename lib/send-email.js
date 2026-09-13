// ============================================================
// FILE: store1/lib/send-email.js  (volantreads.vercel.app)
// ============================================================
// Best-effort release emails via Resend (free tier). No email is
// sent and no error is thrown if RESEND_API_KEY is not configured —
// the feature degrades gracefully to in-app notifications only.
// ============================================================

async function sendResendEmail({ to, subject, html, from }) {
    const key = process.env.RESEND_API_KEY;
    const mailFrom = from || process.env.MAIL_FROM || 'Volant Poetry <no-reply@resend.dev>';
    if (!key || !to || !subject) {
        return { sent: 0, skipped: 1 };
    }
    const list = Array.isArray(to) ? to : [to];
    const unique = [...new Set(list.filter(e => typeof e === 'string' && /.+@.+\..+/.test(e)))];
    if (unique.length === 0) return { sent: 0, skipped: 1 };

    const results = await Promise.all(unique.map(async (addr) => {
        try {
            const r = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ from: mailFrom, to: addr, subject, html })
            });
            return r.ok;
        } catch (e) {
            return false;
        }
    }));

    return { sent: results.filter(Boolean).length, failed: results.filter(x => !x).length };
}

async function sendReleaseEmails({ bookTitle, authorName, emails }) {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.MAIL_FROM || 'Volant Reads <no-reply@resend.dev>';
    if (!key || !Array.isArray(emails) || emails.length === 0) {
        return { sent: 0, skipped: 1 };
    }
    const unique = [...new Set(emails.filter(e => typeof e === 'string' && /.+@.+\..+/.test(e)))];
    if (unique.length === 0) return { sent: 0, skipped: 1 };

    const subject = `🎉 "${bookTitle}" is now available on Volant Reads!`;
    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#faf7f2;border-radius:12px;">
            <h2 style="color:#3e362e;margin-top:0;">Your pre-order is ready! 🎉</h2>
            <p style="color:#555;font-size:16px;">Good news — <strong>${bookTitle}</strong>${authorName ? ` by ${authorName}` : ''} has been released.</p>
            <p style="color:#555;font-size:16px;">You can now download and read it from your Volant Reads library.</p>
            <p style="margin-top:24px;color:#8a8a8a;font-size:13px;">You are receiving this because you pre-ordered this book on Volant Reads.</p>
        </div>
    `;

    const results = await Promise.all(unique.map(async (to) => {
        try {
            const r = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ from, to, subject, html })
            });
            return r.ok;
        } catch (e) {
            return false;
        }
    }));

    return { sent: results.filter(Boolean).length, failed: results.filter(x => !x).length };
}

module.exports = { sendResendEmail, sendReleaseEmails };
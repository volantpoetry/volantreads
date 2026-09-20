// ============================================================
// FILE: api/verify-settlements.js  (root volantpoetry + store1 volantreads)
// ============================================================
// Confirms Paystack actually settled each book-sale split to the
// author before the dashboard ever counts it as "Paid".
//
// Flow:
//   • AT CHECKOUT (client) a purchase is stored with
//       authorSettled:true, settlementDate (T+1), settlementStatus:'pending'
//   • The dashboard shows a sale as paid ONLY when settlementStatus
//     becomes 'paid' — never on T+1 alone.
//   • This function (Vercel Cron daily + admin "Rescan" POST) checks
//     Paystack's real transfers and flips:
//       pending → paid        (transfer found with status success)
//       pending → attention   (T+1 + 3d grace passed, still unconfirmed)
//
// Matching: a purchase without a stored transferReference is matched to
// Paystack transfers by expected author share (≈90% of charge) + currency
// + created_at window around settlementDate. Multi-author split shares
// cannot be recovered from the charge, so those fall through to
// settlementStatus 'attention' where an admin confirms the row manually.
//
// Requires: SERVICE_ACCOUNT_KEY (or SERVICE_ACCOUNT) + PAYSTACK_SECRET_KEY.
// Without either it returns 200 { configured:false } (like auto-release).
// ============================================================

const { db, loadAdmin, serverTimestamp } = require('./../lib/store-admin.js');

const PLATFORM = 'reads';
const COMMISSION_PERCENT = 10;              // platform keeps 10%, author gets 90%
const SHARE_RATE = (100 - COMMISSION_PERCENT) / 100;
const KOBO_PER_GHS = 100;
const TOLERANCE_KOBO = 400;                 // +- GHS 4 on the author share
const GRACE_DAYS = 3;                       // days past T+1 before "attention"
const WINDOW_BEFORE_DAYS = 3;               // transfer may land early
const WINDOW_AFTER_DAYS = 7;                // transfer may land late

function daysFromNowISO(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString();
}

function dateStr(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nextSettlementDate(fromISO) {
    const d = new Date(fromISO);
    d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d.toISOString();
}

async function paystackGet(path, secret) {
    const res = await fetch(`https://api.paystack.co${path}`, {
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) return null;
    return res.json();
}

// ===== Only fetch transfers created in the last 90 days =====
async function fetchTransfers(secret) {
    const since = daysFromNowISO(-90);
    const transfers = [];
    const perPage = 100;
    for (let page = 1; page <= 10; page++) {
        const json = await paystackGet(`/transfer?perPage=${perPage}&page=${page}`, secret);
        if (!json || !json.status || !Array.isArray(json.data)) break;
        const list = json.data;
        for (const t of list) {
            if (t.created_at && new Date(t.created_at) < new Date(since)) continue;
            transfers.push({
                reference: t.reference,
                amount: t.amount || 0,
                currency: (t.currency || 'GHS').toUpperCase(),
                status: t.status || '',
                createdAt: t.created_at || null,
                recipient: (t.recipient && (t.recipient.recipient_code || t.recipient.name)) || ''
            });
        }
        if (list.length < perPage) break;
    }
    return transfers;
}

async function verifySingleTransfer(reference, secret) {
    const json = await paystackGet(`/transfer/verify/${encodeURIComponent(reference)}`, secret);
    if (!json || !json.status || !json.data) return null;
    const t = json.data;
    return {
        reference: t.reference,
        amount: t.amount || 0,
        currency: (t.currency || 'GHS').toUpperCase(),
        status: t.status || '',
        createdAt: t.created_at || null,
        recipient: (t.recipient && (t.recipient.recipient_code || t.recipient.name)) || ''
    };
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Use GET (cron) or POST (rescan).' });
    }

    const requestedId = (req.method === 'POST' && typeof req.body === 'object' && req.body !== null && req.body.purchaseId)
        ? String(req.body.purchaseId) : null;

    try {
        loadAdmin();
    } catch (err) {
        console.warn('verify-settlements: Firebase Admin not configured ->', err.message);
        return res.json({ success: true, configured: false, message: 'Service account not configured.' });
    }

    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) {
        return res.json({ success: true, configured: false, message: 'PAYSTACK_SECRET_KEY not configured.' });
    }

    const dbx = db();
    const today = new Date();

    try {
        let snapshot;
        if (requestedId) {
            const ref = dbx.collection('purchases').doc(requestedId);
            const snap = await ref.get();
            if (!snap.exists) return res.status(404).json({ success: false, message: 'Purchase not found.' });
            snapshot = { docs: [snap], docRef: (ds) => ref };
        } else {
            snapshot = await dbx.collection('purchases')
                .where('settlementStatus', '==', 'pending')
                .get();
        }

        const targets = [];
        for (const ds of snapshot.docs) {
            const data = ds.data() || {};
            if (!requestedId && data.platform !== PLATFORM) continue;
            if (data.settlementStatus === 'paid') continue;
            if (requestedId && data.settlementStatus !== 'pending') continue;
            const base = data.settlementDate || data.purchasedAt || ds.id;
            const expectedShareKobo = Math.round((data.amount || 0) * SHARE_RATE * KOBO_PER_GHS);
            targets.push({
                id: ds.id,
                ref: snapshot.docRef ? snapshot.docRef(ds) : ds.ref,
                expectedKobo: expectedShareKobo,
                amount: data.amount || 0,
                settlementDate: base,
                purchasedAt: data.purchasedAt || null,
                transferReference: data.transferReference || null,
                status: data.settlementStatus || 'pending'
            });
        }

        if (targets.length === 0) {
            return res.json({ success: true, configured: true, checked: 0, markedPaid: 0, flagged: 0, stillPending: 0 });
        }

        // Load recent transfers once (cached locally within the run).
        const transfers = await fetchTransfers(secret);
        const usedReferences = new Set();
        const now = new Date();

        let markedPaid = 0, flagged = 0, checked = 0;

        for (const t of targets) {
            checked++;
            let match = null;

            if (t.transferReference) {
                // Strong path: we already know Paystack's transfer reference.
                const verified = await verifySingleTransfer(t.transferReference, secret);
                if (verified && verified.status === 'success') match = verified;
            } else {
                // Heuristic path: match by expected share + currency + date window.
                const settle = new Date(t.settlementDate || t.purchasedAt || now);
                const lo = new Date(settle); lo.setDate(lo.getDate() - WINDOW_BEFORE_DAYS);
                const hi = new Date(settle); hi.setDate(hi.getDate() + WINDOW_AFTER_DAYS);
                candidates: for (const tr of transfers) {
                    if (tr.status !== 'success') continue;
                    if (usedReferences.has(tr.reference)) continue;
                    if (tr.currency !== 'GHS') continue;
                    if (t.expectedKobo > 0 && Math.abs(tr.amount - t.expectedKobo) > TOLERANCE_KOBO) continue;
                    if (tr.createdAt) {
                        const c = new Date(tr.createdAt);
                        if (c < lo || c > hi) continue;
                    }
                    usedReferences.add(tr.reference);
                    match = tr;
                    break candidates;
                }
            }

            if (match) {
                await t.ref.update({
                    settlementStatus: 'paid',
                    settledAt: serverTimestamp(),
                    transferReference: match.reference || t.transferReference,
                    transferAmountKobo: match.amount,
                    verifiedBy: 'paystack-cron'
                });
                markedPaid++;
            } else {
                // Mark for admin review once we are past the grace period.
                const settle = new Date(t.settlementDate || t.purchasedAt || now);
                const grace = new Date(settle); grace.setDate(grace.getDate() + GRACE_DAYS);
                if (now >= grace) {
                    await t.ref.update({
                        settlementStatus: 'attention',
                        attentionAt: serverTimestamp(),
                        attentionReason: 'no-paystack-transfer-found'
                    });
                    flagged++;
                }
            }
        }

        return res.json({
            success: true,
            configured: true,
            checked,
            markedPaid,
            flagged,
            stillPending: checked - markedPaid - flagged
        });
    } catch (err) {
        console.error('verify-settlements error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
    }
};
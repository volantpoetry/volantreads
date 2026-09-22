// store/admin-ops.js — admin Email Campaigns + real-time Analytics (loaded by approvals.html).
import { initializeApp } from "firebase/app";
import {
    getFirestore, collection, query, where, orderBy, limit,
    getDocs, getDoc, doc, addDoc, writeBatch, serverTimestamp, onSnapshot
} from "firebase/firestore";
import { getAuth, onAuthStateChanged } from "firebase/auth";

const firebaseConfig = {
    apiKey: "AIzaSyC4DHI8aBVY4JjTvJ-r-TGIDPsewtEWxzU",
    authDomain: "silent-depth.firebaseapp.com",
    projectId: "silent-depth",
    storageBucket: "silent-depth.appspot.com",
    messagingSenderId: "78008755450",
    appId: "1:78008755450:web:3fd0f0f298a08820935543"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const GHS = (n) => 'GHS ' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(function injectStyles() {
    try {
        if (document.getElementById('adminOpsStyles')) return;
        const style = document.createElement('style');
        style.id = 'adminOpsStyles';
        style.textContent = `
            .admin-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
            .admin-table th { text-align: left; color: #8a7b6a; font-weight: 600; padding: 0.4rem 0.5rem; border-bottom: 1px solid #ede7df; }
            .admin-table td { padding: 0.45rem 0.5rem; border-bottom: 1px solid #f3eee6; vertical-align: middle; }
            .email-table-scroll { overflow-x: auto; }
        `;
        document.head.appendChild(style);
    } catch (e) {}
})();

let isAdmin = false;
let initialized = {};

function status(msg, el) {
    if (!el) return;
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    try {
        const adm = await getDoc(doc(db, "admins", user.uid));
        isAdmin = adm.exists();
        if (!isAdmin) {
            document.querySelectorAll('#tab-emails, #tab-analytics').forEach(el => {
                el.innerHTML = '<div style="padding:2rem;color:#8a7b6a;text-align:center;"><i class="fas fa-shield-alt"></i> You are not an admin.</div>';
            });
        }
    } catch (e) {
        isAdmin = false;
    }
});

document.querySelectorAll('.tab-btn[data-tab="emails"], .tab-btn[data-tab="analytics"]').forEach(btn => {
    btn.addEventListener('click', () => {
        ensureInit(btn.dataset.tab);
    });
});
if (document.querySelector('.tab-btn.active[data-tab="emails"]')) ensureInit('emails');
if (document.querySelector('.tab-btn.active[data-tab="analytics"]')) ensureInit('analytics');

function ensureInit(tab) {
    if (!isAdmin || initialized[tab]) return;
    initialized[tab] = true;
    if (tab === 'emails') initEmails();
    else initAnalytics();
}

// ================= EMAIL CAMPAIGNS =================

function initEmails() {
    const container = document.getElementById('tab-emails');
    if (!container) return;

    container.innerHTML = `
        <div class="summary-grid" id="emailsSummary"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin:1rem 0 0.6rem; flex-wrap:wrap; gap:0.5rem;">
            <h3 style="font-weight:600; color:#2d2a24; margin:0;"><i class="fas fa-paper-plane" style="color:#b76e4b;"></i> Email Lists</h3>
            <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
                <button class="btn-admin" data-ef="all" style="padding:0.35rem 1rem; font-size:0.78rem;">All</button>
                <button class="btn-admin" data-ef="wishlist" style="padding:0.35rem 1rem; font-size:0.78rem;">Wishlist alerts</button>
                <button class="btn-admin" data-ef="abandoned-cart" style="padding:0.35rem 1rem; font-size:0.78rem;">Abandoned carts</button>
            </div>
        </div>
        <div style="display:flex; gap:0.6rem; flex-wrap:wrap; margin-bottom:0.8rem; align-items:center;">
            <button class="btn-admin" id="emailSelectAll" style="padding:0.4rem 1.1rem;"><i class="fas fa-check-double"></i> Select all</button>
            <button class="btn-admin" id="emailSelectNone" style="padding:0.4rem 1.1rem;"><i class="fas fa-undo"></i> Clear selection</button>
            <span id="emailSelCount" style="font-size:0.78rem; color:#8a7b6a;">0 selected</span>
        </div>
        <div id="emailsTableWrap" class="manage-table-wrap">
            <div class="email-table-scroll"><table class="admin-table"><thead><tr><th></th><th>Email</th><th>List</th><th>Reason / Book</th><th>Last seen</th></tr></thead><tbody id="emailsTbody"><tr><td colspan="5" style="text-align:center; color:#8a7b6a;">Loading emails...</td></tr></tbody></table></div>
        </div>
        <div class="manage-table-wrap" style="margin-top:1.1rem;">
            <h3 style="font-weight:600; color:#2d2a24; margin:0 0 0.6rem;"><i class="fas fa-envelope-open-text" style="color:#b76e4b;"></i> Compose Message</h3>
            <p style="font-size:0.78rem; color:#8a7b6a; margin:0 0 0.6rem;">
                No email domain/API yet, so "Send now" opens your email app with everyone in BCC ready to send.
                "Queue" saves the message so you can fire it later once Resend (or another provider) is connected.
            </p>
            <input type="text" id="emailSubject" placeholder="Subject line" style="width:100%; padding:0.55rem 0.8rem; border:1px solid #dfd5ee; border-radius:8px; margin-bottom:0.5rem; font-family:inherit;" />
            <textarea id="emailBody" rows="5" placeholder="Your message..." style="width:100%; padding:0.55rem 0.8rem; border:1px solid #dfd5ee; border-radius:8px; margin-bottom:0.5rem; font-family:inherit; resize:vertical;"></textarea>
            <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
                <button class="btn-admin" id="emailSendNow"><i class="fas fa-paper-plane"></i> Send now (email app)</button>
                <button class="btn-admin btn-reset" id="emailSendQueue"><i class="fas fa-tasks"></i> Queue for later</button>
            </div>
            <div class="coupon-msg" id="emailAdminMsg"></div>
        </div>`;

    const summary = document.getElementById('emailsSummary');
    const tbody = document.getElementById('emailsTbody');
    const selCountEl = document.getElementById('emailSelCount');
    const msg = document.getElementById('emailAdminMsg');
    const selected = new Set();
    let rows = [];
    let currentFilter = 'all';

    const renderSummary = () => {
        const counts = { wishlist: 0, 'abandoned-cart': 0 };
        rows.forEach(r => { if (counts[r.kind] != null) counts[r.kind]++; });
        summary.innerHTML = `
            <div class="summary-card"><div class="number purple">${rows.length}</div><div class="label">Total Emails</div></div>
            <div class="summary-card"><div class="number purple" style="color:#4b2aad;">${counts.wishlist}</div><div class="label">Wishlist Alerts</div></div>
            <div class="summary-card"><div class="number orange">${counts['abandoned-cart']}</div><div class="label">Abandoned Carts</div></div>`;
    };

    const renderRows = () => {
        const visible = rows.filter(r => currentFilter === 'all' || r.kind === currentFilter);
        if (visible.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#8a7b6a;">No emails yet. Emails get captured automatically when users save books to their wishlist or add items to their cart.</td></tr>';
            return;
        }
        tbody.innerHTML = visible.map(r => {
            const book = r.bookTitle ? escapeHtml(r.bookTitle) : '';
            const when = r.updatedAt?.toDate?.() ? r.updatedAt.toDate().toLocaleString() : (r.createdAt?.toDate?.() ? r.createdAt.toDate().toLocaleString() : '—');
            const chipStyle = r.kind === 'wishlist' ? 'background:#e9e2f7; color:#4b2aad;' : 'background:#f8d7da; color:#721c24;';
            const kindLabel = r.kind === 'wishlist' ? 'Wishlist' : 'Abandoned cart';
            return `<tr>
                <td><input type="checkbox" class="email-check" data-email="${escapeHtml(r.email)}" ${selected.has(r.email) ? 'checked' : ''} /></td>
                <td style="font-weight:600;">${escapeHtml(r.email)}</td>
                <td><span class="chip" style="${chipStyle}">${kindLabel}</span></td>
                <td style="font-size:0.8rem; color:#6b5f52;">${book}</td>
                <td style="font-size:0.78rem; color:#8a7b6a;">${when}</td>
            </tr>`;
        }).join('');
        tbody.querySelectorAll('.email-check').forEach(cb => {
            cb.addEventListener('change', () => {
                if (cb.checked) selected.add(cb.dataset.email);
                else selected.delete(cb.dataset.email);
                selCountEl.textContent = selected.size + ' selected';
            });
        });
    };

    document.querySelectorAll('[data-ef]').forEach(b => {
        b.addEventListener('click', () => {
            currentFilter = b.dataset.ef;
            document.querySelectorAll('[data-ef]').forEach(x => x.style.opacity = '0.6');
            b.style.opacity = '1';
            renderRows();
        });
    });
    document.getElementById('emailSelectNone').addEventListener('click', () => {
        selected.clear();
        selCountEl.textContent = '0 selected';
        tbody.querySelectorAll('.email-check').forEach(cb => { cb.checked = false; });
    });
    document.getElementById('emailSelectAll').addEventListener('click', () => {
        const visible = rows.filter(r => currentFilter === 'all' || r.kind === currentFilter);
        visible.forEach(r => selected.add(r.email));
        selCountEl.textContent = selected.size + ' selected';
        tbody.querySelectorAll('.email-check').forEach(cb => { cb.checked = true; });
    });

    document.getElementById('emailSendNow').addEventListener('click', () => {
        const subject = document.getElementById('emailSubject').value.trim();
        const body = document.getElementById('emailBody').value.trim();
        if (selected.size === 0) { status('Select at least one email.', msg); return; }
        if (!subject && !body) { status('Add a subject or message body.', msg); return; }
        const bcc = [...selected].join(',');
        const url = 'mailto:?bcc=' + encodeURIComponent(bcc) + '&subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
        window.location.href = url;
        status('Opened your email app with ' + selected.size + ' recipient(s) in BCC.', msg);
    });

    document.getElementById('emailSendQueue').addEventListener('click', async () => {
        const subject = document.getElementById('emailSubject').value.trim();
        const body = document.getElementById('emailBody').value.trim();
        if (selected.size === 0) { status('Select at least one email.', msg); return; }
        if (!subject && !body) { status('Add a subject or message body.', msg); return; }
        try {
            const campaignRef = await addDoc(collection(db, "email-campaigns"), {
                subject, body, recipients: [...selected], count: selected.size,
                status: 'queued', platform: 'reads', createdAt: serverTimestamp()
            });
            const batch = writeBatch(db);
            [...selected].forEach(email => {
                const ref = doc(collection(db, "email-queue"));
                batch.set(ref, {
                    to: email, subject, body, campaignId: campaignRef.id,
                    status: 'pending', platform: 'reads', createdAt: serverTimestamp()
                });
            });
            await batch.commit();
            status('✅ Queued ' + selected.size + ' email(s) for sending later.', msg);
        } catch (e) {
            console.error('Queue email error:', e);
            status('Error queueing emails.', msg);
        }
    });

    onSnapshot(
        query(collection(db, "campaign-audiences"), orderBy("updatedAt", "desc"), limit(1000)),
        (snap) => {
            rows = [];
            snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
            renderSummary();
            renderRows();
            const badge = document.getElementById('emailsBadge');
            if (badge) badge.textContent = rows.length;
        },
        (err) => { console.warn('Email list listener error:', err); }
    );
}

// ================= REAL-TIME ANALYTICS =================

function initAnalytics() {
    const container = document.getElementById('tab-analytics');
    if (!container) return;

    container.innerHTML = `
        <p style="font-size:0.78rem; color:#8a7b6a; margin:0 0 0.6rem;"><i class="fas fa-sync-alt" style="color:#4b2aad;"></i> Updates in real time as visitors browse, add to cart, check out, and pay.</p>
        <div class="summary-grid" id="anSummary">
            <div class="summary-card"><div class="number purple">0</div><div class="label">Revenue</div></div>
            <div class="summary-card"><div class="number green">0</div><div class="label">Paid Orders</div></div>
            <div class="summary-card"><div class="number orange">0</div><div class="label">Books Sold</div></div>
            <div class="summary-card"><div class="number" style="color:#b76e4b;">0</div><div class="label">Coupon Redeems</div></div>
        </div>

        <div class="manage-table-wrap" style="margin-top:1.2rem;">
            <h3 style="font-weight:600; color:#2d2a24; margin:0 0 0.5rem;"><i class="fas fa-chart-line" style="color:#b76e4b;"></i> Checkout Funnel</h3>
            <div id="anFunnel" style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.8rem;"></div>
            <h3 style="font-weight:600; color:#2d2a24; margin:0 0 0.5rem;"><i class="fas fa-trophy" style="color:#b76e4b;"></i> Best Sellers</h3>
            <div class="email-table-scroll"><table class="admin-table"><thead><tr><th>Book</th><th>Sales</th><th>Revenue</th></tr></thead><tbody id="anBooks"></tbody></table></div>
        </div>

        <div class="manage-table-wrap" style="margin-top:1.2rem;">
            <h3 style="font-weight:600; color:#2d2a24; margin:0 0 0.5rem;"><i class="fas fa-users" style="color:#b76e4b;"></i> Revenue by Author</h3>
            <div class="email-table-scroll"><table class="admin-table"><thead><tr><th>Author</th><th>Sales</th><th>Revenue</th></tr></thead><tbody id="anAuthors"></tbody></table></div>
        </div>

        <div class="manage-table-wrap" style="margin-top:1.2rem;">
            <h3 style="font-weight:600; color:#2d2a24; margin:0 0 0.5rem;"><i class="fas fa-tags" style="color:#b76e4b;"></i> Coupon Usage</h3>
            <div class="email-table-scroll"><table class="admin-table"><thead><tr><th>Code</th><th>Uses</th><th>Discount given</th><th>Status</th></tr></thead><tbody id="anCoupons"></tbody></table></div>
        </div>`;

    let purchases = [];
    let events = [];
    let couponDocs = [];

    const render = async () => {
        const revenues = purchases.reduce((s, p) => s + (Number(p.chargedTotalGHS) || Number(p.amount) || 0), 0);
        document.querySelector('#anSummary .summary-card:nth-child(1) .number').textContent = GHS(revenues);
        document.querySelector('#anSummary .summary-card:nth-child(2) .number').textContent = purchases.length;
        document.querySelector('#anSummary .summary-card:nth-child(3) .number').textContent = purchases.reduce((s, p) => s + (Number(p.purchaseCount) || 1), 0);

        // Coupon redeems
        const byCoupon = new Map();
        purchases.forEach(p => {
            if (p.couponCode) {
                const c = byCoupon.get(p.couponCode) || { count: 0, discount: 0 };
                c.count += 1;
                c.discount += (Number(p.discountGHS) || 0);
                byCoupon.set(p.couponCode, c);
            }
        });
        document.querySelector('#anSummary .summary-card:nth-child(4) .number').textContent = [...byCoupon.values()].reduce((s, c) => s + c.count, 0);

        // Funnel
        const counts = { page_view: 0, view_book: 0, add_to_cart: 0, checkout_click: 0 };
        events.forEach(e => { if (counts[e.type] != null) counts[e.type]++; });
        const paid = purchases.length;
        const funnel = [
            { label: '👀 Visitors', n: counts.page_view },
            { label: '📖 Book views', n: counts.view_book },
            { label: '🛒 Added to cart', n: counts.add_to_cart },
            { label: '💳 Checkout clicks', n: counts.checkout_click },
            { label: '✅ Paid', n: paid }
        ];
        document.getElementById('anFunnel').innerHTML = funnel.map(f => {
            const pct = counts.page_view > 0 ? Math.round(100 * f.n / counts.page_view) + '%' : '—';
            return `<div style="background:#fffdf9; border:1px solid #ede7df; border-radius:10px; padding:0.5rem 0.9rem; min-width:96px; text-align:center;">
                <div style="font-size:1.15rem; font-weight:700; color:#4b2aad;">${f.n}</div>
                <div style="font-size:0.72rem; color:#8a7b6a;">${f.label}</div>
                <div style="font-size:0.68rem; color:#b76e4b;">${pct}</div></div>`;
        }).join('');

        // Best sellers by book
        const byBook = new Map();
        purchases.forEach(p => {
            const b = byBook.get(p.bookId) || { count: 0, revenue: 0, title: p.bookTitle || '' };
            b.count += (Number(p.purchaseCount) || 1);
            b.revenue += (Number(p.chargedTotalGHS) || Number(p.amount) || 0);
            if (!b.title && p.bookTitle) b.title = p.bookTitle;
            byBook.set(p.bookId, b);
        });
        const books = [...byBook.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 12);
        // enrich missing titles from books collection
        for (const [id, b] of books) {
            if (!b.title) {
                try { const s = await getDoc(doc(db, "books", id)); if (s.exists()) b.title = s.data().title || 'Untitled'; }
                catch (e) { b.title = 'Untitled'; }
            }
        }
        document.getElementById('anBooks').innerHTML = books.length ? books.map(([id, b]) => `
            <tr><td>${escapeHtml(b.title)}</td><td>${b.count}</td><td>${GHS(b.revenue)}</td></tr>`).join('')
            : '<tr><td colspan="3" style="color:#8a7b6a; text-align:center;">No sales yet.</td></tr>';

        // Revenue by author
        const byAuthor = new Map();
        purchases.forEach(p => {
            const aid = p.authorId || 'unsorted';
            const a = byAuthor.get(aid) || { count: 0, revenue: 0 };
            a.count += (Number(p.purchaseCount) || 1);
            a.revenue += (Number(p.chargedTotalGHS) || Number(p.amount) || 0);
            byAuthor.set(aid, a);
        });
        const authors = [...byAuthor.entries()].sort((x, y) => y[1].revenue - x[1].revenue).slice(0, 12);
        const names = {};
        const namePromises = authors.filter(([aid]) => aid !== 'unsorted').map(async ([aid]) => {
            try { const s = await getDoc(doc(db, "users", aid)); if (s.exists()) { const d = s.data(); names[aid] = d.authorName || d.username || d.displayName || aid; } else names[aid] = aid; }
            catch (e) { names[aid] = aid; }
        });
        await Promise.all(namePromises);
        document.getElementById('anAuthors').innerHTML = authors.map(([aid, a]) => `
            <tr><td>${escapeHtml(names[aid] || (aid === 'unsorted' ? 'Uncategorised' : aid))}</td><td>${a.count}</td><td>${GHS(a.revenue)}</td></tr>`).join('')
            || '<tr><td colspan="3" style="color:#8a7b6a; text-align:center;">No data yet.</td></tr>';

        // Coupon usage table (live listener too)
        const couponRows = couponDocs.map(c => {
            const used = byCoupon.get((c.code || '').toUpperCase()) || { count: 0, discount: 0 };
            const status = c.active === false ? 'Paused' : 'Active';
            return `<tr><td style="font-weight:600;">${escapeHtml(c.code || c.id)}</td><td>${used.count}</td><td>${GHS(used.discount)}</td><td>${status}</td></tr>`;
        });
        // add coupon codes seen only in purchases
        [...byCoupon.keys()].forEach(code => {
            if (!couponDocs.some(c => (c.code || '').toUpperCase() === code.toUpperCase())) {
                const c = byCoupon.get(code);
                couponRows.push(`<tr><td style="font-weight:600;">${escapeHtml(code)}</td><td>${c.count}</td><td>${GHS(c.discount)}</td><td>—</td></tr>`);
            }
        });
        document.getElementById('anCoupons').innerHTML = couponRows.length ? couponRows.join('') : '<tr><td colspan="4" style="color:#8a7b6a; text-align:center;">No coupon usage yet.</td></tr>';

        const badge = document.getElementById('analyticsBadge');
        if (badge) badge.textContent = purchases.length;
    };

    render();

    onSnapshot(
        query(collection(db, "purchases"), where("platform", "==", "reads"), limit(500)),
        (snap) => { purchases = []; snap.forEach(d => purchases.push(d.data())); render(); },
        (err) => { console.warn('Analytics purchase listener error:', err); }
    );

    onSnapshot(
        query(collection(db, "analytics-events"), where("platform", "==", "reads"), limit(2000)),
        (snap) => { events = []; snap.forEach(d => events.push(d.data())); render(); },
        (err) => { console.warn('Analytics event listener error:', err); }
    );

    onSnapshot(
        query(collection(db, "coupons"), orderBy("createdAt", "desc"), limit(200)),
        (snap) => { couponDocs = []; snap.forEach(d => couponDocs.push({ id: d.id, ...d.data() })); render(); },
        (err) => { console.warn('Analytics coupon listener error:', err); }
    );
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
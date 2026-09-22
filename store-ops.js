// store/store-ops.js — shared helpers: analytics events + email capture for campaigns.
// Self-contained Firebase module (uses the page importmap for bare specifiers when loaded
// from an importmap-enabled page; otherwise falls back to bundled CDN module).
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
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

let currentEmail = '';
let currentUid = '';
let userLoaded = false;

onAuthStateChanged(auth, (user) => {
    currentEmail = (user && user.email) || '';
    currentUid = (user && user.uid) || '';
    userLoaded = true;
});

export function getUserEmail() {
    return currentEmail;
}

export function getUserUid() {
    return currentUid;
}

// Session-scoped "page viewed" marker so each visit records one page_view per page.
export function logPageView(type) {
    const key = 'volant_viewed_' + type;
    try {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');
    } catch (e) {}
    logEvent('page_view', { view: type });
}

export function logEvent(type, extra = {}) {
    try {
        return setDoc(doc(collection(db, "analytics-events")), {
            type: type,
            platform: 'reads',
            email: currentEmail || null,
            uid: currentUid || null,
            time: Date.now(),
            ...extra,
            ts: serverTimestamp()
        });
    } catch (e) {
        return Promise.resolve();
    }
}

// Persist an email into a campaign audience. kind: 'wishlist' | 'abandoned-cart' | 'subscriber'.
export function captureCampaignEmail(kind, meta = {}) {
    const email = currentEmail;
    if (!email) return Promise.resolve();
    const key = email.toLowerCase().replace(/[^a-z0-9._@-]/g, '');
    if (!key || key.length < 3) return Promise.resolve();
    try {
        return setDoc(doc(db, "campaign-audiences", kind + '_' + key), {
            kind: kind,
            email: email,
            platform: 'reads',
            ...meta,
            updatedAt: serverTimestamp()
        }, { merge: true });
    } catch (e) {
        return Promise.resolve();
    }
}

// Abandoned-cart record keyed by email (one active record per account).
export function captureAbandonedCart(items, extra = {}) {
    const email = currentEmail;
    if (!email || !Array.isArray(items) || items.length === 0) return Promise.resolve();
    try {
        const list = items.map((i) => ({
            id: i.id || null,
            title: i.title || 'Untitled',
            author: i.author || '',
            price: Number(i.price) || 0,
            currency: i.currency || 'GHS'
        }));
        const key = email.toLowerCase().replace(/[^a-z0-9._@-]/g, '');
        if (!key) return Promise.resolve();
        return setDoc(doc(db, "abandoned-carts", key), {
            email: email,
            items: list,
            itemCount: items.length,
            totalEstimate: list.reduce((s, i) => s + i.price, 0),
            ...extra,
            updatedAt: serverTimestamp()
        }, { merge: true });
    } catch (e) {
        return Promise.resolve();
    }
}

export function clearAbandonedCart() {
    const email = currentEmail;
    if (!email) return Promise.resolve();
    const key = email.toLowerCase().replace(/[^a-z0-9._@-]/g, '');
    if (!key) return Promise.resolve();
    try {
        return deleteDoc(doc(db, "abandoned-carts", key));
    } catch (e) {
        return Promise.resolve();
    }
}
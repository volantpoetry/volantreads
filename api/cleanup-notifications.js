// ============================================================
// FILE: store1/api/cleanup-notifications.js  (volantreads.vercel.app)
// ============================================================
// Retention policy: notifications and store messages are removed
// 90 days after they were created (matching the dashboard bell).
//
// Deletes from the shared silent-depth project:
//   • notifications where timestamp < now - 90 days
//   • messages       where createdAt    < now - 90 days
//
// Triggered by Vercel Cron (see "crons" in store1/vercel.json) as GET,
// or manually as GET/POST (returns counts, no body needed).
//
// Requires: SERVICE_ACCOUNT_KEY (or SERVICE_ACCOUNT). Without it
// the function returns 200 { configured:false } like the other crons.
// ============================================================

const { db, loadAdmin } = require('./../lib/store-admin.js');

const RETENTION_DAYS = 90;
const BATCH_SIZE = 400;

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Use GET (cron) or POST.' });
    }

    try {
        loadAdmin();
    } catch (err) {
        console.warn('cleanup-notifications: Firebase Admin not configured ->', err.message);
        return res.json({ success: true, configured: false, message: 'Service account not configured.' });
    }

    const dbx = db();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    async function purge(collectionName, fieldName) {
        let deleted = 0;
        let page;
        try {
            page = await dbx.collection(collectionName).where(fieldName, '<', cutoff).limit(BATCH_SIZE).get();
        } catch (err) {
            console.warn(`cleanup-notifications: ${collectionName} query failed ->`, err.message);
            return { deleted, error: err.message };
        }
        while (page.size > 0) {
            const batch = dbx.batch();
            page.docs.forEach((ds) => batch.delete(ds.ref));
            await batch.commit();
            deleted += page.size;
            page = await dbx.collection(collectionName).where(fieldName, '<', cutoff).limit(BATCH_SIZE).get();
        }
        return { deleted };
    }

    try {
        const notifications = await purge('notifications', 'timestamp');
        const messages = await purge('messages', 'createdAt');
        return res.json({
            success: true,
            configured: true,
            retentionDays: RETENTION_DAYS,
            deletedNotifications: notifications.deleted,
            deletedMessages: messages.deleted,
            notificationsError: notifications.error || null,
            messagesError: messages.error || null
        });
    } catch (err) {
        console.error('cleanup-notifications error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
    }
};
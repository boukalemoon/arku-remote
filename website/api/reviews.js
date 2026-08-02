/**
 * Arku Remote tanıtım sitesi — Kullanıcı yorumları (Vercel serverless, Node).
 *
 *   GET  /api/reviews  → yalnızca ONAYLI yorumlar (herkese açık alanlar)
 *   POST /api/reviews  → yeni yorum gönderimi; HER ZAMAN status='pending'
 *
 * Yorumlar Nexus'un Firestore veritabanına `arku_reviews` koleksiyonuna
 * Firebase Admin ile yazılır. Moderasyon (onay/ret) Nexus CRM →
 * Pazarlama → Arku → Yorumlar sekmesinden yapılır.
 *
 * TASARIM KURALI: hiçbir yorum moderasyondan geçmeden görünür olamaz.
 * İstemci status/publishedAt gönderemez — bu alanlar sunucuda sabitlenir.
 * contact_email yalnızca Nexus'ta görünür, GET yanıtında ASLA yer almaz.
 *
 * KURULUM: track.js ile aynı FIREBASE_SERVICE_ACCOUNT ortam değişkenini kullanır.
 */

'use strict';

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const DATABASE_ID = 'ai-studio-01b23ae1-726c-4e78-8f1b-3f0cefc7a2eb';
const COLLECTION  = 'arku_reviews';

const ALLOWED_HOSTS = [
  'arku-remote-website.vercel.app',
  'www.arku.com.tr',
  'arku.com.tr',
];

const BOT_UA = /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|preview|scan|monitor|lighthouse|curl|wget|python-requests|axios|node-fetch|go-http|okhttp/i;

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function isFromSite(req) {
  const oh = req.headers.origin ? hostOf(req.headers.origin) : '';
  const rh = (req.headers.referer || req.headers.referrer)
    ? hostOf(req.headers.referer || req.headers.referrer) : '';
  return ALLOWED_HOSTS.includes(oh) || ALLOWED_HOSTS.includes(rh);
}

let _db = null;
function db() {
  if (_db) return _db;
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT tanımlı değil');
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  _db = getFirestore(DATABASE_ID);
  return _db;
}

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

module.exports = async (req, res) => {
  // ── Onaylı yorumları listele ──────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const snap = await db().collection(COLLECTION)
        .where('status', '==', 'approved')
        .limit(50)
        .get();

      const rows = snap.docs
        .map((d) => {
          const r = d.data() || {};
          // Yalnızca herkese açık alanlar. contactEmail bilerek dışarıda.
          return {
            id: d.id,
            authorName: r.authorName || '',
            authorTitle: r.authorTitle || '',
            rating: r.rating || 0,
            body: r.body || '',
            publishedAt: r.publishedAt || 0,
          };
        })
        .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
        .slice(0, 24);

      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json(rows);
    } catch (e) {
      // Yorum listesi alınamazsa sayfa yine açılsın; boş liste dön.
      return res.status(200).json([]);
    }
  }

  // ── Yeni yorum gönderimi ──────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const ua = String(req.headers['user-agent'] || '');
      if (!isFromSite(req) || BOT_UA.test(ua)) return res.status(204).end();

      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'bad_json' }); }
      }
      body = body || {};

      // Bot tuzağı: gerçek kullanıcılar bu alanı görmez ve doldurmaz.
      if (clean(body.website, 80)) return res.status(204).end();

      const authorName = clean(body.authorName, 80);
      const text       = clean(body.body, 2000);
      if (authorName.length < 2)  return res.status(400).json({ error: 'name_too_short' });
      if (text.length < 10)       return res.status(400).json({ error: 'body_too_short' });

      const ratingRaw = parseInt(body.rating, 10);
      const rating = ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : 0;

      await db().collection(COLLECTION).add({
        authorName,
        authorTitle:  clean(body.authorTitle, 120),
        contactEmail: clean(body.contactEmail, 160), // yalnızca Nexus'ta görünür
        rating,
        body: text,
        // Sunucuda sabitlenir — istemci bunları etkileyemez.
        status: 'pending',
        publishedAt: 0,
        moderatedBy: '',
        source: 'website',
        createdAt: Date.now(),
        day: new Date().toISOString().slice(0, 10),
      });

      return res.status(201).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'server_error' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
};

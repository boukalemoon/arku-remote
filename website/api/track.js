/**
 * Arku Remote tanıtım sitesi — Analitik olay toplama (Vercel serverless, Node).
 *
 * POST /api/track  → { type: 'pageview'|'click'|'download', vid, area?, platform?, path?, ref? }
 *
 * Olaylar Nexus'un Firestore veritabanına `arku_events` koleksiyonuna Firebase
 * Admin ile yazılır. Nexus CRM → Pazarlama → Arku paneli bunları görselleştirir.
 *
 * KURULUM: Vercel proje ayarlarında (arku-remote-website) FIREBASE_SERVICE_ACCOUNT
 * ortam değişkenine servis hesabı JSON'ının tamamı girilmelidir.
 */

'use strict';

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const DATABASE_ID = 'ai-studio-01b23ae1-726c-4e78-8f1b-3f0cefc7a2eb';
const COLLECTION  = 'arku_events';

// Yalnızca Arku sitesinden gelen olaylar sayılır.
const ALLOWED_HOSTS = [
  'arku-remote-website.vercel.app',
  'www.arku.com.tr',
  'arku.com.tr',
];

const BOT_UA = /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|preview|scan|monitor|lighthouse|curl|wget|python-requests|axios|node-fetch|go-http|okhttp/i;

/** İndirilen dosya adından platform çıkarımı. */
const PLATFORMS = ['windows', 'macos', 'linux'];

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function parseUA(ua) {
  const u = ua || '';
  let os = 'Diğer';
  if (/Windows NT/i.test(u)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(u)) os = 'iOS';
  else if (/Mac OS X/i.test(u)) os = 'macOS';
  else if (/Android/i.test(u)) os = 'Android';
  else if (/CrOS/i.test(u)) os = 'ChromeOS';
  else if (/Linux/i.test(u)) os = 'Linux';

  let device = 'Masaüstü';
  if (/iPad|Tablet/i.test(u)) device = 'Tablet';
  else if (/Mobi|iPhone|iPod|Windows Phone|Android.*Mobile/i.test(u)) device = 'Mobil';
  else if (/Android/i.test(u)) device = 'Tablet';

  const mobile = device !== 'Masaüstü';
  let browser = 'Diğer';
  if (/Edg(A|iOS)?\//i.test(u)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(u)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(u)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/i.test(u)) browser = 'Firefox';
  else if (/CriOS\//i.test(u)) browser = mobile ? 'Chrome Mobile' : 'Chrome';
  else if (/Chrome\//i.test(u)) browser = mobile ? 'Chrome Mobile' : 'Chrome';
  else if (/Safari\//i.test(u)) browser = 'Safari';
  return { device, browser, os };
}

function geoOf(req) {
  const h = req.headers;
  const dec = (s) => { try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); } };
  const ipRaw = String(h['x-forwarded-for'] || h['x-real-ip'] || h['x-vercel-forwarded-for'] || '')
    .split(',')[0].trim();
  return {
    country: String(h['x-vercel-ip-country'] || '').slice(0, 4),
    city: dec(h['x-vercel-ip-city']).slice(0, 60),
    ip: ipRaw.slice(0, 45),
  };
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const ua = String(req.headers['user-agent'] || '');
    if (!isFromSite(req) || BOT_UA.test(ua)) return res.status(204).end();

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).end(); }
    }
    body = body || {};

    const allowed = ['pageview', 'click', 'download'];
    const type = allowed.includes(body.type) ? body.type : null;
    if (!type) return res.status(400).end();

    const platform = PLATFORMS.includes(body.platform) ? body.platform : '';

    const now = new Date();
    const p = parseUA(ua);
    const g = geoOf(req);

    await db().collection(COLLECTION).add({
      type,
      platform,                                    // yalnızca download olaylarında dolu
      vid:  String(body.vid  || 'anon').slice(0, 64),
      area: String(body.area || '').slice(0, 60),
      path: String(body.path || '').slice(0, 200),
      ref:  String(body.ref  || '').slice(0, 200),
      device:  p.device,
      browser: p.browser,
      os:      p.os,
      country: g.country,
      city:    g.city,
      ip:      g.ip,
      ts:   Date.now(),
      day:  now.toISOString().slice(0, 10),
    });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
};

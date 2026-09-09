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

const crypto = require('node:crypto');
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

/**
 * IP anonimleştirme.
 *
 * NEDEN: IP adresi, bir kişiye bağlanabildiği anda KİŞİSEL VERİDİR (KVKK).
 * Ziyaretçi analitiği için ham IP saklamaya gerek yok; tek ihtiyaç "aynı
 * ziyaretçi mi" sorusudur. Bunu günlük dönen, gizli tuzlu bir özet çözer:
 * geri çevrilemez, ertesi gün eşleşmez, sayım yine doğru çalışır.
 *
 * TUZ ŞART: IPv4 uzayı 4 milyar adrestir; tuzsuz bir özet kaba kuvvetle
 * çözülür. ANALYTICS_IP_SALT tanımlı değilse HİÇBİR IP türevi saklanmaz —
 * gizliliği koruyan güvenli varsayılan budur.
 */
const IP_SALT = process.env.ANALYTICS_IP_SALT || '';

function ipHash(ip) {
  if (!IP_SALT || !ip) return '';
  const gun = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256')
    .update(IP_SALT + '|' + gun + '|' + ip)
    .digest('hex')
    .slice(0, 16);
}

function geoOf(req) {
  const h = req.headers;
  const dec = (s) => { try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); } };
  const ipRaw = String(h['x-forwarded-for'] || h['x-real-ip'] || h['x-vercel-forwarded-for'] || '')
    .split(',')[0].trim();
  return {
    country: String(h['x-vercel-ip-country'] || '').slice(0, 4),
    city: dec(h['x-vercel-ip-city']).slice(0, 60),
    // Ham IP DÖNMEZ; yalnızca bellekte hız sınırı için kullanılır.
    ipRaw,
    ipHash: ipHash(ipRaw),
  };
}

/**
 * Basit kayan pencere hız sınırı (örnek başına bellekte).
 *
 * SINIR: Vercel'de her örnek kendi belleğini tutar, dolayısıyla bu mutlak
 * bir tavan değildir. Yine de asıl senaryoyu — tek kaynaktan gelen hızlı
 * sel — kırar, çünkü art arda gelen istekler aynı sıcak örneğe düşer.
 * Kesin tavan gerekirse Firestore/Redis sayacına geçilmelidir; o da her
 * olay için ekstra yazma maliyeti demektir.
 */
const RATE = new Map();
const RATE_LIMIT = 60;          // pencere başına olay
const RATE_WINDOW_MS = 60000;   // 1 dakika
const RATE_MAX_KEYS = 5000;     // bellek tavanı

function rateLimited(key) {
  if (!key) return false;
  const now = Date.now();
  // Bellek şişmesin: pencere dolmuş kayıtları temizle.
  if (RATE.size > RATE_MAX_KEYS) {
    for (const [k, v] of RATE) if (v.reset <= now) RATE.delete(k);
    if (RATE.size > RATE_MAX_KEYS) RATE.clear();
  }
  const rec = RATE.get(key);
  if (!rec || rec.reset <= now) {
    RATE.set(key, { count: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT;
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

    // Hız sınırı: Origin/Referer başlıkları taklit edilebilir, dolayısıyla
    // isFromSite tek başına sahte olay selini durdurmaz. Bu sınır sınırsız
    // Firestore yazımını (maliyet + veri kirliliği) engeller.
    const g0 = geoOf(req);
    if (rateLimited(g0.ipRaw)) return res.status(429).end();

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
    const g = g0;

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
      // Ham IP SAKLANMAZ (KVKK). Günlük dönen tuzlu özet: geri çevrilemez,
      // ertesi gün eşleşmez, tekil ziyaretçi sayımı yine çalışır.
      // ANALYTICS_IP_SALT tanımlı değilse bu alan boş kalır.
      ip_hash: g.ipHash,
      ts:   Date.now(),
      day:  now.toISOString().slice(0, 10),
    });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
};

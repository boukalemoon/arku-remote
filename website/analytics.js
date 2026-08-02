/**
 * Arku Remote sitesi — hafif analitik istemcisi.
 *
 * Sayfa görüntüleme, tıklama ve **indirme** olaylarını /api/track uç noktasına
 * gönderir; oradan Firestore `arku_events` koleksiyonuna yazılır ve
 * Nexus CRM → Pazarlama → Arku panelinde görselleştirilir.
 *
 * İndirmeler otomatik yakalanır: GitHub release bağlantılarına tıklandığında
 * dosya uzantısından platform çıkarılır (.exe → windows, .dmg → macos,
 * .AppImage/.deb/.rpm → linux). HTML'de ayrıca etiket gerekmez.
 *
 * Diğer butonları izlemek için `data-arku="alan-adi"` eklemek yeterli.
 *
 * Gizlilik: çerez yok. Ziyaretçiyi ayırt etmek için localStorage'da rastgele
 * bir kimlik tutulur. Tarayıcıda "izleme yok" (DNT) açıksa hiçbir şey gönderilmez.
 */
(function () {
  'use strict';

  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;

  var KEY = 'arku_vid';
  var vid;
  try {
    vid = localStorage.getItem(KEY);
    if (!vid) {
      vid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(KEY, vid);
    }
  } catch (e) {
    vid = 'anon';
  }

  function send(payload) {
    var data = { vid: vid, path: location.pathname + location.hash, ref: document.referrer || '' };
    for (var k in payload) data[k] = payload[k];
    var body = JSON.stringify(data);

    // sendBeacon sayfa kapanırken bile iletir — indirme tıklamasında kritik.
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
        return;
      }
    } catch (e) { /* engellenmişse fetch'e düş */ }

    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true,
    }).catch(function () { /* analitik hatası sayfayı etkilemez */ });
  }

  /** İndirme bağlantısının dosya adından platform çıkarımı. */
  function platformOf(href) {
    var h = (href || '').toLowerCase();
    if (h.indexOf('.exe') >= 0 || h.indexOf('.msi') >= 0) return 'windows';
    if (h.indexOf('.dmg') >= 0 || h.indexOf('.pkg') >= 0) return 'macos';
    if (h.indexOf('.appimage') >= 0 || h.indexOf('.deb') >= 0 || h.indexOf('.rpm') >= 0) return 'linux';
    return '';
  }

  // ── Sayfa görüntüleme ──────────────────────────────────────────────────────
  function pageview() { send({ type: 'pageview' }); }
  if (document.readyState === 'complete' || document.readyState === 'interactive') pageview();
  else document.addEventListener('DOMContentLoaded', pageview);

  // ── Tıklama ve indirme ─────────────────────────────────────────────────────
  // Olay delegasyonu: sayfa sonradan değişse de yakalanır.
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('a,[data-arku]') : null;
    if (!el) return;

    var href = el.getAttribute && el.getAttribute('href');

    // 1) İndirme — GitHub release bağlantıları otomatik sayılır
    if (href && href.indexOf('releases/latest/download') >= 0) {
      var plat = platformOf(href);
      send({ type: 'download', platform: plat, area: 'indir-' + (plat || 'bilinmiyor') });
      return;
    }

    // 2) Elle etiketlenmiş alanlar
    var area = el.getAttribute && el.getAttribute('data-arku');
    if (area) send({ type: 'click', area: area });
  }, true);

  // ── Hash değişimi (tek sayfa gezinme) ──────────────────────────────────────
  var lastHash = location.hash;
  window.addEventListener('hashchange', function () {
    if (location.hash === lastHash) return;
    lastHash = location.hash;
    pageview();
  });
})();

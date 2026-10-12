// Arku Remote — karşı taraftan gelen "hangup" sinyalinin kullanıcıya açıklaması.

/**
 * Bu istemcinin alıcı olarak gönderdiği hangup'lara eklediği protokol işareti.
 * 2 = HMAC parola kanıtını (pwh) tanıyan alıcı (v1.6.0+). v1.4.0 bu alanı
 * hiç göndermez.
 */
export const HANGUP_PROTO = 2;

/**
 * hangup payload'ından günlük satırını üretir.
 *
 * `badpass` + proto yok: cevap v1.4.0 (ya da öncesi) bir alıcıdan geliyor.
 * O sürüm yeni parola kanıtını tanımadığı için DOĞRU parola da "hatalı"
 * görünür; kullanıcıyı parolayla uğraştırmak yerine gerçek sebep söylenir.
 */
export function describeHangup(payload: unknown): string {
  const hp = (payload && typeof payload === 'object' ? payload : {}) as { reason?: unknown; proto?: unknown };
  const reason = hp.reason;
  const legacyPeer = !(typeof hp.proto === 'number' && hp.proto >= HANGUP_PROTO);
  switch (reason) {
    case 'busy': return 'Karsi taraf mesgul, su an baska bir oturumda.';
    case 'rejected': return 'Baglanti istegi reddedildi.';
    case 'outdated': return 'Karsi tarafin uygulamasi guncel degil. Baglanabilmek icin once uygulamasini guncellemesi gerekiyor.';
    case 'badpass': return legacyPeer
      ? 'Parola reddedildi. Karsi taraf eski bir surum (v1.4.0 veya oncesi) kullaniyor; bu surum yeni parola dogrulamasini tanimaz. Parolanin dogru oldugundan eminseniz karsi tarafin uygulamasini guncellemesi gerekiyor.'
      : 'Oturum parolasi hatali. Karsi tarafin ekranindaki parolayi kontrol edin.';
    case 'unsupported': return 'Karsi cihaz ekranini paylasamiyor: mobil tarayicilar (Android/iOS) ekran paylasimini desteklemiyor. Paylasan taraf bilgisayar olmali.';
    default: return 'Karsi taraf baglantıyi kesti.';
  }
}

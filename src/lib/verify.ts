// Arku Remote — Bağlantı doğrulama (kısa doğrulama kodu / SAS).
//
// ── NEDEN KENDİ ŞİFRELEMEMİZİ YAZMIYORUZ ────────────────────────────────────
// WebRTC trafiği ZATEN uçtan uca şifrelidir: medya SRTP (AES-GCM), veri
// kanalı SCTP-over-DTLS. Anahtar değişimi DTLS el sıkışmasıyla iki uç
// arasında yapılır — sunucumuz anahtarları hiç görmez. Bu, bir VPN'in
// kullandığı primitiflerin aynısıdır. Üstüne ikinci bir "özel algoritma"
// koymak güvenlik EKLEMEZ; CPU ve hata yüzeyi ekler. Şifreleme sistemleri
// matematikleri zayıf olduğu için değil, uygulamaları sızdırdığı için
// (zamanlama, nonce tekrarı, dolgu hataları) kırılır.
//
// ── ASIL AÇIK: ŞİFRELİ, AMA KİME? ──────────────────────────────────────────
// DTLS el sıkışmasında taraflar birbirinin sertifika PARMAK İZİNİ SDP ile
// alır. Bizde SDP, Supabase `signals` tablosundan geçer. Bu tabloya ortada
// yazabilen biri (ele geçirilmiş veritabanı, çalınmış service_role anahtarı,
// kötü niyetli yönetici) kendi parmak izini koyup araya girebilir:
// her iki tarafla AYRI AYRI şifreli konuşur, trafiği açık görür.
// Bağlantı yine "şifreli" görünür — saldırgana şifrelidir.
//
// ── ÇÖZÜM: MEVCUT ŞİFRELEMENİN KİMLİĞİNİ DOĞRULAMAK ────────────────────────
// Yeni şifreleme değil, var olanın karşı tarafını doğrulamak gerekir.
// İki parmak izinden türetilen kısa bir kod her iki ekranda gösterilir;
// kullanıcılar telefonda karşılaştırır. Araya giren biri iki farklı DTLS
// oturumu kurmak zorunda olduğu için parmak izleri —dolayısıyla kodlar—
// TUTMAZ. ZRTP (PGP'nin yaratıcısı Zimmermann) ve Signal'in "güvenlik
// numarası" tam olarak bu yöntemi kullanır.
//
// Oturum parolası da türetmeye karıştırılır: sinyalleşmeyi tümüyle kontrol
// eden ama parolayı bilmeyen bir saldırgan eşleşen bir kod üretemez.

/** SDP'den DTLS sertifika parmak izini çıkarır. */
export function fingerprintFromSdp(sdp: string | undefined | null): string | null {
  if (!sdp) return null;
  // Örnek satır: a=fingerprint:sha-256 AB:CD:...:EF
  const m = sdp.match(/^a=fingerprint:\s*(\S+)\s+(\S+)/im);
  if (!m) return null;
  return `${m[1].toLowerCase()} ${m[2].toUpperCase()}`;
}

/**
 * Doğrulama kodu alfabesi — telefonda okunacak.
 * Oturum parolasıyla aynı gerekçe: 32 karakter (modulo sapması yok),
 * karıştırılabilir 0/O ve 1/I yok.
 */
const SAS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * İki parmak izinden ortak bir doğrulama kodu türetir.
 *
 * Parmak izleri SIRALANIR: arayan ve alıcı aynı kodu hesaplamalı, ama
 * hangisinin "yerel" olduğu taraflara göre değişir.
 *
 * @param localFp  bizim DTLS parmak izimiz
 * @param remoteFp karşı tarafın DTLS parmak izi
 * @param password oturum parolası (varsa) — türetmeye karıştırılır
 */
export async function deriveVerificationCode(
  localFp: string,
  remoteFp: string,
  password: string,
): Promise<string | null> {
  // file:// dahil Chromium'da subtle mevcuttur; yine de yokluğunda
  // doğrulama kodunu göstermemek, yanlış kod göstermekten iyidir.
  if (!globalThis.crypto?.subtle) return null;
  try {
    const material = [localFp, remoteFp].sort().join('|');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password || 'arku-no-password'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(material)),
    );
    // 6 karakter = 32^6 ≈ 1,07 milyar. Araya girenin doğru kodu tutturma
    // şansı milyarda bir; kullanıcı yanlışı görür.
    let out = '';
    for (let i = 0; i < 6; i++) out += SAS_ALPHABET[sig[i] % SAS_ALPHABET.length];
    return out;
  } catch {
    return null;
  }
}

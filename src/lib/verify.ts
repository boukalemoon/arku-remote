// Arku Remote — Bağlantı doğrulama (kısa doğrulama kodu / SAS) ve oturum
// parolasının kanıtı.
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
// ── PAROLA NEDEN ARTIK TÜRETMEYE KARIŞMIYOR (2026-09-12) ───────────────────
// Önceki sürümde oturum parolası SAS türetmesine karıştırılıyordu; gerekçe
// "sinyalleşmeyi kontrol eden ama parolayı bilmeyen saldırgan eşleşen kod
// üretemez" idi. İki sorunu vardı:
//
//   1) Parola, tam olarak o saldırganın kontrol ettiği varsayılan kanaldan
//      (signals.payload.pw) DÜZ METİN geçiyordu. Yani varsayım zaten
//      geçersizdi: saldırgan parolayı okuyup eşleşen kodu üretebilirdi.
//   2) İki taraf parola konusunda anlaşamadığında (alıcı parolayı zorunlu
//      tutmuyor, arayan rastgele bir şey yazmış) kodlar TUTMUYOR ve
//      kullanıcıya sahte bir "araya girme" uyarısı gösteriliyordu.
//
// Parolanın SAS'a kattığı gerçek bir güvenlik yoktu: araya giren biri iki
// ayrı DTLS oturumu kurmak zorunda olduğu için parmak izleri her durumda
// farklıdır. Bu yüzden roller ayrıldı:
//
//   * SAS  = yalnızca parmak izlerinden türetilir (araya girme tespiti).
//   * PAROLA = yalnızca erişim denetimi; artık düz metin gitmez, oturum
//     kimliğine bağlı bir HMAC kanıtı olarak gider (derivePasswordProof).
//     Böylece veritabanına erişen biri parolayı öğrenemez.

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

/** Türetmeye bağlam ayrımı: aynı girdi başka bir amaçla aynı çıktıyı vermesin. */
const SAS_DOMAIN = 'arku-sas-v2';
const PW_DOMAIN = 'arku-pw-v1';

async function hmacSha256(keyText: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyText),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/**
 * İki parmak izinden ortak bir doğrulama kodu türetir.
 *
 * Parmak izleri SIRALANIR: arayan ve alıcı aynı kodu hesaplamalı, ama
 * hangisinin "yerel" olduğu taraflara göre değişir.
 *
 * @param localFp  bizim DTLS parmak izimiz
 * @param remoteFp karşı tarafın DTLS parmak izi
 */
export async function deriveVerificationCode(
  localFp: string,
  remoteFp: string,
): Promise<string | null> {
  // file:// dahil Chromium'da subtle mevcuttur; yine de yokluğunda
  // doğrulama kodunu göstermemek, yanlış kod göstermekten iyidir.
  if (!globalThis.crypto?.subtle) return null;
  try {
    const material = [localFp, remoteFp].sort().join('|');
    const sig = await hmacSha256(SAS_DOMAIN, material);
    // 6 karakter = 32^6 ≈ 1,07 milyar. Araya girenin doğru kodu tutturma
    // şansı milyarda bir; kullanıcı yanlışı görür.
    let out = '';
    for (let i = 0; i < 6; i++) out += SAS_ALPHABET[sig[i] % SAS_ALPHABET.length];
    return out;
  } catch {
    return null;
  }
}

/** Parolayı normalize eder — iki taraf aynı biçimi kullanmalı. */
const normalizePassword = (pw: string): string => pw.trim().toUpperCase();

/**
 * Oturum parolasının kanıtını üretir: HMAC(parola, oturum_kimliği).
 *
 * NEDEN OTURUM KİMLİĞİNE BAĞLI: sabit bir özet, bir kez yakalandığında
 * sonsuza kadar tekrar oynatılabilirdi (replay). Oturum kimliği her çağrı
 * için yeniden üretildiği ve arayan tarafından belirlendiği için kanıt da
 * tek kullanımlık olur.
 *
 * crypto.subtle yoksa null döner; çağıran taraf o durumda eski düz metin
 * yoluna düşmez — parola göndermemek, parolayı sızdırmaktan iyidir.
 */
export async function derivePasswordProof(
  password: string,
  sessionId: string,
): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const pw = normalizePassword(password);
  if (!pw) return null;
  try {
    const sig = await hmacSha256(`${PW_DOMAIN}|${pw}`, sessionId);
    return Array.from(sig.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** Sabit süreli karşılaştırma — parola kanıtı için zamanlama sızıntısını kapatır. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Gelen offer'ın taşıdığı parola kanıtını doğrular.
 *
 * İki biçim desteklenir:
 *   `pwh` — HMAC kanıtı (v1.5.0+ arayan). Tercih edilen yol.
 *   `pw`  — düz metin parola (v1.4.0 arayan). GERİYE DÖNÜK UYUMLULUK için
 *           kabul edilir; o istemciler güncellenince bu dal kaldırılmalı.
 *
 * @returns doğrulandıysa true; parola hiç gelmediyse ya da tutmadıysa false
 */
export async function verifyOfferPassword(
  payload: Record<string, unknown> | null | undefined,
  sessionId: string | null | undefined,
  expectedPassword: string,
): Promise<boolean> {
  const expected = normalizePassword(expectedPassword);
  if (!expected) return false;

  const proof = payload?.pwh;
  if (typeof proof === 'string' && proof && sessionId) {
    const mine = await derivePasswordProof(expected, sessionId);
    return !!mine && constantTimeEqual(proof, mine);
  }

  // Eski istemci: düz metin.
  const plain = payload?.pw;
  if (typeof plain === 'string') return constantTimeEqual(normalizePassword(plain), expected);

  return false;
}

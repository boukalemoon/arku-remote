// Arku Remote — süreli (ephemeral) TURN kimlik bilgisi üretici.
//
// NEDEN: TURN kullanıcı adı/parolası istemciye gömülürse (VITE_TURN_* ile
// build'e girerse) her kurulumdan çıkarılabilir ve relay sunucumuz bedava
// bant genişliği olarak kullanılır. Bunun yerine coturn'ün `use-auth-secret`
// modunu kullanıyoruz: paylaşılan sır YALNIZCA sunucuda ve bu fonksiyonda
// durur, istemci yalnızca birkaç saat geçerli bir kimlik bilgisi alır.
//
// Protokol (coturn "TURN REST API", RFC 5766 draft-uberti-behave-turn-rest):
//   username   = "<son-kullanma-unix>:<kullanıcı-kimliği>"
//   credential = base64( HMAC-SHA1( TURN_STATIC_AUTH_SECRET, username ) )
// coturn aynı hesabı kendi sırrıyla yeniden üretip doğrular; kullanıcı
// veritabanı gerekmez.
//
// YETKİ (B1 — 2026-09-21'de sertleştirildi)
//
// verify_jwt AÇIK kalmalı (varsayılan) AMA TEK BAŞINA YETMEZ: projenin
// herkese açık anon anahtarı da geçerli bir JWT'dir ve her kuruluma gömülüdür.
// Gateway onu kabul ettiği için, eskiden oturumu olmayan herkes relay kimliği
// alabiliyordu ("bir ucun JWT istemesi, kullanıcı istemesi demek değildir").
//
// Bu yüzden fonksiyon kendi kapısını kuruyor:
//   1) `role` = authenticated ve dolu `sub` şartı. Misafirler de anonim
//      oturumla geldiği için bu kimseyi dışarıda bırakmaz; yalnızca
//      oturumsuz çağrıyı eler.
//   2) Belirteç ayrıca auth sunucusuna doğrulatılır. Gateway'e ek olarak:
//      fonksiyon bir gün --no-verify-jwt ile yayımlanırsa 1. adım tek başına
//      sahte bir JWT'yi ayırt edemez. Auth sunucusuna ULAŞILAMAZSA istek
//      reddedilmez — imzayı gateway zaten doğruladı, geçici bir arıza
//      yüzünden bağlantıları kesmek doğru olmaz.
//   3) Kişi başı hız sınırı (arku_turn_rate_limit, 20260921_turn_rate_limit).
//
// KAPSAM: anonim girişler açık olduğu için saldırgan yeni oturum açıp yeni
// `sub` alabilir. Kitlesel hesap üretimini durduracak olan Supabase Auth'un
// IP başına sınırı ve CAPTCHA'sıdır; üçüncü katman coturn kotalarıdır.
//
// TTL NEDEN 12 SAAT: kısaltmak cazip görünüyor ama coturn, ayırma (allocation)
// yenilemelerinde kimliği yeniden doğrular; süresi dolmuş bir kimlik UZUN
// SÜREN bir oturumu ortasından koparabilir. Gözetimsiz erişimde oturumlar
// saatlerce sürüyor. Kısaltmadan önce canlıda uzun oturum testi gerekir.
//
// ÜÇ ÇALIŞMA MODU
//
//  A) PAYLAŞILAN SIR (kendi coturn'ümüz — tercih edilen)
//     TURN_STATIC_AUTH_SECRET  coturn'deki `static-auth-secret` ile AYNI değer
//     Kimlik bilgisi her istekte türetilir, TTL kadar geçerlidir.
//
//  C) SAĞLAYICI API'Sİ (yönetilen — Metered, vb.)
//     TURN_PROVIDER_URL  örn:
//       https://<app>.metered.live/api/v1/turn/credentials?apiKey=<KEY>
//     Sağlayıcı kimliği kendi API'sinden verir. İsteği SUNUCU yapar, böylece
//     apiKey istemciye hiç gitmez. Yanıt ya düz bir dizi ya da
//     { iceServers: [...] } olabilir; ikisi de kabul edilir.
//
//  B) SABİT KİMLİK (elle girilen kullanıcı adı/parola)
//     TURN_USERNAME + TURN_CREDENTIAL
//     Sağlayıcı kalıcı bir çift veriyorsa veya coturn'ü `user=` ile
//     işletiyorsanız. İstemciye gömmekten iyidir: binary'ye girmez ve
//     yayın yapmadan döndürülebilir.
//
// Öncelik: A > C > B. Hiçbiri yoksa yalnızca STUN döner.
//
// ORTAK ORTAM DEĞİŞKENLERİ (Supabase → Edge Functions → Secrets):
//   TURN_URLS                virgülle ayrılmış, örn:
//                            "turn:turn.arku.com.tr:3478?transport=udp,
//                             turn:turn.arku.com.tr:3478?transport=tcp,
//                             turns:turn.arku.com.tr:5349?transport=tcp"
//   TURN_TTL_SECONDS         opsiyonel, varsayılan 43200 (12 saat) — yalnızca A modunda
//   STUN_URLS                opsiyonel, virgülle ayrılmış STUN listesi

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      // Kimlik bilgisi kullanıcıya özel ve süreli — hiçbir ara katman saklamasın.
      "Cache-Control": "no-store",
    },
  });
}

const DEFAULT_STUN = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

const DEFAULT_TTL = 43_200; // 12 saat

/** Sağlayıcı yanıtındaki ICE girdisi — şema sağlayıcıya göre değişir, gevşek okunur. */
interface RTCIceServerLike {
  urls?: string | string[];
  username?: string;
  credential?: string;
}

/** "a, b ,c" -> ["a","b","c"]; boş girdide boş dizi. */
function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** base64( HMAC-SHA1(secret, message) ) — coturn'ün beklediği biçim. */
async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  // btoa ikili veriyi latin1 string üzerinden bekler.
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** JWT gövdesini ayrıştırır (imzayı DOĞRULAMAZ — bkz. yukarıdaki YETKİ notu). */
function decodeClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded + "=".repeat((4 - padded.length % 4) % 4)));
  } catch {
    return null;
  }
}

type AuthResult =
  | { ok: true; sub: string; token: string }
  | { ok: false; status: number; error: string };

/**
 * Çağıranın gerçekten bir KULLANICI olduğunu doğrular ve kimliğini döndürür.
 * Kimlik, TURN kullanıcı adına yazılır ve hız sınırının anahtarıdır.
 */
async function authorize(req: Request): Promise<AuthResult> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return { ok: false, status: 401, error: "Oturum gerekli" };

  const claims = decodeClaims(token);
  if (!claims) return { ok: false, status: 401, error: "Oturum gerekli" };

  // Anon anahtarın rolü "anon"; gerçek oturumlarınki (misafir dahil)
  // "authenticated". Ayrım tam olarak burada.
  if (claims.role !== "authenticated") {
    return { ok: false, status: 401, error: "Bu islem icin oturum gerekli" };
  }
  const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!sub) return { ok: false, status: 401, error: "Oturum gerekli" };

  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  if (exp && exp * 1000 < Date.now()) {
    return { ok: false, status: 401, error: "Oturumun suresi dolmus" };
  }

  return { ok: true, sub, token };
}

/** service_role istemcisi — belirteç doğrulaması ve hız sınırı için. */
function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "Yalnızca GET/POST desteklenir" }, 405);
  }

  // ── KAPI (B1) ──────────────────────────────────────────────────────────────
  // Mod dallanmasından ÖNCE duruyor. Sabit kimlik (B) ve sağlayıcı (C)
  // modlarında kimlik bilgisi çağıranın kim olduğuna bakılmadan dönüyor;
  // kapının orada da geçerli olması gerekiyor. Üstelik B modundaki kimliğin
  // süresi hiç dolmuyor, C modundaki kullanım doğrudan faturaya yazıyor.
  const auth = await authorize(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const admin = adminClient();

  // Belirteci auth sunucusuna doğrulat. KESİN bir ret gelirse istek düşer;
  // geçici arızada (ağ/zaman aşımı) devam edilir — imzayı gateway doğruladı,
  // geçici bir aksaklık yüzünden bağlantıları kesmek doğru olmaz.
  try {
    const { data, error } = await admin.auth.getUser(auth.token);
    if (error) {
      const status = (error as { status?: number }).status ?? 0;
      if (status === 401 || status === 403) {
        return json({ error: "Oturum gecersiz" }, 401);
      }
    } else if (data?.user?.id && data.user.id !== auth.sub) {
      return json({ error: "Oturum gecersiz" }, 401);
    }
  } catch { /* geçici arıza — aşağıda devam */ }

  // Kişi başı hız sınırı. Fonksiyon yoksa (migration henüz uygulanmadıysa)
  // istek ENGELLENMEZ: asıl koruma yukarıdaki kapıdır, sınır onun üstüne gelir.
  try {
    const { data: allowed, error } = await admin.rpc("arku_turn_rate_limit", {
      p_caller: auth.sub,
    });
    if (!error && allowed === false) {
      return json({ error: "Cok fazla istek. Lutfen biraz bekleyin." }, 429);
    }
  } catch { /* sınır uygulanamadı — kapı yerinde */ }

  const stunUrls = splitList(Deno.env.get("STUN_URLS"));
  const stunServers = (stunUrls.length ? stunUrls : DEFAULT_STUN).map((urls) => ({ urls }));

  const secret = Deno.env.get("TURN_STATIC_AUTH_SECRET");
  const providerUrl = Deno.env.get("TURN_PROVIDER_URL");
  const staticUser = Deno.env.get("TURN_USERNAME");
  const staticPass = Deno.env.get("TURN_CREDENTIAL");
  const turnUrls = splitList(Deno.env.get("TURN_URLS"));

  const hasSharedSecret = !!secret && turnUrls.length > 0;
  const hasProvider = !!providerUrl;
  const hasStaticPair = !!(staticUser && staticPass) && turnUrls.length > 0;

  // TURN yapılandırılmamışsa hata DEĞİL: istemci STUN ile devam eder.
  // (Kısıtlı ağlarda bağlantı kurulamaz ama uygulama çalışmaya devam eder.)
  if (!hasSharedSecret && !hasProvider && !hasStaticPair) {
    return json({
      iceServers: stunServers,
      ttl: 0,
      turn: false,
      reason:
        "TURN yapılandırılmamış. Şunlardan biri gerekli: TURN_PROVIDER_URL, " +
        "veya TURN_URLS ile birlikte TURN_STATIC_AUTH_SECRET, " +
        "veya TURN_URLS ile birlikte TURN_USERNAME+TURN_CREDENTIAL.",
    });
  }

  // ── C modu: sağlayıcı API'sinden kimlik al (Metered vb.) ───────────────────
  // İsteği sunucu yapar; apiKey içeren adres istemciye asla gitmez.
  if (!hasSharedSecret && hasProvider) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(providerUrl!, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`sağlayıcı ${res.status}`);
      const body = await res.json();
      // Metered düz bir dizi döner; bazı sağlayıcılar { iceServers: [...] }.
      const list: unknown = Array.isArray(body) ? body : body?.iceServers;
      if (!Array.isArray(list) || list.length === 0) throw new Error("boş yanıt");

      const servers = list as RTCIceServerLike[];
      const anyTurn = servers.some((s) => {
        const u = Array.isArray(s?.urls) ? s.urls.join(",") : String(s?.urls ?? "");
        return u.includes("turn:") || u.includes("turns:");
      });

      return json({
        // Sağlayıcı kendi STUN'unu da döndürür; kendi listemizi yedek olarak ekliyoruz.
        iceServers: [...servers, ...stunServers],
        ttl: 3600,
        turn: anyTurn,
        mode: "provider",
      });
    } catch (e) {
      // Sağlayıcıya ulaşılamadı: B moduna, o da yoksa STUN'a düş.
      if (!hasStaticPair) {
        return json({
          iceServers: stunServers,
          ttl: 0,
          turn: false,
          reason: `TURN sağlayıcısına ulaşılamadı: ${String(e)}`,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ── B modu: elle girilmiş sabit kimlik ─────────────────────────────────────
  if (!hasSharedSecret) {
    return json({
      iceServers: [
        ...stunServers,
        { urls: turnUrls, username: staticUser, credential: staticPass },
      ],
      ttl: 3600,
      turn: true,
      mode: "static",
    });
  }

  // ── A modu: coturn paylaşılan sırrından süreli kimlik türet ────────────────
  const ttlRaw = Number(Deno.env.get("TURN_TTL_SECONDS"));
  const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : DEFAULT_TTL;

  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiry}:${auth.sub}`;

  let credential: string;
  try {
    credential = await hmacSha1Base64(secret!, username);
  } catch (e) {
    return json({ error: `Kimlik bilgisi üretilemedi: ${String(e)}` }, 500);
  }

  return json({
    // Sıra önemli: STUN önce (ucuz aday), TURN sonra (relay son çare).
    iceServers: [
      ...stunServers,
      { urls: turnUrls, username, credential },
    ],
    username,
    ttl,
    turn: true,
    mode: "hmac",
  });
});

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
// YETKİ: verify_jwt AÇIK kalmalı (varsayılan). Her Arku istemcisinin bir
// oturumu vardır (misafirler dahil anonim oturum), dolayısıyla bu kısıt
// kimseyi dışarıda bırakmaz ama oturumsuz kazıyıcıları engeller.
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

/**
 * Çağıranın kimliğini JWT'nin `sub` alanından okur. İmza doğrulamasını
 * Supabase gateway zaten yapmıştır (verify_jwt); burada yalnızca kimliği
 * TURN kullanıcı adına yazmak için ayrıştırıyoruz. Ayrıştırılamazsa
 * "anon" kullanılır — kimlik bilgisi yine süreli ve geçerlidir.
 */
function callerId(req: Request): string {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const part = token.split(".")[1];
  if (!part) return "anon";
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(padded + "=".repeat((4 - padded.length % 4) % 4)));
    return typeof claims.sub === "string" && claims.sub ? claims.sub : "anon";
  } catch {
    return "anon";
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "Yalnızca GET/POST desteklenir" }, 405);
  }

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
  const username = `${expiry}:${callerId(req)}`;

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

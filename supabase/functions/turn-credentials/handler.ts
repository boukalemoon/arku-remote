// Arku Remote — turn-credentials iş mantığı (Deno'dan bağımsız).
//
// index.ts yalnızca Deno.serve + Supabase istemcisini bağlar; kararların hepsi
// burada. Böylece aynı kod Node'un yerleşik test koşucusuyla, ağa çıkmadan
// test edilebiliyor (handler.test.ts).
//
// Protokol, modlar ve ortam değişkenleri için index.ts başındaki açıklamaya
// bakın. Bu dosya o davranışı korur, şu farklarla (denetim 2026-10-07, O7):
//
//  * KAPALI BAŞARISIZLIK: Belirteç auth sunucusunda DOĞRULANAMAZSA (ağ hatası,
//    beklenmeyen yanıt) ya da hız sınırı UYGULANAMAZSA relay kimliği
//    VERİLMEZ; yalnızca STUN döner. Eskiden ikisinde de istek geçiyordu:
//    fonksiyon --no-verify-jwt ile yayımlandığı ya da auth erişilemez olduğu
//    anda imzası doğrulanmamış bir belirteç relay alabiliyordu. STUN'a düşmek
//    uygulamayı durdurmaz, yalnızca kısıtlı ağlarda bağlantı kurulamaz.
//  * Süresi (`exp`) olmayan belirteç reddedilir.
//  * Hata ayrıntıları (sağlayıcı adresi, apiKey içerebilen fetch hatası,
//    istisna metni) istemciye DÖNMEZ; yalnızca sunucu günlüğüne yazılır.

export interface Env {
  get(name: string): string | undefined;
}

/** Fonksiyonun ihtiyaç duyduğu yönetici yetenekleri — testte sahtelenir. */
export interface AdminApi {
  getUser(token: string): Promise<{ id: string | null; status: number | null }>;
  rateLimit(sub: string): Promise<boolean>;
}

export interface Deps {
  env: Env;
  admin: () => AdminApi;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const DEFAULT_STUN = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];
export const DEFAULT_TTL = 43_200; // 12 saat

interface RTCIceServerLike { urls?: string | string[]; username?: string; credential?: string }

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const v = JSON.parse(atob(padded + "=".repeat((4 - padded.length % 4) % 4)));
    return v && typeof v === "object" ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

type AuthResult = { ok: true; sub: string; token: string } | { ok: false; status: number; error: string };

function authorize(req: Request, now: number): AuthResult {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return { ok: false, status: 401, error: "Oturum gerekli" };
  const claims = decodeClaims(token);
  if (!claims) return { ok: false, status: 401, error: "Oturum gerekli" };
  if (claims.role !== "authenticated") return { ok: false, status: 401, error: "Bu islem icin oturum gerekli" };
  const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!sub) return { ok: false, status: 401, error: "Oturum gerekli" };
  // Süresiz belirteç kabul edilmez (Supabase her oturum belirtecine exp koyar).
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now) {
    return { ok: false, status: 401, error: "Oturumun suresi dolmus" };
  }
  return { ok: true, sub, token };
}

/** STUN-only yanıt: relay vermeden uygulamanın çalışmaya devam etmesini sağlar. */
function stunOnly(stunServers: { urls: string }[], reason: string): Response {
  return json({ iceServers: stunServers, ttl: 0, turn: false, reason });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const env = deps.env;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(`[turn-credentials] ${m}`, e ?? ""));
  const doFetch = deps.fetch ?? fetch;

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "Yalnızca GET/POST desteklenir" }, 405);
  }

  const auth = authorize(req, now());
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const stunUrls = splitList(env.get("STUN_URLS"));
  const stunServers = (stunUrls.length ? stunUrls : DEFAULT_STUN).map((urls) => ({ urls }));

  const admin = deps.admin();

  // Belirteç auth sunucusunda doğrulanmalı. Doğrulanamazsa relay yok.
  let verified: { id: string | null; status: number | null };
  try {
    verified = await admin.getUser(auth.token);
  } catch (e) {
    log("auth dogrulamasi yapilamadi", e);
    return stunOnly(stunServers, "Oturum su an dogrulanamadi; yalnizca dogrudan baglanti deneniyor.");
  }
  if (verified.status === 401 || verified.status === 403) return json({ error: "Oturum gecersiz" }, 401);
  if (!verified.id) {
    log(`auth beklenmeyen yanit (status=${verified.status})`);
    return stunOnly(stunServers, "Oturum su an dogrulanamadi; yalnizca dogrudan baglanti deneniyor.");
  }
  if (verified.id !== auth.sub) return json({ error: "Oturum gecersiz" }, 401);

  // Kişi başı hız sınırı uygulanamazsa relay yok.
  let allowed: boolean;
  try {
    allowed = await admin.rateLimit(auth.sub);
  } catch (e) {
    log("hiz siniri uygulanamadi", e);
    return stunOnly(stunServers, "Gecici sunucu hatasi; yalnizca dogrudan baglanti deneniyor.");
  }
  if (!allowed) return json({ error: "Cok fazla istek. Lutfen biraz bekleyin." }, 429);

  const secret = env.get("TURN_STATIC_AUTH_SECRET");
  const providerUrl = env.get("TURN_PROVIDER_URL");
  const staticUser = env.get("TURN_USERNAME");
  const staticPass = env.get("TURN_CREDENTIAL");
  const turnUrls = splitList(env.get("TURN_URLS"));

  const hasSharedSecret = !!secret && turnUrls.length > 0;
  const hasProvider = !!providerUrl;
  const hasStaticPair = !!(staticUser && staticPass) && turnUrls.length > 0;

  if (!hasSharedSecret && !hasProvider && !hasStaticPair) {
    return stunOnly(stunServers, "TURN yapilandirilmamis.");
  }

  // C modu: sağlayıcı API'si
  if (!hasSharedSecret && hasProvider) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await doFetch(providerUrl!, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`saglayici ${res.status}`);
      const body = await res.json();
      const list: unknown = Array.isArray(body) ? body : body?.iceServers;
      if (!Array.isArray(list) || list.length === 0) throw new Error("bos yanit");
      const servers = list as RTCIceServerLike[];
      const anyTurn = servers.some((s) => {
        const u = Array.isArray(s?.urls) ? s.urls.join(",") : String(s?.urls ?? "");
        return u.includes("turn:") || u.includes("turns:");
      });
      return json({ iceServers: [...servers, ...stunServers], ttl: 3600, turn: anyTurn, mode: "provider" });
    } catch (e) {
      // Hata metni sağlayıcı adresini (apiKey dahil) içerebilir: istemciye gitmez.
      log("TURN saglayicisina ulasilamadi", e);
      if (!hasStaticPair) return stunOnly(stunServers, "TURN saglayicisina ulasilamadi.");
    } finally {
      clearTimeout(timer);
    }
  }

  // B modu: sabit kimlik
  if (!hasSharedSecret) {
    return json({
      iceServers: [...stunServers, { urls: turnUrls, username: staticUser, credential: staticPass }],
      ttl: 3600, turn: true, mode: "static",
    });
  }

  // A modu: coturn paylaşılan sırrı
  const ttlRaw = Number(env.get("TURN_TTL_SECONDS"));
  const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : DEFAULT_TTL;
  const expiry = Math.floor(now() / 1000) + ttl;
  const username = `${expiry}:${auth.sub}`;
  let credential: string;
  try {
    credential = await hmacSha1Base64(secret!, username);
  } catch (e) {
    log("kimlik bilgisi uretilemedi", e);
    return json({ error: "Kimlik bilgisi uretilemedi" }, 500);
  }
  return json({
    iceServers: [...stunServers, { urls: turnUrls, username, credential }],
    username, ttl, turn: true, mode: "hmac",
  });
}

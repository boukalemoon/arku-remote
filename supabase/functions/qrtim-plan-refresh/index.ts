// Arku Remote — QRtım planını tazele.
//
// NEDEN VAR
// QRtım planı Arku'ya yalnızca giriş/bağlama anında yazılıyordu ve yazılan
// satırın süresi dolmuyordu: QRtım aboneliği biten kullanıcı Arku'da ücretli
// kademede süresiz kalıyordu. Artık QRtım kaynaklı planın 72 saatlik bir
// geçerlilik ufku var (20260922_qrtim_plan_expiry) ve bu fonksiyon o ufku
// ileri itiyor. Tazelenmezse yetki kendiliğinden düşer — güvenli varsayılan.
//
// KİMLİK
// Kullanıcının kendi oturumuyla çağrılır (verify_jwt açık). Sır İSTEMCİYE HİÇ
// GİTMEZ: burada, service_role ile qrtim_link_secrets'tan okunur. Misafir
// (anonim) oturumların QRtım bağlantısı olamaz, reddedilir.
//
// QRtım'İN YANIT TABLOSU — HER SATIRIN AYRI ANLAMI VAR
//   200 + plan          → planı uygula, ufku ilerlet
//   410 link_revoked    → hesap silinmiş ya da bağ koparılmış: yetkiyi HEMEN
//                         düşür, bağı temizle
//   401 unauthorized    → sır hiç geçerli olmamış. KULLANICIYI DÜŞÜRME: bu
//                         cevap "bizdeki kayıt bozuk olabilir" anlamına da
//                         geliyor. Bildir, dokunma.
//   429 rate_limited    → geri çekil, son bilinen planı koru
//   ağ / 5xx            → son bilinen planı koru; ufuk zaten kendi geçer
//
// 401 ile 410 ayrımı bu fonksiyonun en önemli yeri: ikisini birbirine
// karıştırmak ya geçici bir arızada bütün ücretli kullanıcıları düşürür ya da
// silinmiş hesapların yetkisini açık bırakır.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const QRTIM_PARTNER_PLAN_URL =
  "https://kfpnsxoxfrxepxezatsr.supabase.co/functions/v1/partner-plan";

// QRtım projesinin herkese açık anon anahtarı — Supabase gateway'in beklediği
// apikey/Authorization başlığı için. Asıl kimlik gövdedeki link_secret'tir.
const QRTIM_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmcG5zeG94ZnJ4ZXB4ZXphdHNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MjQ0NDUsImV4cCI6MjA4NTIwMDQ0NX0.HN7nKw5gO1cuN9fSmrRO72cgIgqNSUfLsY2L3FOhHDg";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Yalnızca POST desteklenir" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({ error: "Oturum gerekli" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Geçersiz oturum" }, 401);
    if (userData.user.is_anonymous) {
      return json({ status: "no_link", plan: null });
    }
    const userId = userData.user.id;

    // Bağlantı sırrı — istemciye asla dönmez.
    const { data: link } = await admin
      .from("qrtim_link_secrets")
      .select("qrtim_uid, link_secret")
      .eq("user_id", userId)
      .maybeSingle();

    if (!link?.link_secret) {
      // QRtım'e bağlı olmayan hesap: tazelenecek bir şey yok.
      return json({ status: "no_link", plan: null });
    }

    let res: Response;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        res = await fetch(QRTIM_PARTNER_PLAN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: QRTIM_ANON_KEY,
            Authorization: `Bearer ${QRTIM_ANON_KEY}`,
          },
          body: JSON.stringify({
            partner: "arku",
            qrtim_uid: link.qrtim_uid,
            link_secret: link.link_secret,
          }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Ağ hatası / zaman aşımı: son bilinen plan korunur, ufuk kendi geçer.
      return json({ status: "unreachable", plan: null });
    }

    // 410 — bağ koparılmış ya da hesap silinmiş. Tek "hemen düşür" durumu.
    if (res.status === 410) {
      await admin.rpc("arku_qrtim_revoke_link", { p_user_id: userId });
      return json({ status: "revoked", plan: "free" });
    }

    // 401 — sır hiç geçerli olmamış. Kullanıcıyı DÜŞÜRMÜYORUZ: bizdeki kayıt
    // bozulmuş olabilir. Durum bildiriliyor ki teşhis edilebilsin.
    if (res.status === 401) {
      return json({ status: "unauthorized", plan: null });
    }

    if (res.status === 429) {
      return json({ status: "rate_limited", plan: null });
    }

    if (!res.ok) {
      return json({ status: "unreachable", plan: null });
    }

    const body = await res.json().catch(() => null) as
      { ok?: boolean; plan?: string | null; paid?: boolean } | null;

    if (!body?.ok || typeof body.plan !== "string") {
      return json({ status: "unreachable", plan: null });
    }

    // ÜCRETLİ Mİ kararını QRtım veriyor (`paid`), biz plan ADINDAN çıkarmıyoruz:
    // tanımsız bir kademe onların tarafında `paid: false` döner, yani yeni bir
    // plan eklendiğinde bizde sessizce bedava lisans dağıtılmaz.
    // `expires_at`'in boş olması "süresiz" DEMEK DEĞİL; aboneliği olmayan
    // kullanıcıya QRtım zaten plan: "free", paid: false döndürür.
    const { data: applied, error: applyErr } = await admin.rpc("arku_qrtim_apply_plan", {
      p_user_id: userId,
      p_qrtim_plan: body.plan,
      p_paid: typeof body.paid === "boolean" ? body.paid : null,
    });
    if (applyErr) return json({ status: "apply_failed", plan: null }, 500);

    return json({ status: "ok", plan: applied ?? null });
  } catch {
    return json({ error: "İşlem tamamlanamadı" }, 500);
  }
});

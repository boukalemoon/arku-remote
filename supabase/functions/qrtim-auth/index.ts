// Arku Remote - QRtım ile tek tıkla giriş (SSO).
//
// Akış:
//  1) Kullanıcı Arku giriş ekranında "QRtım ile Giriş Yap" der -> QRtım'e gider.
//  2) QRtım'de giriş yapar, tek kullanımlık token ile Arku'ya geri döner.
//  3) Arku bu fonksiyona { qrtim_token } gönderir.
//  4) Token, QRtım'in arku-link fonksiyonu ile doğrulanır (server-to-server).
//  5) E-postaya karşılık gelen Arku kullanıcısı bulunur ya da oluşturulur,
//     QRtım kimliği users tablosuna yazılır.
//  6) Şifre istemeden oturum açmak için magic-link token üretilir ve client'a
//     döndürülür. Client supabase.auth.verifyOtp ile oturumu başlatır.
//
// verify_jwt = false: kullanıcı henüz Arku'da giriş yapmamıştır; güvenlik
// QRtım'in tek kullanımlık token'ı ile sağlanır.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const QRTIM_ARKU_LINK_URL =
  "https://kfpnsxoxfrxepxezatsr.supabase.co/functions/v1/arku-link";

// QRtim projesinin public anon key'i — arku-link'i çağırırken Supabase
// gateway'in beklediği apikey/Authorization header'ı için (public, RLS korumalı).
const QRTIM_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmcG5zeG94ZnJ4ZXB4ZXphdHNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MjQ0NDUsImV4cCI6MjA4NTIwMDQ0NX0.HN7nKw5gO1cuN9fSmrRO72cgIgqNSUfLsY2L3FOhHDg";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// QRtım planı -> Arku planı. Tüm ücretli planlar ücretsiz Arku verir.
function mapQrtimPlan(p: string | null): "free" | "pro" | "business" {
  const v = (p ?? "").toLowerCase();
  if (["business", "kurumsal", "stk", "enterprise"].includes(v)) return "business";
  if (v === "" || v === "free") return "free";
  return "pro"; // student, professional ve diğer tüm ücretli planlar
}

// QRtım kaynaklı Arku aboneliği ver/güncelle.
// Kurallar: ücretsiz plan için abonelik oluşturma; satın alınmış (source=direct,
// active) aboneliği ezme; yalnızca qrtim kaynaklı satırı güncelle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function grantQrtimSubscription(admin: any, userId: string, qrtimPlan: string | null) {
  const arkuPlan = mapQrtimPlan(qrtimPlan);

  const { data: existing } = await admin
    .from("subscriptions")
    .select("id, source, status, plan")
    .eq("owner_id", userId)
    .maybeSingle();

  // Satın alınmış aktif aboneliğe dokunma
  if (existing && existing.source === "direct" && existing.status === "active") return;

  if (arkuPlan === "free") {
    // QRtım artık ücretsiz: yalnızca qrtim kaynaklı satırı free'ye çek
    if (existing && existing.source === "qrtim") {
      await admin.from("subscriptions")
        .update({ plan: "free", qrtim_plan: qrtimPlan, status: "active" })
        .eq("owner_id", userId);
    }
    return;
  }

  await admin.from("subscriptions").upsert({
    owner_id: userId,
    plan: arkuPlan,
    status: "active",
    source: "qrtim",
    qrtim_plan: qrtimPlan,
    seats: arkuPlan === "business" ? 5 : 1,
  }, { onConflict: "owner_id" });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Yalnızca POST desteklenir" }, 405);

  // ── ASKIYA ALINDI (2026-09-08) ─────────────────────────────────────────────
  // Arayüzdeki düğmeyi gizlemek yeterli DEĞİLDİR: bu uç nokta anon key ile
  // doğrudan çağrılabilir. Kapı sunucuda.
  //
  // S1: QRtım'in döndürdüğü e-posta doğrulanmadan kabul ediliyor, o e-posta
  // için hesap açılıp oturum üretiliyordu. QRtım'de e-posta doğrulaması
  // zorunlu değilse saldırgan kurban@firma.com ile QRtım hesabı açıp AYNI
  // e-postaya ait Arku hesabını devralabilirdi.
  //
  // YENİDEN AÇMAK İÇİN İKİSİ BİRDEN gerekli:
  //   1) QRtım'in arku-link yanıtı `email_verified` döndürmeli ve burada
  //      şart koşulmalı,
  //   2) Supabase secret: QRTIM_SSO_ENABLED=true
  if (Deno.env.get("QRTIM_SSO_ENABLED") !== "true") {
    return json({ error: "QRtım entegrasyonu geçici olarak devre dışı." }, 503);
  }


  try {
    const { qrtim_token } = await req.json().catch(() => ({ qrtim_token: null }));
    if (!qrtim_token || typeof qrtim_token !== "string") {
      return json({ error: "Token gerekli" }, 400);
    }

    // 1) QRtım token'ını doğrula (tek kullanımlık olarak burada tüketilir)
    const vr = await fetch(QRTIM_ARKU_LINK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: QRTIM_ANON_KEY,
        Authorization: `Bearer ${QRTIM_ANON_KEY}`,
      },
      body: JSON.stringify({ token: qrtim_token }),
    });
    const vd = await vr.json().catch(() => ({ valid: false }));
    if (!vr.ok || !vd.valid || !vd.user) {
      return json({ error: vd.error || "Geçersiz QRtım token" }, 401);
    }

    const q = vd.user as {
      qrtim_id: string; email: string; name: string; username: string; phone: string | null;
      plan?: string | null;
    };
    if (!q.email) return json({ error: "QRtım hesabında e-posta yok" }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // 2) Kullanıcı yoksa oluştur (zaten varsa hata yok sayılır)
    await admin.auth.admin.createUser({
      email: q.email,
      email_confirm: true,
      user_metadata: { name: q.name, qrtim_id: q.qrtim_id, qrtim_username: q.username },
    });

    // 3) Şifresiz oturum için magic-link token üret (e-posta gönderilmez)
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: q.email,
    });
    if (linkErr || !linkData?.properties?.hashed_token || !linkData?.user?.id) {
      return json({ error: "Oturum oluşturulamadı" }, 500);
    }

    // 4) QRtım kimliğini Arku users tablosuna yaz. Ad/telefon gibi profil
    //    alanlarını yalnızca Arku tarafında boşsa QRtım'den doldur — kullanıcının
    //    daha önce Arku'da yaptığı özelleştirmeyi ezme.
    const { data: existing } = await admin
      .from("users")
      .select("display_name, phone")
      .eq("id", linkData.user.id)
      .maybeSingle();

    const row: Record<string, unknown> = {
      id: linkData.user.id,
      email: q.email,
      qrtim_id: q.qrtim_id,
      qrtim_username: q.username,
      qrtim_name: q.name,
      qrtim_email: q.email,
      qrtim_connected_at: new Date().toISOString(),
    };
    if (!existing?.display_name && q.name) row.display_name = q.name;
    if (!existing?.phone && q.phone) row.phone = q.phone;

    await admin.from("users").upsert(row, { onConflict: "id" });

    // 5) QRtım aboneliğini Arku'ya senkronla — ücretli QRtım planları ücretsiz
    //    Arku aboneliği verir. Mevcut satın alınmış (direct) abonelik ezilmez.
    await grantQrtimSubscription(admin, linkData.user.id, q.plan ?? null);

    return json({
      email: q.email,
      token_hash: linkData.properties.hashed_token,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

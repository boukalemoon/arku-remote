// Arku Remote - QRtım hesap bağlama + abonelik senkronu.
//
// Bu fonksiyon, HALİHAZIRDA Arku'da giriş yapmış bir kullanıcı QRtım hesabını
// bağladığında çağrılır (SSO değil; SSO için qrtim-auth kullanılır).
//
// Akış:
//   1) Çağıran kullanıcı, Authorization: Bearer <arku_access_token> ile gelir.
//   2) Gövdede { qrtim_token } bulunur; QRtım'in arku-link fonksiyonuyla
//      doğrulanır (server-to-server, tek kullanımlık token burada tüketilir).
//   3) QRtım kimliği kullanıcının users satırına yazılır.
//   4) Ücretli QRtım planı ise ücretsiz Arku aboneliği verilir (direct ezilmez).
//
// verify_jwt = true olmalı: yalnızca giriş yapmış kullanıcı kendi hesabını bağlar.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const QRTIM_ARKU_LINK_URL =
  "https://kfpnsxoxfrxepxezatsr.supabase.co/functions/v1/arku-link";
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
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function mapQrtimPlan(p: string | null): "free" | "pro" | "business" {
  const v = (p ?? "").toLowerCase();
  if (["business", "kurumsal", "stk", "enterprise"].includes(v)) return "business";
  if (v === "" || v === "free") return "free";
  return "pro";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function grantQrtimSubscription(admin: any, userId: string, qrtimPlan: string | null) {
  const arkuPlan = mapQrtimPlan(qrtimPlan);
  const { data: existing } = await admin
    .from("subscriptions").select("id, source, status")
    .eq("owner_id", userId).maybeSingle();
  if (existing && existing.source === "direct" && existing.status === "active") return arkuPlan;
  if (arkuPlan === "free") {
    if (existing && existing.source === "qrtim") {
      await admin.from("subscriptions")
        .update({ plan: "free", qrtim_plan: qrtimPlan, status: "active" })
        .eq("owner_id", userId);
    }
    return arkuPlan;
  }
  await admin.from("subscriptions").upsert({
    owner_id: userId, plan: arkuPlan, status: "active",
    source: "qrtim", qrtim_plan: qrtimPlan, seats: arkuPlan === "business" ? 5 : 1,
  }, { onConflict: "owner_id" });
  return arkuPlan;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Yalnızca POST desteklenir" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Oturum gerekli" }, 401);

    const { qrtim_token } = await req.json().catch(() => ({ qrtim_token: null }));
    if (!qrtim_token || typeof qrtim_token !== "string") {
      return json({ error: "Token gerekli" }, 400);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // Çağıran kullanıcıyı JWT'den çöz
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Geçersiz oturum" }, 401);
    const userId = userData.user.id;

    // QRtım token'ını doğrula (tek kullanımlık; burada tüketilir)
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
      qrtim_id: string; email: string; name: string; username: string;
      phone: string | null; plan?: string | null;
    };

    // users satırına QRtım kimliğini yaz (mevcut özelleştirmeyi ezmeden)
    const { data: existing } = await admin
      .from("users").select("display_name, phone").eq("id", userId).maybeSingle();
    const row: Record<string, unknown> = {
      id: userId,
      qrtim_id: q.qrtim_id,
      qrtim_username: q.username,
      qrtim_name: q.name,
      qrtim_email: q.email,
      qrtim_connected_at: new Date().toISOString(),
    };
    if (!existing?.display_name && q.name) row.display_name = q.name;
    if (!existing?.phone && q.phone) row.phone = q.phone;
    await admin.from("users").upsert(row, { onConflict: "id" });

    const arkuPlan = await grantQrtimSubscription(admin, userId, q.plan ?? null);

    return json({
      valid: true,
      user: {
        qrtim_id: q.qrtim_id, email: q.email, name: q.name,
        username: q.username, plan: q.plan ?? "free",
      },
      arku_plan: arkuPlan,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

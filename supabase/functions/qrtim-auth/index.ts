// Arku Remote - QRtım ile tek tıkla giriş (SSO).
//
// Akış:
//  1) Kullanıcı Arku giriş ekranında "QRtım ile Giriş Yap" der -> QRtım'e gider.
//  2) QRtım'de giriş yapar, tek kullanımlık token ile Arku'ya geri döner.
//  3) Arku bu fonksiyona { qrtim_token } gönderir.
//  4) Token, QRtım'in arku-link fonksiyonu ile doğrulanır (server-to-server).
//  5) Arku hesabı QRtım'in KALICI kimliğiyle (qrtim_uid) bulunur; hiç bağlanmamış
//     eski hesaplar bir kereye mahsus doğrulanmış e-postayla taşınır. Karar ve
//     yazma işi arku_qrtim_resolve_account içinde, tek işlemde yapılır.
//  6) Şifre istemeden oturum açmak için magic-link token üretilir ve client'a
//     döndürülür. Client supabase.auth.verifyOtp ile oturumu başlatır.
//
// verify_jwt = false: kullanıcı henüz Arku'da giriş yapmamıştır; güvenlik
// QRtım'in tek kullanımlık token'ı ile sağlanır.
//
// ÜÇ KURAL (QRtım deposundaki docs/qrtim-kimlik-entegrasyonu.md ile ortak):
//   * Eşleştirme e-postayla YAPILMAZ. E-posta değişir, devredilir ve aynı
//     adres bir süre sonra başka birine ait olabilir.
//   * Oturum, eşleşen Arku hesabının KENDİ auth e-postasıyla açılır. QRtım'den
//     gelen e-postayla açmak, kullanıcı QRtım'de adresini değiştirdiğinde
//     doğru hesapla eşleşip yanlış hesaba giriş yapmak demektir.
//   * Hesap yazma hatası YUTULMAZ. Aynı QRtım kimliği başka bir Arku hesabına
//     bağlıysa oturum açılmaz.

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
// NOT: QRtım planını Arku aboneliğine çevirme mantığı buradan TAŞINDI.
// Aynı mantık qrtim-sync içinde de vardı ve artık plana 72 saatlik bir
// geçerlilik ufku ekleniyor; üç çağıranın (bu fonksiyon, qrtim-sync,
// qrtim-plan-refresh) aynı kurala uyması şart olduğu için kopya çoğaltmak yerine
// tek yere indirildi: public.arku_qrtim_apply_plan
// (20260922_qrtim_plan_expiry.sql). Süre de orada, tek sabitte duruyor.

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Yalnızca POST desteklenir" }, 405);

  // ── KAPALI (2026-09-08'den beri) ───────────────────────────────────────────
  // Arayüzdeki düğmeyi gizlemek yeterli DEĞİLDİR: bu uç nokta anon key ile
  // doğrudan çağrılabilir. Kapı sunucuda.
  //
  // S1 (KAPANDI, 2026-09-21): QRtım'in döndürdüğü e-posta doğrulanmadan kabul
  // ediliyordu; saldırgan kurban@firma.com ile QRtım hesabı açıp aynı
  // e-postaya ait Arku hesabını devralabilirdi. QRtım 10.09.2026'dan beri
  // doğrulanmamış hesaba belirteç vermiyor ve `email_verified` döndürüyor;
  // aşağıda bu alan ayrıca ŞART KOŞULUYOR (savunma katmanı) ve eşleştirme
  // artık e-postayla değil kalıcı kimlikle yapılıyor.
  //
  // KALAN TEK ENGEL ÜRÜN KARARI: bayrağı açmak Burak'ın kararı. Açılınca ikisi
  // birden açılmalı — burada QRTIM_SSO_ENABLED=true, istemcide
  // src/App.tsx > QRTIM_ENABLED = true. Biri tek başına yetmez.
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
      // `code` makine tarafından okunabilir (token_already_used, token_expired,
      // email_not_verified …); istemci mesajı ona göre seçiyor. `error` metni
      // insan içindir ve değişebilir — ona göre dallanılmaz.
      return json({
        error: vd.error || "Geçersiz QRtım token",
        code: typeof vd.code === "string" ? vd.code : "token_invalid",
      }, 401);
    }

    const q = vd.user as {
      qrtim_uid?: string | null;
      qrtim_id: string; email: string; email_verified?: boolean;
      name: string; username: string; phone: string | null;
      // `paid` QRtım'in `partner-plan` cevabında var; arku-link de göndermeye
      // başlarsa buradan otomatik kullanılır. Yoksa null geçiyoruz ve SQL
      // tarafındaki köprü bilinen ad listesine düşüyor (bilinmeyen = ücretsiz).
      plan?: string | null; paid?: boolean;
    };

    // 2) Savunma katmanı. QRtım doğrulanmamış hesaba belirteç vermiyor, ama
    //    tek koruma olarak karşı tarafa güvenmiyoruz: alan yoksa ya da true
    //    değilse hesap bağlanmaz.
    if (q.email_verified !== true) {
      return json({ error: "QRtım hesabının e-postası doğrulanmamış." }, 403);
    }
    if (!q.email) return json({ error: "QRtım hesabında e-posta yok" }, 400);
    if (!q.qrtim_uid) {
      // Kalıcı kimlik gelmezse eşleştirme e-postaya düşerdi; o yol kapalı.
      return json({ error: "QRtım kalıcı kimliği (qrtim_uid) gelmedi." }, 502);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // 3) Hesabı bul: kalıcı kimlikle eşleştir, hiç bağlanmamış eski hesabı bir
    //    kereye mahsus doğrulanmış e-postayla taşı. Karar ve yazma tek işlemde
    //    veritabanında yapılır (20260921_qrtim_uid_identity.sql).
    const { data: resolved, error: resolveErr } = await admin.rpc(
      "arku_qrtim_resolve_account",
      { p_qrtim_uid: q.qrtim_uid, p_email: q.email },
    );
    if (resolveErr) return json({ error: "Hesap eşleştirilemedi" }, 500);

    const match = (Array.isArray(resolved) ? resolved[0] : resolved) as
      { user_id: string; auth_email: string | null; matched: string } | undefined;

    if (match?.matched === "conflict") {
      return json({
        error: "Bu Arku hesabı başka bir QRtım hesabına bağlı. Ayarlar > QRtım " +
          "bağlantısını kesip tekrar deneyin.",
      }, 409);
    }

    let userId = match?.user_id ?? null;
    // Oturum, hesabın KENDİ auth e-postasıyla açılır — QRtım'inkiyle değil.
    let loginEmail = match?.auth_email ?? null;

    // 4) Eşleşen hesap yoksa yeni hesap. email_confirm burada meşru: QRtım
    //    e-postayı doğruladığını bildirdi ve yukarıda şart koştuk.
    if (!userId) {
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: q.email,
        email_confirm: true,
        user_metadata: { name: q.name, qrtim_id: q.qrtim_id, qrtim_username: q.username },
      });
      if (createErr || !created?.user?.id) {
        // En olası sebep: bu e-postayla DOĞRULANMAMIŞ bir Arku kaydı var
        // (eşleşseydi 3. adım bulurdu). Böyle bir kaydı bağlamak, kaydı
        // önceden açmış birinin hesabına kullanıcıyı sokmak olurdu.
        return json({
          error: "Bu e-postayla tamamlanmamış bir Arku kaydı var. Önce Arku'daki " +
            "e-posta doğrulamasını bitirin, sonra Ayarlar'dan QRtım hesabınızı bağlayın.",
        }, 409);
      }
      userId = created.user.id;
      loginEmail = q.email;
    }

    if (!loginEmail) return json({ error: "Oturum oluşturulamadı" }, 500);

    // 5) QRtım kimliğini yaz. Ad/telefon yalnızca Arku tarafında BOŞSA doldurulur
    //    — kullanıcının Arku'da yaptığı özelleştirme ezilmez. users.email
    //    hesabın kendi adresidir; QRtım'inki qrtim_email'de durur.
    const { data: existing } = await admin
      .from("users")
      .select("display_name, phone")
      .eq("id", userId)
      .maybeSingle();

    const row: Record<string, unknown> = {
      id: userId,
      email: loginEmail,
      qrtim_uid: q.qrtim_uid,
      qrtim_id: q.qrtim_id,
      qrtim_username: q.username,
      qrtim_name: q.name,
      qrtim_email: q.email,
      qrtim_connected_at: new Date().toISOString(),
    };
    if (!existing?.display_name && q.name) row.display_name = q.name;
    if (!existing?.phone && q.phone) row.phone = q.phone;

    // HATA YUTULMAZ: aynı QRtım kimliği başka bir hesapta ise benzersizlik
    // hatası döner ve oturum AÇILMAZ.
    const { error: upsertErr } = await admin.from("users").upsert(row, { onConflict: "id" });
    if (upsertErr) {
      return json({ error: "QRtım kimliği bu hesaba bağlanamadı." }, 409);
    }

    // 6) Plan tazeleme sırrını sakla (QRtım `partner-plan` ucu için).
    //
    // Sır YALNIZCA bağlama anında dönüyor; şimdi yakalanmazsa sonradan almanın
    // yolu yok. İstemciye hiç gönderilmiyor, politikası olmayan ayrı bir
    // tabloda duruyor (20260922_qrtim_link_secrets).
    //
    // Hata girişi DÜŞÜRMEZ: oturum geçerli, yalnızca planı sonradan doğrulama
    // yeteneğini kaybederiz. Plan tazeleme yolu "sır yok" durumunu
    // "doğrulanamadı" olarak ele alır.
    if (typeof vd.link_secret === "string" && vd.link_secret) {
      await admin.from("qrtim_link_secrets").upsert({
        user_id: userId,
        qrtim_uid: q.qrtim_uid,
        link_secret: vd.link_secret,
      }, { onConflict: "user_id" });
    }

    // 7) Şifresiz oturum için magic-link token üret (e-posta gönderilmez)
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: loginEmail,
    });
    if (linkErr || !linkData?.properties?.hashed_token) {
      return json({ error: "Oturum oluşturulamadı" }, 500);
    }
    // generateLink kullanıcıyı e-postadan bulur. Eşleştiğimiz hesapla aynı
    // olduğunu doğrula: aradaki bir e-posta değişikliği başka bir hesaba
    // oturum açmamızı sağlayabilirdi.
    if (linkData.user?.id && linkData.user.id !== userId) {
      return json({ error: "Oturum oluşturulamadı" }, 500);
    }

    // 8) QRtım aboneliğini Arku'ya senkronla — ücretli QRtım planları ücretsiz
    //    Arku aboneliği verir. Mevcut satın alınmış (direct) abonelik ezilmez.
    //
    //    Buradaki plan BAĞLAMA ANININ fotoğrafıdır ve eskir; bu yüzden yazılan
    //    satır 72 saatlik bir ufukla yazılıyor ve qrtim-plan-refresh onu
    //    periyodik tazeliyor. Tazelenmezse yetki kendiliğinden düşer.
    await admin.rpc("arku_qrtim_apply_plan", {
      p_user_id: userId,
      p_qrtim_plan: q.plan ?? null,
      p_paid: typeof q.paid === "boolean" ? q.paid : null,
    });

    return json({
      email: loginEmail,
      token_hash: linkData.properties.hashed_token,
    });
  } catch {
    // İç hata ayrıntısı dışarı sızmasın (QRtım tarafı da aynı kuralı uyguluyor).
    return json({ error: "İşlem tamamlanamadı" }, 500);
  }
});

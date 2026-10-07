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
//      sahte bir JWT'yi ayırt edemez. Auth sunucusuna ULAŞILAMAZSA relay
//      kimliği VERİLMEZ, yalnızca STUN döner (denetim 2026-10-07, O7; eskiden
//      istek geçiyordu). Uygulama çalışmaya devam eder.
//   3) Kişi başı hız sınırı (arku_turn_rate_limit, 20260921_turn_rate_limit).
//      Sınır uygulanamazsa da yalnızca STUN döner.
//
// İş mantığı handler.ts'te; bu dosya yalnızca Deno ve Supabase'i bağlar.
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
import { handle, type AdminApi } from "./handler.ts";

function admin(): AdminApi {
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  return {
    async getUser(token) {
      const { data, error } = await client.auth.getUser(token);
      if (error) return { id: null, status: (error as { status?: number }).status ?? null };
      return { id: data?.user?.id ?? null, status: 200 };
    },
    async rateLimit(sub) {
      const { data, error } = await client.rpc("arku_turn_rate_limit", { p_caller: sub });
      if (error) throw new Error(error.message);
      return data !== false;
    },
  };
}

Deno.serve((req: Request) => handle(req, { env: Deno.env, admin }));

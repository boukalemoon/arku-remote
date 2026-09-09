// Arku Remote — ICE sunucu yapılandırması (STUN + süreli TURN).
//
// SORUN: Eskiden TURN kimlik bilgisi build zamanında VITE_TURN_* ile gömülüyordu.
// İki sonucu vardı:
//   1) CI'da bu değişkenler hiç tanımlı olmadığı için yayınlanan tüm kurulumlar
//      SADECE STUN ile çıkıyordu. Simetrik NAT / kurumsal güvenlik duvarı /
//      CGNAT arkasındaki hiçbir cihaz bağlanamıyordu.
//   2) Tanımlansaydı bile statik parola her binary'den çıkarılabilir olurdu.
//
// ÇÖZÜM: `turn-credentials` edge fonksiyonu, coturn'ün paylaşılan sırrıyla
// birkaç saatlik HMAC kimlik bilgisi üretir. Sır sunucuda kalır.
//
// Bu modül hiçbir zaman hata fırlatmaz; sırasıyla şu kaynaklara düşer:
//   1. turn-credentials edge fonksiyonu (tercih edilen)
//   2. build zamanı VITE_TURN_* (eski davranış — kendi TURN'ünü kuranlar için)
//   3. yalnızca STUN (kısıtlı ağlarda bağlanamaz ama uygulama çalışır)

import { supabase, ARKU_ANON_KEY, ARKU_FUNCTIONS_URL } from './supabase';

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const TURN_ENDPOINT = `${ARKU_FUNCTIONS_URL}/turn-credentials`;

// Build zamanı TURN (opsiyonel, geriye dönük uyumluluk).
const staticTurnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
const staticTurnUsername = import.meta.env.VITE_TURN_USERNAME as string | undefined;
const staticTurnCredential = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;

const hasStaticTurn = !!(staticTurnUrl && staticTurnUsername && staticTurnCredential);

/** ICE yapılandırmasının hangi kaynaktan geldiği — günlüğe ve teşhise yazılır. */
export type IceSource = 'edge' | 'static' | 'stun-only';

export interface IceConfig {
  rtc: RTCConfiguration;
  source: IceSource;
  /** Relay (TURN) adayı üretilebilir mi? false ise kısıtlı ağlarda bağlantı kurulamaz. */
  hasTurn: boolean;
}

interface CachedIce extends IceConfig {
  /** Kimlik bilgisinin geçerliliğini yitireceği zaman (ms, epoch). */
  expiresAt: number;
}

let cache: CachedIce | null = null;
let inflight: Promise<IceConfig> | null = null;

/** Süresi dolmaya 60 sn'den az kalmışsa yeniden al. */
const REFRESH_MARGIN_MS = 60_000;

function stunOnly(): IceConfig {
  return { rtc: { iceServers: [...STUN_SERVERS] }, source: 'stun-only', hasTurn: false };
}

function staticTurn(): IceConfig {
  return {
    rtc: {
      iceServers: [
        ...STUN_SERVERS,
        { urls: staticTurnUrl!, username: staticTurnUsername!, credential: staticTurnCredential! },
      ],
    },
    source: 'static',
    hasTurn: true,
  };
}

/** Edge fonksiyonundan süreli kimlik bilgisi çeker. Başarısızsa null döner. */
async function fetchFromEdge(): Promise<CachedIce | null> {
  let accessToken: string | null = null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    accessToken = session?.access_token ?? null;
  } catch { /* oturum okunamadı — anon key ile deneriz */ }

  // Fonksiyon verify_jwt ile korunuyor; oturumsuz istemci anon key ile de
  // gateway'i geçebilir ama kimliği "anon" olur. İkisi de kabul edilebilir.
  const bearer = accessToken || ARKU_ANON_KEY;

  const ctrl = new AbortController();
  // ICE alımı bağlantı kurulumunu bloke eder — 5 sn'den fazla beklemeyiz.
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(TURN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ARKU_ANON_KEY,
        Authorization: `Bearer ${bearer}`,
      },
      body: '{}',
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      iceServers?: RTCIceServer[]; ttl?: number; turn?: boolean;
    };
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) return null;

    const ttlMs = typeof data.ttl === 'number' && data.ttl > 0 ? data.ttl * 1000 : 0;
    return {
      rtc: { iceServers: data.iceServers },
      source: 'edge',
      hasTurn: !!data.turn,
      // TTL yoksa (TURN kapalı) kısa süre önbellekle, yapılandırma açılırsa yakalayalım.
      expiresAt: Date.now() + (ttlMs || 5 * 60_000),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bu bağlantı için kullanılacak ICE yapılandırmasını döndürür.
 * Sonuç, kimlik bilgisinin süresi dolana kadar önbelleklenir; eşzamanlı
 * çağrılar tek bir istek paylaşır.
 */
export async function getIceConfig(): Promise<IceConfig> {
  if (cache && cache.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return { rtc: cache.rtc, source: cache.source, hasTurn: cache.hasTurn };
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const fresh = await fetchFromEdge();
    if (fresh && fresh.hasTurn) {
      cache = fresh;
      return { rtc: fresh.rtc, source: fresh.source, hasTurn: fresh.hasTurn };
    }
    // Edge TURN veremedi: build zamanı TURN varsa onu kullan.
    if (hasStaticTurn) {
      const s = staticTurn();
      cache = { ...s, expiresAt: Date.now() + 60 * 60_000 };
      return s;
    }
    // Hiç TURN yok. Edge en azından STUN listesi verdiyse onu kullan.
    if (fresh) {
      cache = fresh;
      return { rtc: fresh.rtc, source: fresh.source, hasTurn: false };
    }
    const s = stunOnly();
    cache = { ...s, expiresAt: Date.now() + 60_000 };
    return s;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Oturum kapatma / kimlik değişiminde önbelleği düşür. */
export function resetIceCache(): void {
  cache = null;
}

/** Günlük satırı için insan tarafından okunabilir özet. */
export function describeIce(cfg: IceConfig): string {
  // 'edge' hem HMAC (kendi coturn'ümüz) hem sabit kimlik (yönetilen sağlayıcı)
  // modunu kapsar; ikisinde de kimlik sunucudan gelir, binary'ye gömülü değildir.
  if (cfg.source === 'edge' && cfg.hasTurn) return 'ICE: STUN + TURN (sunucudan)';
  if (cfg.source === 'static') return 'ICE: STUN + TURN (build yapılandırması)';
  return 'ICE: yalnızca STUN — kısıtlı ağlarda bağlantı kurulamayabilir';
}

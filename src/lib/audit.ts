// Arku Remote — Denetim izi istemcisi.
//
// Kayıtlar `session_audit` tablosuna yazılır; sunucudaki trigger sıra
// numarasını, önceki hash'i ve hash'i KENDİSİ hesaplar. İstemci bunları
// gönderemez (gönderse yok sayılır) ve yazılan kayıt sonradan
// değiştirilemez/silinemez. Gerekçe: supabase/migrations/20260909_*.sql
//
// ── NE YAZILIR, NE YAZILMAZ ────────────────────────────────────────────────
// YAZILIR : olayın kendisi, tarafların kimlikleri, süre, rıza metni sürümü,
//           dosya adı/boyutu, cihaz öznitelikleri.
// YAZILMAZ: ekran görüntüsü, dosya içeriği, pano metni, tuş vuruşları.
// Kayıt videosu zaten sunucuya hiç gelmez; burada yalnızca üstverisi durur.

import { supabase } from './supabase';

export type AuditEvent =
  | 'session_start'
  | 'session_end'
  | 'control_granted'
  | 'control_revoked'
  | 'recording_consent'
  | 'recording_start'
  | 'recording_stop'
  | 'file_sent'
  | 'file_received';

/**
 * Cihaz öznitelikleri — DESTEKLEYİCİ delil.
 *
 * UYARI (bilerek burada duruyor): MAC adresi tek başına zayıf bir delildir.
 * Saniyeler içinde değiştirilebilir ve Windows 10+ ile mobil cihazlarda
 * Wi-Fi için rastgeleleştirme varsayılan olarak açıktır. Ayrıca bir kişiye
 * bağlanabildiği anda KİŞİSEL VERİDİR; toplanması ayrı bir işleme
 * faaliyetidir ve aydınlatma metninde yer almalıdır.
 *
 * Bu yüzden MAC burada çapa değil, yanında duran bir özniteliktir. Kaydın
 * asıl çürütülemezliği hash zincirinden gelir.
 */
export interface DeviceAttributes {
  hostname?: string;
  platform?: string;
  release?: string;
  username?: string;
  macs?: string[];
}

let deviceCache: DeviceAttributes | null = null;

/**
 * MAC adresi ve işletim sistemi kullanıcı adı denetim kaydına yazılsın mı?
 *
 * VARSAYILAN KAPALI. İkisi de tek başlarına kişisel veridir; toplanmaları
 * ayrı bir işleme faaliyetidir ve aydınlatma metninde yer almadan
 * yazılmamalıdır. Kaydın çürütülemezliği hash zincirinden gelir, MAC'ten
 * değil. Kullanıcı Ayarlar'dan açabilir. Ayrıntı: docs/KVKK.md
 */
let collectDeviceIds = false;

/** Arayüzdeki tercihi bildirir (Ayarlar > Denetim İzi). */
export function setDeviceIdPolicy(enabled: boolean): void {
  if (enabled !== collectDeviceIds) deviceCache = null; // önbellek politikaya bağlı
  collectDeviceIds = enabled;
}

/** Cihaz özniteliklerini bir kez okur (yalnızca masaüstünde anlamlı). */
export async function getDeviceAttributes(): Promise<DeviceAttributes> {
  if (deviceCache) return deviceCache;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).electronAPI;
  if (api?.deviceIdentity) {
    try {
      const raw: DeviceAttributes = (await api.deviceIdentity()) ?? {};
      // Varsayılanda kimliklendirici alanlar DÜŞÜRÜLÜR. Makine adı ve
      // platform, oturumu bir cihaza bağlamak için yeterli; MAC ve kullanıcı
      // adı ise doğrudan kişiye bağlanır.
      deviceCache = collectDeviceIds
        ? raw
        : { hostname: raw.hostname, platform: raw.platform, release: raw.release };
    } catch { deviceCache = {}; }
  } else {
    // Web sürümü: MAC/hostname erişilemez, yalnızca platform bilgisi.
    deviceCache = { platform: navigator.platform || 'web' };
  }
  return deviceCache;
}

export interface AuditOptions {
  actorIdentity?: string;
  peerIdentity?: string;
  detail?: Record<string, unknown>;
  /** Cihaz öznitelikleri eklensin mi (oturum başlangıcı gibi anlar için). */
  includeDevice?: boolean;
}

/**
 * Denetim kaydı yazar. ASLA hata fırlatmaz ve akışı bekletmez:
 * denetim yazımının başarısızlığı bağlantıyı bozmamalı.
 *
 * Misafir (anonim) oturumda da yazılır — kaydın amacı kimin bağlandığını
 * belgelemektir; anonim kullanıcının da bir auth.uid()'i vardır.
 */
export function recordAudit(event: AuditEvent, opts: AuditOptions = {}): void {
  void (async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return; // oturum yoksa RLS zaten reddeder

      const detail: Record<string, unknown> = { ...(opts.detail ?? {}) };
      if (opts.includeDevice) detail.device = await getDeviceAttributes();
      detail.app = __APP_VERSION__;

      const { error } = await supabase.from('session_audit').insert({
        // actor_id / seq / hash / prev_hash SUNUCUDA yazılır; göndermiyoruz.
        actor_id: user.id, // RLS with-check için gerekli; trigger yine de ezer
        actor_identity: opts.actorIdentity ?? null,
        peer_identity: opts.peerIdentity ?? null,
        event,
        detail,
      });
      if (error) console.warn('[arku] denetim kaydi yazilamadi:', error.message);
    } catch (err) {
      console.warn('[arku] denetim kaydi hatasi:', err);
    }
  })();
}

export interface AuditVerifyResult {
  ok: boolean;
  kontrol_edilen: number;
  ilk_bozuk_seq: number | null;
  mesaj: string;
}

/** Zincirin bütünlüğünü sunucuda doğrular. */
export async function verifyAuditChain(): Promise<AuditVerifyResult | null> {
  const { data, error } = await supabase.rpc('arku_audit_verify');
  if (error || !Array.isArray(data) || data.length === 0) return null;
  return data[0] as AuditVerifyResult;
}

export interface AuditRow {
  seq: number;
  event: string;
  actor_identity: string | null;
  peer_identity: string | null;
  detail: Record<string, unknown>;
  hash: string;
  created_at: string;
}

/** Kendi denetim kayıtlarımızı getirir (en yeniden eskiye). */
export async function listAudit(limit = 100): Promise<AuditRow[]> {
  const { data } = await supabase
    .from('session_audit')
    .select('seq, event, actor_identity, peer_identity, detail, hash, created_at')
    .order('seq', { ascending: false })
    .limit(limit);
  return (data as AuditRow[]) ?? [];
}

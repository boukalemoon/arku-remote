import { supabase } from './supabase';
import { getIceConfig, describeIce } from './ice';
import { fingerprintFromSdp, deriveVerificationCode } from './verify';
import type { IceConfig } from './ice';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';
export type SignalType = 'offer' | 'answer' | 'ice-candidate' | 'hangup';

export type InputEventMsg =
  | { type: 'mousemove'; x: number; y: number }
  | { type: 'mousedown'; button: number; x: number; y: number }
  | { type: 'mouseup'; button: number; x: number; y: number }
  | { type: 'click'; button: number; x: number; y: number }
  | { type: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { type: 'keydown'; key: string; code: string }
  | { type: 'keyup'; key: string; code: string }
  // Kontrol eden taraf odağı kaybettiğinde gönderilir: basılı kalan tüm
  // tuş ve düğmeler uzak makinede bırakılır. Bu olmadan pencere değiştiren
  // operatör uzak bilgisayarda Ctrl'ü sonsuza kadar basılı bırakıyordu.
  | { type: 'release-all' };

/**
 * Veri kanalındaki girdi DIŞI mesajlar.
 *
 * GERİYE DÖNÜK UYUMLULUK: girdi mesajları eskiden olduğu gibi düz
 * InputEventMsg olarak gider (`type` alanı taşır). Kontrol mesajları ise
 * `k` alanıyla ayrılır. Böylece v1.0.16 istemcileri yeni mesajları
 * "bozuk girdi" sayıp sessizce atar, girdi akışı da bozulmaz.
 */
export type RemoteScreen = { id: string; name: string };

export type ControlMsg =
  | { k: 'clip-req' }                 // "panonu bana gönder"
  | { k: 'clip-set'; text: string }   // "bunu panona yaz"
  | { k: 'screens-req' }              // "hangi ekranların var?"
  | { k: 'screens'; list: RemoteScreen[]; current?: string }
  | { k: 'screen-select'; id: string } // "şu ekrana geç"
  // Dosya transferi. İkili veri ayrı gönderilir (ArrayBuffer); bu mesajlar
  // yalnızca el sıkışma ve sonlandırma içindir.
  | { k: 'file-offer'; id: string; name: string; size: number }
  | { k: 'file-accept'; id: string }
  | { k: 'file-reject'; id: string }
  | { k: 'file-end'; id: string }
  | { k: 'file-cancel'; id: string; reason?: string }
  // ── Oturum kaydı ──
  // Kayıt YALNIZCA iki taraf da onayladıktan sonra başlar. İzleyen taraf
  // ister (kendi rızası), ekranı paylaşan taraf onaylar (asıl veri sahibi o).
  // Rıza metninin sürümü mesajda taşınır ki kaydın hangi metne dayandığı
  // sonradan ispatlanabilsin.
  | { k: 'rec-request'; consentVersion: string }
  | { k: 'rec-accept'; consentVersion: string }
  | { k: 'rec-reject' }
  | { k: 'rec-started' }
  | { k: 'rec-stopped' };

/** Karşı tarafın göndermek istediği dosyanın künyesi. */
export interface FileOffer { id: string; name: string; size: number }

/** Dosya transferi yaşam döngüsü olayları (arayüz bunları dinler). */
export type FileEvent =
  | { t: 'offer'; offer: FileOffer }
  | { t: 'accepted'; id: string }
  | { t: 'rejected'; id: string }
  | { t: 'progress'; id: string; done: number; total: number; dir: 'in' | 'out' }
  | { t: 'complete'; id: string; name: string; blob: Blob }
  | { t: 'cancelled'; id: string; reason?: string };

/**
 * Dosya transferi sınırları.
 *
 * CHUNK: SCTP mesaj sınırının güvenli altında kalan klasik değer. Daha
 * büyüğü bazı tarayıcılarda kanalı kapatır.
 * BUFFER: geri basınç eşiği — bufferedAmount bunu aşarsa gönderim
 * duraklar. Olmadan büyük dosya belleği şişirip kanalı düşürür.
 * MAX_SIZE: alıcı tarafta dosya bellekte birleştirildiği için üst sınır.
 */
const FILE_CHUNK_SIZE = 16 * 1024;
const FILE_BUFFER_THRESHOLD = 1 * 1024 * 1024;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

interface IncomingSignal {
  id?: string;
  type: SignalType;
  from_id: string;
  payload: Record<string, unknown>;
}

/**
 * Bağlantı yolu — hangi ICE aday çiftinin seçildiği.
 *   host  : aynı yerel ağ (en hızlı)
 *   srflx : NAT delindi, doğrudan P2P
 *   relay : TURN sunucusu üzerinden aktarılıyor (bant genişliği bize maliyet)
 */
export type IcePath = 'host' | 'srflx' | 'relay' | 'unknown';

/** Canlı oturum kalite ölçümleri (2 sn'de bir getStats() ile toplanır). */
export interface RtcQuality {
  path: IcePath;
  /** Gidiş-dönüş gecikmesi (ms). */
  rttMs: number | null;
  /** Video bit hızı (kbit/sn). */
  kbps: number;
  /** Son ölçüm aralığındaki paket kaybı yüzdesi. */
  lossPct: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Ölçüm gelen akıştan mı (izleyen taraf) yoksa giden akıştan mı (paylaşan taraf). */
  direction: 'in' | 'out';
}

/** getStats() çıktısı sürücüye göre değişken; alanları gevşek okuyoruz. */
type StatsRow = Record<string, unknown> & { id?: string; type?: string };

const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

/**
 * Ekran paylaşımı için üst bit hızı sınırı (bit/sn).
 * 4 Mbps, 1080p masaüstü içeriğini metin okunur kalacak şekilde taşır;
 * daha yükseği relay (TURN) maliyetini gereksiz artırır. Kodlayıcı bu tavana
 * ancak ekranda hareket varken yaklaşır, durağan ekranda çok daha az kullanır.
 */
const MAX_VIDEO_BITRATE = 4_000_000;

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private myId: string;
  /** accept() sırasında myId geçici olarak değiştirilebilir; close()'da buna dönülür. */
  private readonly originalId: string;
  private peerId = '';
  /**
   * Karşı tarafın bilinen tüm kimlikleri. Arku'da bir kullanıcıya iki kimlikle
   * ulaşılabilir (UUID ve 123-456-789 biçimli profil kimliği); arayan hangisini
   * çevirdiyse alıcı onunla cevap vermeyebilir. Sinyalleri tek bir kimliğe göre
   * eleyince answer/ICE sessizce düşüyordu — bu küme o eşleşmeyi tolere eder.
   */
  private peerAliases = new Set<string>();
  /** Henüz tanınmayan bir kimlikten gelen ICE adayları (answer'dan önce gelebilir). */
  private unknownCandidates = new Map<string, RTCIceCandidateInit[]>();
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private hasSessionIdColumn = true;
  private dataChannel: RTCDataChannel | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private isReceiver = false;
  private processedSignalIds = new Set<string>();
  private pollSince = '';
  /** Bu oturum için çözülmüş ICE yapılandırması (STUN + süreli TURN). */
  private iceConfig: IceConfig | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  /** Karşı taraf sessizce gittiğinde bağlantıyı düşüren zamanlayıcı. */
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bu oturumun parolasi — dogrulama kodu turetmesine karisir. */
  private sessionPassword = '';
  /** connections satirinin id'si — oturum bitince suresi yazilir. */
  private connectionRowId: string | null = null;
  private connectedAt: number | null = null;
  /** Giden transfer (tek seferde bir tane). */
  private outgoingFile: { id: string; file: File; cancelled: boolean } | null = null;
  /** Gelen transfer — ikili parçalar buna aittir (tek seferde bir tane). */
  private incomingFile: { id: string; name: string; size: number; parts: ArrayBuffer[]; received: number } | null = null;
  /** Bit hızı/kayıp farkını hesaplamak için bir önceki ölçüm. */
  private lastStatsSample: { at: number; bytes: number; lost: number; packets: number } | null = null;

  onConnectionSaved?: (receiverId: string) => void;
  onStateChange?: (state: ConnectionState) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onLog?: (msg: string, type?: string) => void;
  onInputEvent?: (event: InputEventMsg) => void;
  /** Oturum boyunca 2 sn'de bir kalite ölçümü. Bağlantı bitince null gelir. */
  onQuality?: (q: RtcQuality | null) => void;
  /** Girdi disi kontrol mesajlari (pano vb.). */
  onControl?: (msg: ControlMsg) => void;
  /** Dosya transferi olaylari. */
  onFile?: (ev: FileEvent) => void;
  /** Baglanti dogrulama kodu (SAS). Baglanti kurulunca bir kez gelir. */
  onVerification?: (code: string | null) => void;

  constructor(myId: string) {
    this.myId = myId;
    this.originalId = myId;
  }

  /** Verilen kimlik bu oturumun karşı tarafına mı ait? (App seviyesi hangup filtresi) */
  isPeer(id: string): boolean {
    return !!id && this.peerAliases.has(id);
  }

  /**
   * Bu oturumda arayan mıyız yoksa alıcı mı? Gelen bir offer'ın anlamı role göre
   * değişir: alıcıysak karşı tarafın offer'ı ICE restart'tır, arayansak çağrı
   * çakışmasıdır (ICE restart yalnızca arayan tarafından gönderilir).
   */
  getRole(): 'caller' | 'receiver' {
    return this.isReceiver ? 'receiver' : 'caller';
  }

  private setPeer(id: string) {
    this.peerId = id;
    this.peerAliases.add(id);
  }

  private log(msg: string, type = 'info') {
    this.onLog?.(msg, type);
  }

  private generateSessionId(): string {
    return `${this.myId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async send(type: SignalType, payload: unknown) {
    const sessionId = this.sessionId ?? this.generateSessionId();
    if (!this.sessionId) this.sessionId = sessionId;

    const base = { from_id: this.myId, to_id: this.peerId, type, payload };
    let error: { message: string } | null = null;

    if (this.hasSessionIdColumn) {
      const res = await supabase.from('signals').insert({ ...base, session_id: sessionId });
      error = res.error;
      if (error?.message?.includes('session_id')) {
        this.hasSessionIdColumn = false;
        this.log('session_id kolonu yok, eski şemaya geçildi.', 'warn');
      }
    }

    if (!this.hasSessionIdColumn) {
      const res = await supabase.from('signals').insert(base);
      error = res.error;
    }

    if (error) {
      this.log(`Signal gönderilemedi (${type}): ${error.message}`, 'error');
      throw new Error(error.message);
    }
  }

  /** Kimliği yeni tanınan bir göndericiden biriktirilmiş ICE adaylarını kuyruğa al. */
  private adoptCandidatesFrom(fromId: string) {
    const buffered = this.unknownCandidates.get(fromId);
    if (!buffered?.length) return;
    this.log(`${buffered.length} bekleyen ICE adayı eşleştirildi.`, 'sys');
    this.pendingRemoteCandidates.push(...buffered);
    this.unknownCandidates.delete(fromId);
  }

  private async applyPendingCandidates() {
    if (!this.pc || !this.pc.remoteDescription || this.pendingRemoteCandidates.length === 0) return;
    const queued = [...this.pendingRemoteCandidates];
    this.pendingRemoteCandidates = [];
    for (const c of queued) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        this.log(`Bekleyen ICE candidate uygulanamadı: ${String(err)}`, 'warn');
      }
    }
  }

  private setupDataChannel(dc: RTCDataChannel) {
    this.dataChannel = dc;
    // Dosya parcalari ikili gelir; varsayilan 'blob' senkron okumayi zorlastirir.
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = FILE_BUFFER_THRESHOLD;
    dc.onopen = () => this.log('Veri kanalı açıldı.', 'sys');
    dc.onclose = () => this.log('Veri kanalı kapandı.', 'sys');
    dc.onerror = () => this.log('Veri kanalı hatası.', 'warn');
    dc.onmessage = (e) => {
      // Ikili veri = aktif gelen dosyanin parcasi. Ayni anda tek transfer
      // oldugu icin parcaya ayrica kimlik yazmaya gerek yok.
      if (e.data instanceof ArrayBuffer) { this.onFileChunk(e.data); return; }
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        // `k` tasiyan mesajlar kontrol mesajidir; digerleri eski girdi bicimi.
        if (msg && typeof msg.k === 'string') {
          const ctl = msg as unknown as ControlMsg;
          // Dosya mesajlari manager icinde islenir; arayuze yalnizca
          // onFile olaylari olarak yansir.
          if (this.handleFileControl(ctl)) return;
          this.onControl?.(ctl);
          return;
        }
        this.onInputEvent?.(msg as unknown as InputEventMsg);
      } catch {
        // ignore malformed messages
      }
    };
  }

  /**
   * Bu oturumun ICE sunucularını çözer ve günlüğe yazar. TURN yoksa kullanıcı
   * bunu ÖNCEDEN görmeli: "bağlanamıyoruz" şikayetlerinin çoğunun sebebi budur.
   */
  private async prepareIce(): Promise<void> {
    this.iceConfig = await getIceConfig();
    this.log(describeIce(this.iceConfig), this.iceConfig.hasTurn ? 'sys' : 'warn');
  }

  private buildPC(): RTCPeerConnection {
    if (this.pc) { this.pc.close(); this.pc = null; }
    this.reconnectAttempts = 0;

    const pc = new RTCPeerConnection(this.iceConfig?.rtc ?? { iceServers: [] });
    this.pc = pc;

    pc.onicecandidate = async (e) => {
      if (!e.candidate) return;
      try { await this.send('ice-candidate', e.candidate.toJSON()); } catch {}
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.log(`Bağlantı durumu: ${s}`);
      if (s === 'connected') {
        this.reconnectAttempts = 0;
        this.onStateChange?.('connected');
        this.log('P2P bağlantısı kuruldu!', 'sys');
        this.saveConnection();
        this.startStats();
        void this.computeVerification();
      } else if (s === 'disconnected') {
        this.onStateChange?.('connecting');
      } else if (s === 'failed' || s === 'closed') {
        this.stopStats();
        this.onStateChange?.('disconnected');
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.log(`ICE durumu: ${state}`, 'sys');
      if (state === 'failed') {
        this.clearDisconnectWatchdog();
        this.attemptIceRestart();
      } else if (state === 'disconnected') {
        this.startDisconnectWatchdog();
      } else if (state === 'connected' || state === 'completed') {
        this.clearDisconnectWatchdog();
      }
    };

    pc.onicegatheringstatechange = () => {
      this.log(`ICE toplama: ${pc.iceGatheringState}`, 'info');
    };

    pc.ondatachannel = (e) => {
      this.log('Veri kanalı alındı.', 'sys');
      this.setupDataChannel(e.channel);
    };

    pc.ontrack = (e) => {
      this.log(`Track alındı: kind=${e.track?.kind}`, 'sys');
      const stream = e.streams?.[0] ?? new MediaStream([e.track]);
      if (e.streams?.[0]) {
        this.log(`Uzak ekran akışı alındı: ${e.streams[0].id}`, 'sys');
      } else {
        this.log('Track ile yeni MediaStream oluşturuldu.', 'sys');
      }
      this.onRemoteStream?.(stream);

      // When the receiver stops screen sharing (browser native "Stop" button),
      // the remote track ends here. Treat it as a disconnect so the caller's UI updates.
      e.track.onended = () => {
        this.log('Uzak ekran akışı sona erdi — bağlantı kapatılıyor.', 'warn');
        this.onStateChange?.('disconnected');
      };
    };

    return pc;
  }

  // Only the caller (offerer) restarts ICE to avoid signaling conflicts
  private async attemptIceRestart() {
    if (!this.pc || this.isReceiver) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log(`Yeniden bağlantı limiti aşıldı (${this.maxReconnectAttempts} deneme).`, 'error');
      this.onStateChange?.('disconnected');
      return;
    }
    this.reconnectAttempts++;
    this.log(`ICE yeniden başlatılıyor... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'warn');
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      await this.send('offer', offer);
    } catch (err) {
      this.log(`ICE restart başarısız: ${String(err)}`, 'error');
      this.onStateChange?.('disconnected');
    }
  }

  /**
   * Video göndericisini uzak masaüstü için ayarlar.
   *
   * Varsayılanlar hareketli video içindir ve ekran paylaşımında yanlış sonuç
   * verir: kodlayıcı önce ÇÖZÜNÜRLÜĞÜ düşürür, metin bulanıklaşır. Doğrusu
   * tersidir — çözünürlüğü koru, gerekirse kare hızını düşür.
   *
   * setParameters bazı tarayıcı/sürücü kombinasyonlarında desteklenmez;
   * başarısızlık bağlantıyı etkilemez, yalnızca günlüğe yazılır.
   */
  private async tuneVideoSender(): Promise<void> {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        // Bazı tarayıcılar encodings'i setLocalDescription'dan önce boş verir.
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
      // Kaynak track'in kare hızını üst sınır olarak ver (kullanıcı ayarı).
      const fps = sender.track?.getSettings().frameRate;
      if (typeof fps === 'number' && fps > 0) params.encodings[0].maxFramerate = Math.round(fps);
      // degradationPreference bazı TS lib sürümlerinde tanımlı değil.
      (params as { degradationPreference?: string }).degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);
      this.log(`Video kodlayıcı ayarlandı: ${Math.round(MAX_VIDEO_BITRATE / 1000)} kbps, çözünürlük korumalı.`, 'sys');
    } catch (err) {
      this.log(`Video kodlayıcı ayarlanamadı (varsayılanlarla devam): ${String(err)}`, 'warn');
    }
  }

  /**
   * Bağlantı doğrulama kodunu (SAS) hesaplar ve arayüze bildirir.
   *
   * Kod, iki tarafın DTLS sertifika parmak izinden türetilir. Sinyalleşmeyi
   * ele geçirip araya giren biri iki AYRI DTLS oturumu kurmak zorundadır;
   * o zaman parmak izleri farklı olur ve iki ekrandaki kod TUTMAZ.
   * Detaylı gerekçe: lib/verify.ts
   */
  private async computeVerification(): Promise<void> {
    const local = fingerprintFromSdp(this.pc?.localDescription?.sdp);
    const remote = fingerprintFromSdp(this.pc?.remoteDescription?.sdp);
    if (!local || !remote) { this.onVerification?.(null); return; }
    const code = await deriveVerificationCode(local, remote, this.sessionPassword);
    this.onVerification?.(code);
    if (code) this.log(`Bağlantı doğrulama kodu: ${code}`, 'sys');
  }

  /**
   * Karşı taraf gittiğinde hızlı tepki verir.
   *
   * NEDEN: kapanışta gönderilen hangup sinyali HER ZAMAN ulaşmaz — ağ
   * kesilebilir, oturum düşmüş olabilir (o durumda RLS insert'i reddeder).
   * Sinyal gelmeyince tek kalan yol ICE'in kendi zaman aşımıydı: kullanıcı
   * 15-30 saniye donmuş bir görüntüye bakıyordu.
   *
   * ICE 'disconnected'a düşünce kısa bir süre toparlanmasını bekliyoruz
   * (gerçek bir ağ takılması bu sürede düzelebilir); düzelmezse kapatıyoruz.
   * Denge: çok kısa süre geçici takılmada bağlantıyı gereksiz düşürür,
   * çok uzun süre donmuş ekran hissini sürdürür.
   */
  private static readonly DISCONNECT_GRACE_MS = 6000;

  private startDisconnectWatchdog(): void {
    if (this.disconnectTimer) return;
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      const st = this.pc?.iceConnectionState;
      if (st === 'connected' || st === 'completed') return; // toparlandı
      this.log('Karşı taraftan yanıt gelmiyor — bağlantı kapatılıyor.', 'warn');
      this.onStateChange?.('disconnected');
      this.close();
    }, WebRTCManager.DISCONNECT_GRACE_MS);
  }

  private clearDisconnectWatchdog(): void {
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
  }

  // ── Kalite telemetrisi ─────────────────────────────────────────────────────
  // Eskiden getStats() hiç çağrılmıyordu: destek ekibi "yavaş/bulanık" şikayeti
  // geldiğinde bağlantının relay üzerinden mi gittiğini, gecikmeyi veya paket
  // kaybını göremiyordu. Artık 2 sn'de bir ölçülüp arayüze veriliyor.
  private startStats(): void {
    if (this.statsTimer) return;
    this.lastStatsSample = null;
    const tick = () => { void this.collectStats(); };
    tick();
    this.statsTimer = setInterval(tick, 2000);
  }

  private stopStats(): void {
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    this.lastStatsSample = null;
    this.onQuality?.(null);
  }

  /** Seçili aday çiftinden bağlantı yolunu (host/srflx/relay) çıkarır. */
  private static resolvePath(rows: StatsRow[], byId: Map<string, StatsRow>): { path: IcePath; rttMs: number | null } {
    // Nominated + succeeded çift tercih edilir; yoksa succeeded olan ilk çift.
    let pair: StatsRow | null = null;
    for (const r of rows) {
      if (r.type !== 'candidate-pair' || r.state !== 'succeeded') continue;
      if (!pair || (r.nominated === true && pair.nominated !== true)) pair = r;
    }
    if (!pair) return { path: 'unknown', rttMs: null };

    const local = byId.get(String(pair.localCandidateId ?? ''));
    const remote = byId.get(String(pair.remoteCandidateId ?? ''));
    const types = [local?.candidateType, remote?.candidateType];

    const path: IcePath = types.includes('relay') ? 'relay'
      : types.includes('srflx') || types.includes('prflx') ? 'srflx'
      : types.includes('host') ? 'host'
      : 'unknown';

    const rtt = num(pair.currentRoundTripTime);
    return { path, rttMs: rtt === null ? null : Math.round(rtt * 1000) };
  }

  private async collectStats(): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected') return;

    let report: RTCStatsReport;
    try { report = await pc.getStats(); } catch { return; }

    const rows: StatsRow[] = [];
    const byId = new Map<string, StatsRow>();
    report.forEach((s) => {
      const row = s as unknown as StatsRow;
      rows.push(row);
      if (row.id) byId.set(row.id, row);
    });

    const { path, rttMs } = WebRTCManager.resolvePath(rows, byId);

    // İzleyen taraf gelen akışı, paylaşan taraf giden akışı ölçer.
    let video: StatsRow | null = null;
    let direction: 'in' | 'out' = 'in';
    for (const r of rows) {
      if (r.type === 'inbound-rtp' && r.kind === 'video') { video = r; direction = 'in'; break; }
    }
    if (!video) {
      for (const r of rows) {
        if (r.type === 'outbound-rtp' && r.kind === 'video') { video = r; direction = 'out'; break; }
      }
    }

    let kbps = 0;
    let lossPct: number | null = null;
    if (video) {
      const bytes = num(direction === 'in' ? video.bytesReceived : video.bytesSent) ?? 0;
      const lost = num(video.packetsLost) ?? 0;
      const packets = num(direction === 'in' ? video.packetsReceived : video.packetsSent) ?? 0;
      const at = num(video.timestamp) ?? Date.now();

      const prev = this.lastStatsSample;
      if (prev && at > prev.at) {
        const seconds = (at - prev.at) / 1000;
        kbps = Math.max(0, Math.round(((bytes - prev.bytes) * 8) / 1000 / seconds));
        const dLost = Math.max(0, lost - prev.lost);
        const dPackets = Math.max(0, packets - prev.packets);
        const total = dLost + dPackets;
        // Kayıp yüzdesi yalnızca anlamlı bir örneklem varsa raporlanır.
        if (total >= 10) lossPct = Math.round((dLost / total) * 1000) / 10;
      }
      this.lastStatsSample = { at, bytes, lost, packets };
    }

    // Çözünürlük/kare hızı: gelen akışta frameWidth, giden akışta da aynı ad kullanılır.
    const width = video ? num(video.frameWidth) : null;
    const height = video ? num(video.frameHeight) : null;
    const fpsRaw = video ? num(video.framesPerSecond) : null;

    this.onQuality?.({
      path,
      rttMs,
      kbps,
      lossPct,
      width,
      height,
      fps: fpsRaw === null ? null : Math.round(fpsRaw),
      direction,
    });
  }

  private async saveConnection() {
    if (this.isReceiver) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      // Misafir (anonim) oturumda bağlantı geçmişi tutulmaz.
      if (!user || user.is_anonymous) return;
      // Satırın id'si tutulur: oturum bitince süre ve bitiş zamanı yazılacak.
      const { data, error } = await supabase.from('connections').insert({
        caller_id: user.id,
        receiver_id: this.peerId,
        status: 'active',
        duration_seconds: 0,
        created_at: new Date().toISOString(),
      }).select('id').single();
      if (error) throw new Error(error.message);
      this.connectionRowId = (data as { id: string } | null)?.id ?? null;
      this.connectedAt = Date.now();
      this.onConnectionSaved?.(this.peerId);
      this.log('Bağlantı geçmişe kaydedildi.', 'sys');
    } catch (err) {
      this.log(`Geçmiş kaydedilemedi: ${String(err)}`, 'warn');
    }
  }

  /**
   * Oturumu geçmişte KAPATIR: bitiş zamanı, süre ve durum yazılır.
   *
   * Eskiden bu hiç yapılmıyordu — her kayıt sonsuza kadar status='active',
   * duration_seconds=0 olarak kalıyordu. Bağlantı geçmişi hem yanıltıcıydı
   * hem de KVKK/denetim izi olarak kullanılamıyordu.
   *
   * Beklenmez (fire-and-forget): kapanış akışını yavaşlatmamalı.
   */
  private finishConnectionRecord(): void {
    const rowId = this.connectionRowId;
    const startedAt = this.connectedAt;
    this.connectionRowId = null;
    this.connectedAt = null;
    if (!rowId) return;
    const seconds = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
    void supabase.from('connections').update({
      status: 'ended',
      ended_at: new Date().toISOString(),
      duration_seconds: seconds,
    }).eq('id', rowId).then(({ error }) => {
      if (error) this.log(`Oturum kaydı kapatılamadı: ${error.message}`, 'warn');
    });
  }

  private sanitizeDescription(desc: Record<string, unknown>): RTCSessionDescriptionInit {
    return { type: desc.type as RTCSdpType, sdp: desc.sdp as string };
  }

  // Central signal processor — called by both WebSocket and polling paths
  private async handleSignal(sig: IncomingSignal): Promise<void> {
    if (!this.pc) return;

    if (!this.peerAliases.has(sig.from_id)) {
      // Bu sinyal zaten bize (to_id = myId) adreslenmiş durumda. Kimlik farklıysa
      // sebebi neredeyse her zaman şu: karşı tarafa profil kimliğiyle (123-456-789)
      // ulaştık, o ise UUID'siyle cevap veriyor. Beklediğimiz answer'ı bu yüzden
      // atmak yerine kimliği benimseyip eş anlamlı olarak kaydediyoruz.
      const isAwaitedAnswer = sig.type === 'answer' && !this.isReceiver && !this.pc.remoteDescription;
      if (isAwaitedAnswer) {
        this.log(`Karşı taraf farklı kimlikle yanıtladı, eşleştirildi: ${sig.from_id.slice(0, 8)}...`, 'sys');
        this.peerAliases.add(sig.from_id);
        this.adoptCandidatesFrom(sig.from_id);
      } else if (sig.type === 'ice-candidate') {
        // Answer'dan önce gelen adaylar kaybolmasın: kimlik tanınana kadar sakla.
        const bucket = this.unknownCandidates.get(sig.from_id) ?? [];
        if (bucket.length < 50) {
          bucket.push(sig.payload as RTCIceCandidateInit);
          this.unknownCandidates.set(sig.from_id, bucket);
        }
        return;
      } else {
        return;
      }
    }

    if (sig.type === 'answer') {
      this.log('Answer alındı.');
      await this.pc.setRemoteDescription(new RTCSessionDescription(this.sanitizeDescription(sig.payload)));
      await this.applyPendingCandidates();
    } else if (sig.type === 'offer') {
      // Zaten uyguladığımız offer'ın aynısı tekrar gelebilir (polling 10 sn geriye
      // bakıyor, kabul edilen ilk offer bu pencereye düşüyor). Bunu ICE restart
      // sanıp yeniden pazarlık başlatmak kurulu bağlantıyı düşürür.
      const incomingSdp = (sig.payload as { sdp?: string }).sdp;
      if (incomingSdp && this.pc.remoteDescription?.sdp === incomingSdp) {
        this.log('Aynı offer tekrar geldi, yok sayıldı.', 'info');
        return;
      }
      // ICE restart offer from caller (receiver handles this)
      this.log('ICE restart teklifi alındı.', 'warn');
      await this.pc.setRemoteDescription(new RTCSessionDescription(this.sanitizeDescription(sig.payload)));
      await this.applyPendingCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.send('answer', answer);
    } else if (sig.type === 'ice-candidate') {
      if (!this.pc.remoteDescription) {
        this.pendingRemoteCandidates.push(sig.payload as RTCIceCandidateInit);
        return;
      }
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(sig.payload as RTCIceCandidateInit));
      } catch (err) {
        this.log(`ICE candidate eklenemedi: ${String(err)}`, 'warn');
      }
    } else if (sig.type === 'hangup') {
      this.log('Karşı taraf bağlantıyı kesti.', 'warn');
      this.onStateChange?.('disconnected');
      this.close();
    }
  }

  // HTTP polling fallback — works even when Supabase Realtime WebSocket is down
  private startPolling(): void {
    if (this.pollingTimer) return;
    // Include signals from the last 10 seconds to catch anything sent just before we started
    this.pollSince = new Date(Date.now() - 10000).toISOString();
    this.pollingTimer = setInterval(() => this.pollSignals(), 1500);
  }

  private stopPolling(): void {
    if (this.pollingTimer) { clearInterval(this.pollingTimer); this.pollingTimer = null; }
  }

  private async pollSignals(): Promise<void> {
    if (!this.pc || !this.peerId) return;
    try {
      const { data } = await supabase
        .from('signals')
        .select('id, type, from_id, payload, created_at')
        .eq('to_id', this.myId)
        // DİKKAT: burada from_id'ye göre FİLTRELEME YOK ve bu kasıtlı.
        // Karşı taraf bize çevirdiğimizden BAŞKA bir kimlikle cevap verebilir
        // (profil kimliği 123-456-789 ile arayıp UUID ile yanıt gelmesi).
        // `from_id = peerId` filtresi tam da beklediğimiz answer'ı eliyordu:
        // WebSocket düştüğünde (kurumsal proxy) bağlantı sessizce kuruluyordu.
        // Eleme işini handleSignal yapıyor; o alias'ı tanıyıp benimsiyor,
        // tanımadığı ICE adaylarını kuyruğa alıyor, gerisini yok sayıyor.
        // RLS zaten yalnızca bizim taraf olduğumuz satırları döndürür.
        // gte: aynı milisaniyede yazılan ICE adayları .gt ile atlanıyordu;
        // processedSignalIds zaten mükerrer işlemeyi engelliyor.
        .gte('created_at', this.pollSince)
        .order('created_at', { ascending: true })
        .limit(50);

      if (!data || data.length === 0) return;

      for (const row of data) {
        if (this.processedSignalIds.has(row.id)) continue;
        this.markProcessed(row.id);
        this.pollSince = row.created_at;
        await this.handleSignal({
          id: row.id,
          type: row.type as SignalType,
          from_id: row.from_id,
          payload: row.payload as Record<string, unknown>,
        });
      }
    } catch {
      // Silently ignore to avoid log spam during brief network hiccups
    }
  }

  /**
   * İşlenmiş sinyal kimliğini kaydeder. Uzun oturumlarda ICE adayları
   * birikip kümeyi sınırsız büyütüyordu; üst sınıra gelince en eskiler düşer.
   * (Sıra ekleme sırasıdır; düşenler zaten çoktan işlenmiş eski adaylardır.)
   */
  private markProcessed(id: string): void {
    if (this.processedSignalIds.size >= 500) {
      const keep = [...this.processedSignalIds].slice(-250);
      this.processedSignalIds = new Set(keep);
    }
    this.processedSignalIds.add(id);
  }

  private async subscribe(): Promise<void> {
    if (this.channel) supabase.removeChannel(this.channel);
    this.processedSignalIds = new Set();

    this.channel = supabase
      .channel(`rtc-recv-${this.myId}-${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'signals', filter: `to_id=eq.${this.myId}` },
        async (payload) => {
          const sig = payload.new as IncomingSignal & { id: string };
          if (this.processedSignalIds.has(sig.id)) return;
          this.markProcessed(sig.id);
          await this.handleSignal(sig);
        }
      );

    // Attempt WebSocket subscription with a 5-second timeout.
    // If it fails or times out, polling (started below) will take over.
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.log('WebSocket zaman aşımı — polling modu aktif.', 'warn');
        resolve();
      }, 5000);

      this.channel?.subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout);
          this.log('Signal kanalı hazır (WebSocket).', 'sys');
          resolve();
        }
        if (status === 'CHANNEL_ERROR' || status === 'ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timeout);
          this.log(`WebSocket hatası (${status}) — polling devreye girdi.`, 'warn');
          resolve(); // Don't throw — polling covers this
        }
      });
    });

    // Always run polling alongside WebSocket as a safety net.
    // processedSignalIds prevents double-processing.
    this.startPolling();
  }

  // CALLER – sends offer, waits for receiver's screen
  //
  // `password`: alıcının ekranında gösterdiği oturum parolası. Alıcı bunu
  // kendi parolasıyla karşılaştırır; tutmazsa çağrı hiç gösterilmeden reddedilir.
  // Böylece kimliği bilen/tahmin eden herkesin karşı tarafı çaldırması biter.
  async call(peerId: string, opts: { password?: string } = {}): Promise<void> {
    if (peerId === this.myId) throw new Error('Kendi cihazınıza bağlanamazsınız.');
    this.sessionPassword = opts.password ?? '';

    this.isReceiver = false;
    this.setPeer(peerId);
    this.sessionId = this.generateSessionId();
    this.pendingRemoteCandidates = [];
    this.onStateChange?.('connecting');
    this.log(`${peerId} adresine bağlantı isteği gönderiliyor...`, 'warn');

    // ICE sunucuları (süreli TURN dahil) peer connection'dan ÖNCE çözülmeli:
    // RTCPeerConnection yapılandırmayı kurulumda alır, sonradan eklenen TURN
    // o oturumda kullanılmaz.
    await this.prepareIce();

    const pc = this.buildPC();

    // Data channel must be created by the offerer before SDP negotiation
    const dc = pc.createDataChannel('input', { ordered: true });
    this.setupDataChannel(dc);

    // Ekranı KARŞI taraf paylaşır; biz yalnızca alırız. Eski `offerToReceiveVideo`
    // bayrağı yerine açık transceiver kullanıyoruz: bayrak standart dışı ve
    // kaldırılma yolunda; offer'da video m-line'ı oluşmazsa alıcının eklediği
    // ekran track'i answer'a giremez ve bağlantı kurulsa bile görüntü gelmez.
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    await this.subscribe();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Parola offer ile birlikte gider. Alıcı, sanitizeDescription ile yalnızca
    // {type, sdp} alanlarını setRemoteDescription'a verdiği için ek alan zararsızdır.
    await this.send('offer', {
      type: offer.type, sdp: offer.sdp,
      ...(opts.password ? { pw: opts.password } : {}),
    });

    this.log('Bağlantı isteği gönderildi, yanıt bekleniyor...');
    this.cleanupTimer = setInterval(() => this.cleanSignals(), 30000);
  }

  /**
   * RECEIVER – ekranı paylaşır, bağlantıyı kabul eder.
   *
   * `addressedAs`: arayanın bize ulaşmak için kullandığı kimlik (offer satırının
   * to_id'si). Cevabı bu kimlikle imzalarız; aksi halde arayan bizi tanıyamaz ve
   * answer/ICE sinyallerini düşürür (görüntü hiç gelmez).
   *
   * `offerSignalId`: kabul ettiğimiz offer satırının id'si. İşlenmiş olarak
   * işaretlenir; polling 10 sn geriye baktığı için aynı offer tekrar okunup
   * ICE restart sanılmasın diye gerekli.
   */
  async accept(
    fromId: string,
    offerPayload: Record<string, unknown>,
    screenStream: MediaStream,
    opts: { sessionId?: string; addressedAs?: string; offerSignalId?: string; password?: string } = {},
  ): Promise<void> {
    const { sessionId, addressedAs, offerSignalId } = opts;
    this.sessionPassword = opts.password ?? '';
    this.isReceiver = true;
    if (addressedAs && addressedAs.trim()) this.myId = addressedAs.trim();
    this.setPeer(fromId);
    // session_id yalnızca offer ile geldiyse güvenilir. Kendi ürettiğimiz bir id
    // ile erken ICE adaylarını sorgulamak hiçbir satırla eşleşmez.
    const sessionFromOffer = !!sessionId;
    this.sessionId = sessionId || this.generateSessionId();
    this.pendingRemoteCandidates = [];
    this.onStateChange?.('connecting');
    this.log('Bağlantı kabul edildi, ekran paylaşılıyor...', 'sys');

    await this.prepareIce();

    const pc = this.buildPC();
    // Ekran içeriği "hareketli video" DEĞİLDİR. contentHint olmadan WebRTC
    // bant genişliği düştüğünde çözünürlüğü kısar ve uzak masaüstündeki metin
    // okunamaz hâle gelir. 'detail' kodlayıcıya keskinliği koru, gerekirse
    // kare hızından ver der.
    screenStream.getVideoTracks().forEach((t) => { t.contentHint = 'detail'; });
    screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
    await this.tuneVideoSender();

    await this.subscribe();

    // Kabul ettiğimiz offer'ı işlenmiş say — aksi halde polling'in 10 sn geriye
    // dönük penceresi onu tekrar okur ve ICE restart sanıp kurulu bağlantıyı düşürür.
    if (offerSignalId) this.processedSignalIds.add(offerSignalId);

    // Caller starts ICE gathering as soon as setLocalDescription fires,
    // which is BEFORE the receiver clicks Accept. Those candidates are already
    // in the DB and won't trigger realtime events — fetch them explicitly.
    try {
      const query = supabase
        .from('signals')
        .select('id, payload')
        .eq('from_id', fromId)
        .eq('to_id', this.myId)
        .eq('type', 'ice-candidate')
        .order('created_at', { ascending: true });
      if (this.hasSessionIdColumn && sessionFromOffer && this.sessionId) {
        query.eq('session_id', this.sessionId);
      }
      const { data: missedCandidates } = await query;
      if (missedCandidates && missedCandidates.length > 0) {
        this.log(`${missedCandidates.length} önceden gönderilmiş ICE adayı bulundu.`, 'sys');
        for (const row of missedCandidates) {
          if (!this.processedSignalIds.has(row.id)) {
            this.processedSignalIds.add(row.id);
            this.pendingRemoteCandidates.push(row.payload as RTCIceCandidateInit);
          }
        }
      }
    } catch (err) {
      this.log(`Önceki ICE adayları alınamadı: ${String(err)}`, 'warn');
    }

    await pc.setRemoteDescription(new RTCSessionDescription(this.sanitizeDescription(offerPayload)));
    await this.applyPendingCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.send('answer', answer);

    this.log('Yanıt gönderildi, bağlantı kuruluyor...');
    this.cleanupTimer = setInterval(() => this.cleanSignals(), 30000);
  }

  // -- Dosya transferi ---------------------------------------------------------

  /** Gelen ikili parcayi biriktirir ve ilerlemeyi bildirir. */
  private onFileChunk(buf: ArrayBuffer): void {
    const inc = this.incomingFile;
    if (!inc) return; // kabul edilmemis transferden gelen veri - yok say
    inc.parts.push(buf);
    inc.received += buf.byteLength;
    // Beyan edilenden fazlasini gondermeye calisan esi kes.
    if (inc.received > inc.size) {
      this.log('Dosya beyan edilenden buyuk - transfer iptal edildi.', 'error');
      this.sendControl({ k: 'file-cancel', id: inc.id, reason: 'size' });
      this.onFile?.({ t: 'cancelled', id: inc.id, reason: 'size' });
      this.incomingFile = null;
      return;
    }
    this.onFile?.({ t: 'progress', id: inc.id, done: inc.received, total: inc.size, dir: 'in' });
  }

  /** Karsi tarafa dosya gondermeyi teklif eder. Kabul edilirse gonderim baslar. */
  offerFile(file: File): string | null {
    if (this.dataChannel?.readyState !== 'open') {
      this.log('Veri kanali acik degil, dosya gonderilemez.', 'warn');
      return null;
    }
    if (this.outgoingFile) {
      this.log('Zaten devam eden bir gonderim var.', 'warn');
      return null;
    }
    if (file.size > MAX_FILE_BYTES) {
      this.log('Dosya cok buyuk (ust sinir ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB).', 'error');
      return null;
    }
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    this.outgoingFile = { id, file, cancelled: false };
    this.sendControl({ k: 'file-offer', id, name: file.name, size: file.size });
    return id;
  }

  /** Gelen teklifi kabul eder (arayuz kullaniciya sorduktan SONRA cagirir). */
  acceptIncomingFile(offer: FileOffer): void {
    if (offer.size > MAX_FILE_BYTES) { this.rejectIncomingFile(offer.id); return; }
    this.incomingFile = { id: offer.id, name: offer.name, size: offer.size, parts: [], received: 0 };
    this.sendControl({ k: 'file-accept', id: offer.id });
  }

  rejectIncomingFile(id: string): void {
    this.incomingFile = null;
    this.sendControl({ k: 'file-reject', id });
  }

  /** Devam eden gonderimi/alimi iptal eder. */
  cancelFile(id: string): void {
    if (this.outgoingFile?.id === id) this.outgoingFile.cancelled = true;
    if (this.incomingFile?.id === id) this.incomingFile = null;
    this.sendControl({ k: 'file-cancel', id });
  }

  /** Kanal bosalana kadar bekler - geri basinc olmadan buyuk dosya kanali dusurur. */
  private waitForDrain(dc: RTCDataChannel): Promise<void> {
    if (dc.bufferedAmount < FILE_BUFFER_THRESHOLD) return Promise.resolve();
    return new Promise((resolve) => {
      const onLow = () => { dc.removeEventListener('bufferedamountlow', onLow); resolve(); };
      dc.addEventListener('bufferedamountlow', onLow);
    });
  }

  /** Kabul alindiktan sonra dosyayi parca parca gonderir. */
  private async pumpOutgoingFile(): Promise<void> {
    const out = this.outgoingFile;
    const dc = this.dataChannel;
    if (!out || !dc) return;
    let offset = 0;
    try {
      while (offset < out.file.size) {
        if (out.cancelled || dc.readyState !== 'open') break;
        await this.waitForDrain(dc);
        if (out.cancelled || dc.readyState !== 'open') break;
        const buf = await out.file.slice(offset, offset + FILE_CHUNK_SIZE).arrayBuffer();
        dc.send(buf);
        offset += buf.byteLength;
        this.onFile?.({ t: 'progress', id: out.id, done: offset, total: out.file.size, dir: 'out' });
      }
      if (!out.cancelled && dc.readyState === 'open' && offset >= out.file.size) {
        this.sendControl({ k: 'file-end', id: out.id });
        this.log('Dosya gonderildi: ' + out.file.name, 'sys');
      }
    } catch (err) {
      this.log('Dosya gonderilemedi: ' + String(err), 'error');
      this.onFile?.({ t: 'cancelled', id: out.id, reason: 'error' });
    } finally {
      if (this.outgoingFile?.id === out.id) this.outgoingFile = null;
    }
  }

  /** Dosya kontrol mesajlarini isler. true donerse mesaj tuketildi. */
  private handleFileControl(msg: ControlMsg): boolean {
    if (msg.k === 'file-offer') {
      // Kabul kararini KULLANICI verir; arayuz acceptIncomingFile/reject cagirir.
      this.onFile?.({ t: 'offer', offer: { id: msg.id, name: msg.name, size: msg.size } });
      return true;
    }
    if (msg.k === 'file-accept') {
      if (this.outgoingFile?.id !== msg.id) return true;
      this.onFile?.({ t: 'accepted', id: msg.id });
      void this.pumpOutgoingFile();
      return true;
    }
    if (msg.k === 'file-reject') {
      if (this.outgoingFile?.id === msg.id) this.outgoingFile = null;
      this.onFile?.({ t: 'rejected', id: msg.id });
      return true;
    }
    if (msg.k === 'file-end') {
      const inc = this.incomingFile;
      if (!inc || inc.id !== msg.id) return true;
      this.incomingFile = null;
      // Eksik geldiyse tamamlanmis sayma.
      if (inc.received < inc.size) {
        this.onFile?.({ t: 'cancelled', id: inc.id, reason: 'incomplete' });
        return true;
      }
      this.onFile?.({ t: 'complete', id: inc.id, name: inc.name, blob: new Blob(inc.parts) });
      return true;
    }
    if (msg.k === 'file-cancel') {
      if (this.outgoingFile?.id === msg.id) this.outgoingFile.cancelled = true;
      if (this.incomingFile?.id === msg.id) this.incomingFile = null;
      this.onFile?.({ t: 'cancelled', id: msg.id, reason: msg.reason });
      return true;
    }
    return false;
  }

  /** Girdi disi kontrol mesaji gonderir (pano vb.). */
  sendControl(msg: ControlMsg): void {
    if (this.dataChannel?.readyState !== 'open') return;
    try {
      this.dataChannel.send(JSON.stringify(msg));
    } catch (err) {
      this.log(`Kontrol mesaji gonderilemedi: ${String(err)}`, 'warn');
    }
  }

  /**
   * Paylaşılan video track'ini yeniden pazarlık YAPMADAN değiştirir.
   * Çoklu monitör geçişinde kullanılır: replaceTrack SDP'ye dokunmaz,
   * dolayısıyla bağlantı kopmaz ve karşı taraf anında yeni ekranı görür.
   */
  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) throw new Error('Video göndericisi bulunamadı.');
    track.contentHint = 'detail';
    await sender.replaceTrack(track);
    // Yeni track varsayilan kodlayici ayarlariyla gelir; tekrar ayarla.
    await this.tuneVideoSender();
    this.log('Paylaşılan ekran değiştirildi.', 'sys');
  }

  sendInput(event: InputEventMsg): void {
    if (this.dataChannel?.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify(event));
      } catch (err) {
        this.log(`Girdi gönderilemedi: ${String(err)}`, 'warn');
      }
    }
  }

  /**
   * Bağlantıyı kapatır. Yerel teardown ÖNCE yapılır, hangup sinyali arkadan
   * gönderilir: insert ağda/RLS'te takılırsa "İptal Et" ve "Bağlantıyı Kes"
   * kilitlenmemeli. Eskiden insert await ediliyordu ve arayüz donuyordu.
   */
  async disconnect(): Promise<void> {
    const peer = this.peerId;
    const fromId = this.myId;
    const sessionId = this.sessionId;

    this.close();
    this.onStateChange?.('idle');
    this.log('Bağlantı kapatıldı.', 'warn');

    if (peer) this.sendHangupDetached(fromId, peer, sessionId);
  }

  /** Hangup'ı bekletmeden gönder — sonucu yalnızca loglanır. */
  private sendHangupDetached(fromId: string, toId: string, sessionId: string | null): void {
    const row: Record<string, unknown> = { from_id: fromId, to_id: toId, type: 'hangup', payload: {} };
    if (this.hasSessionIdColumn && sessionId) row.session_id = sessionId;
    void supabase.from('signals').insert(row).then(({ error }) => {
      if (error) this.log(`Hangup gönderilemedi: ${error.message}`, 'warn');
    });
  }

  private close() {
    this.stopPolling();
    this.stopStats();
    this.clearDisconnectWatchdog();
    // Devam eden transferler baglantiyla birlikte duser.
    if (this.outgoingFile) this.outgoingFile.cancelled = true;
    this.outgoingFile = null;
    this.incomingFile = null;
    this.sessionPassword = '';
    this.onVerification?.(null);
    // Oturum suresi ve bitis zamani geceye yazilir (beklenmez).
    this.finishConnectionRecord();
    this.dataChannel?.close();
    this.dataChannel = null;
    this.pc?.close();
    this.pc = null;
    this.pendingRemoteCandidates = [];
    this.unknownCandidates.clear();
    this.peerAliases.clear();
    this.myId = this.originalId; // accept() sırasındaki geçici kimlik geri alınır
    this.processedSignalIds = new Set();
    if (this.channel) { supabase.removeChannel(this.channel); this.channel = null; }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  private async cleanSignals() {
    const ago = new Date(Date.now() - 60000).toISOString();
    try {
      if (this.hasSessionIdColumn && this.sessionId) {
        await supabase.from('signals').delete().eq('session_id', this.sessionId).lt('created_at', ago);
        return;
      }
      // Fallback: sadece bu peer çiftine ait sinyalleri sil — tüm kullanıcı sinyallerini değil
      await supabase.from('signals').delete()
        .eq('from_id', this.myId)
        .eq('to_id', this.peerId)
        .lt('created_at', ago);
    } catch (err) {
      this.log(`Sinyal temizleme hatası: ${String(err)}`, 'warn');
    }
  }

  isConnected(): boolean { return this.pc?.connectionState === 'connected'; }

  /** Bu oturumun karşı taraf kimliği — App seviyesindeki sinyal filtreleri için. */
  getPeerId(): string { return this.peerId; }

  /** Bu oturumda kullanılan ICE yapılandırması (TURN var mı, kaynağı ne). */
  getIce(): IceConfig | null { return this.iceConfig; }
}

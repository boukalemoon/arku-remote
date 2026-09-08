import { supabase } from './supabase';
import { getIceConfig, describeIce } from './ice';
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
  /** connections satirinin id'si — oturum bitince suresi yazilir. */
  private connectionRowId: string | null = null;
  private connectedAt: number | null = null;
  /** Bit hızı/kayıp farkını hesaplamak için bir önceki ölçüm. */
  private lastStatsSample: { at: number; bytes: number; lost: number; packets: number } | null = null;

  onConnectionSaved?: (receiverId: string) => void;
  onStateChange?: (state: ConnectionState) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onLog?: (msg: string, type?: string) => void;
  onInputEvent?: (event: InputEventMsg) => void;
  /** Oturum boyunca 2 sn'de bir kalite ölçümü. Bağlantı bitince null gelir. */
  onQuality?: (q: RtcQuality | null) => void;

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
    dc.onopen = () => this.log('Veri kanalı açıldı.', 'sys');
    dc.onclose = () => this.log('Veri kanalı kapandı.', 'sys');
    dc.onerror = () => this.log('Veri kanalı hatası.', 'warn');
    dc.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as InputEventMsg;
        this.onInputEvent?.(event);
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
        this.attemptIceRestart();
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
    opts: { sessionId?: string; addressedAs?: string; offerSignalId?: string } = {},
  ): Promise<void> {
    const { sessionId, addressedAs, offerSignalId } = opts;
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

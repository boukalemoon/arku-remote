import { supabase } from './supabase';

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
const turnUsername = import.meta.env.VITE_TURN_USERNAME as string | undefined;
const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;

const ICE_SERVERS: RTCConfiguration = {
  iceServers: turnUrl && turnUsername && turnCredential
    ? [...STUN_SERVERS, { urls: turnUrl, username: turnUsername, credential: turnCredential }]
    : STUN_SERVERS,
};

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';
export type SignalType = 'offer' | 'answer' | 'ice-candidate' | 'hangup';

export type InputEventMsg =
  | { type: 'mousemove'; x: number; y: number }
  | { type: 'mousedown'; button: number; x: number; y: number }
  | { type: 'mouseup'; button: number; x: number; y: number }
  | { type: 'click'; button: number; x: number; y: number }
  | { type: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { type: 'keydown'; key: string; code: string }
  | { type: 'keyup'; key: string; code: string };

interface IncomingSignal {
  id?: string;
  type: SignalType;
  from_id: string;
  payload: Record<string, unknown>;
}

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private myId: string;
  private peerId = '';
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

  onConnectionSaved?: (receiverId: string) => void;
  onStateChange?: (state: ConnectionState) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onLog?: (msg: string, type?: string) => void;
  onInputEvent?: (event: InputEventMsg) => void;

  constructor(myId: string) {
    this.myId = myId;
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

  private buildPC(): RTCPeerConnection {
    if (this.pc) { this.pc.close(); this.pc = null; }
    this.reconnectAttempts = 0;

    const pc = new RTCPeerConnection(ICE_SERVERS);
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
      } else if (s === 'disconnected') {
        this.onStateChange?.('connecting');
      } else if (s === 'failed' || s === 'closed') {
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

  private async saveConnection() {
    if (this.isReceiver) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from('connections').insert({
        caller_id: user.id,
        receiver_id: this.peerId,
        status: 'active',
        duration_seconds: 0,
        created_at: new Date().toISOString(),
      });
      this.onConnectionSaved?.(this.peerId);
      this.log('Bağlantı geçmişe kaydedildi.', 'sys');
    } catch (err) {
      this.log(`Geçmiş kaydedilemedi: ${String(err)}`, 'warn');
    }
  }

  private sanitizeDescription(desc: Record<string, unknown>): RTCSessionDescriptionInit {
    return { type: desc.type as RTCSdpType, sdp: desc.sdp as string };
  }

  // Central signal processor — called by both WebSocket and polling paths
  private async handleSignal(sig: IncomingSignal): Promise<void> {
    if (!this.pc) return;
    if (sig.from_id !== this.peerId) return;

    if (sig.type === 'answer') {
      this.log('Answer alındı.');
      await this.pc.setRemoteDescription(new RTCSessionDescription(this.sanitizeDescription(sig.payload)));
      await this.applyPendingCandidates();
    } else if (sig.type === 'offer') {
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
        .eq('from_id', this.peerId)
        .gt('created_at', this.pollSince)
        .order('created_at', { ascending: true })
        .limit(20);

      if (!data || data.length === 0) return;

      for (const row of data) {
        if (this.processedSignalIds.has(row.id)) continue;
        this.processedSignalIds.add(row.id);
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
          this.processedSignalIds.add(sig.id);
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
  async call(peerId: string): Promise<void> {
    if (peerId === this.myId) throw new Error('Kendi cihazınıza bağlanamazsınız.');

    this.isReceiver = false;
    this.peerId = peerId;
    this.sessionId = this.generateSessionId();
    this.pendingRemoteCandidates = [];
    this.onStateChange?.('connecting');
    this.log(`${peerId} adresine bağlantı isteği gönderiliyor...`, 'warn');

    const pc = this.buildPC();

    // Data channel must be created by the offerer before SDP negotiation
    const dc = pc.createDataChannel('input', { ordered: true });
    this.setupDataChannel(dc);

    await this.subscribe();

    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    await this.send('offer', offer);

    this.log('Bağlantı isteği gönderildi, yanıt bekleniyor...');
    this.cleanupTimer = setInterval(() => this.cleanSignals(), 30000);
  }

  // RECEIVER – shares screen, accepts connection
  async accept(fromId: string, offerPayload: Record<string, unknown>, screenStream: MediaStream, sessionId?: string): Promise<void> {
    this.isReceiver = true;
    this.peerId = fromId;
    this.sessionId = sessionId || this.generateSessionId();
    this.pendingRemoteCandidates = [];
    this.onStateChange?.('connecting');
    this.log('Bağlantı kabul edildi, ekran paylaşılıyor...', 'sys');

    const pc = this.buildPC();
    screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));

    await this.subscribe();

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
      if (this.hasSessionIdColumn && this.sessionId) {
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

  async disconnect(): Promise<void> {
    if (this.peerId) {
      try { await this.send('hangup', {}); } catch {}
    }
    this.close();
    this.onStateChange?.('idle');
    this.log('Bağlantı kapatıldı.', 'warn');
  }

  private close() {
    this.stopPolling();
    this.dataChannel?.close();
    this.dataChannel = null;
    this.pc?.close();
    this.pc = null;
    this.pendingRemoteCandidates = [];
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
}

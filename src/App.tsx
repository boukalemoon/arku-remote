import React from 'react';
import { Shield, Lock, Zap, Heart, Monitor, Settings, User, Terminal, Globe, LogOut, Sun, ExternalLink, Copy, CheckCircle, QrCode, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { supabase } from './lib/supabase';
import type { UserProfile, LogType, ConnectionEntry } from './lib/supabase';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { WebRTCManager } from './lib/webrtc';
import type { ConnectionState, InputEventMsg } from './lib/webrtc';

type Theme = 'otuken' | 'umay' | 'gok' | 'gece';
type Tab = 'dashboard' | 'connections' | 'settings';
type AuthMode = 'login' | 'register' | 'mfa' | 'reset';
interface LogEntryLocal { time: string; msg: string; type: LogType; }
interface IncomingCall { fromId: string; offerPayload: Record<string, unknown>; sessionId?: string; }

const generateDeviceFingerprint = (): string => {
  const nav = window.navigator;
  const raw = [nav.userAgent, nav.language, screen.width + 'x' + screen.height, screen.colorDepth, new Date().getTimezoneOffset(), nav.hardwareConcurrency || 0].join('|');
  return Math.abs(raw.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)).toString(36).toUpperCase();
};
const generateSessionToken = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
const formatId = (raw: string): string => { const c = raw.replace(/\D/g, '').padStart(9, '0').slice(0, 9); return `${c.slice(0,3)}-${c.slice(3,6)}-${c.slice(6,9)}`; };
const generateProfileId = (uid: string): string => formatId(Math.abs(uid.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)).toString());
const getOrCreateGuestId = (): string => { const k = 'arku_guest_id'; let id = localStorage.getItem(k); if (!id) { id = formatId(Math.abs(generateDeviceFingerprint().split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)).toString()); localStorage.setItem(k, id); } return id; };

const THEMES: { id: Theme; label: string; color: string; light?: boolean }[] = [
  { id: 'otuken', label: 'Otüken', color: '#c5a059' },
  { id: 'umay',   label: 'Umay',   color: '#2e6fbf', light: true },
  { id: 'gok',    label: 'Gok',    color: '#64ffda' },
  { id: 'gece',   label: 'Gece',   color: '#ff0080' },
];

export default function App() {
  const [currentUser, setCurrentUser] = React.useState<SupabaseUser | null>(null);
  const [userProfile, setUserProfile] = React.useState<UserProfile | null>(null);
  const [isGuest, setIsGuest] = React.useState(false);
  const [isEmailVerified, setIsEmailVerified] = React.useState(true);
  const [theme, setTheme] = React.useState<Theme>('otuken');
  const [activeTab, setActiveTab] = React.useState<Tab>('dashboard');
  const [isOnline, setIsOnline] = React.useState(navigator.onLine);
  const [showAuth, setShowAuth] = React.useState(false);
  const [showDonation, setShowDonation] = React.useState(false);
  const [connFilter, setConnFilter] = React.useState<'all'|'active'|'timeout'>('all');
  const [authMode, setAuthMode] = React.useState<AuthMode>('login');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [mfaCode, setMfaCode] = React.useState(['','','','','','']);
  const [isMfaValidating, setIsMfaValidating] = React.useState(false);
  const [authError, setAuthError] = React.useState('');
  const [resetSent, setResetSent] = React.useState(false);
  const [resetEmail, setResetEmail] = React.useState('');
  const mfaRefs = React.useRef<(HTMLInputElement | null)[]>([]);
  const [showChangePassword, setShowChangePassword] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = React.useState('');
  const [passwordChangeError, setPasswordChangeError] = React.useState('');
  const [passwordChangeDone, setPasswordChangeDone] = React.useState(false);
  const [profileUpdateDone, setProfileUpdateDone] = React.useState(false);
  const [connectionId, setConnectionId] = React.useState(() => getOrCreateGuestId());
  const [targetId, setTargetId] = React.useState('');
  const [connectionHistory, setConnectionHistory] = React.useState<ConnectionEntry[]>([]);
  const [copied, setCopied] = React.useState(false);
  const [sessionToken, setSessionToken] = React.useState('');
  const [deviceFingerprint, setDeviceFingerprint] = React.useState('');
  const [webrtc, setWebrtc] = React.useState<WebRTCManager | null>(null);
  const [rtcState, setRtcState] = React.useState<ConnectionState>('idle');
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [remoteStream, setRemoteStream] = React.useState<MediaStream | null>(null);
  const [incomingCall, setIncomingCall] = React.useState<IncomingCall | null>(null);
  const connTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const rtcStateRef = React.useRef<ConnectionState>('idle');
  const remoteVideoRef = React.useRef<HTMLVideoElement>(null);
  const localVideoRef = React.useRef<HTMLVideoElement>(null);
  const videoContainerRef = React.useRef<HTMLDivElement>(null);
  const [logs, setLogs] = React.useState<LogEntryLocal[]>([]);
  const [inputEnabled, setInputEnabled] = React.useState(false);
  const [captureFrameRate, setCaptureFrameRate] = React.useState(15);
  const lastMouseMoveRef = React.useRef(0);
  // Polling fallback refs for when Supabase Realtime WebSocket is unavailable
  const incomingPollSinceRef = React.useRef(new Date().toISOString());
  const processedOfferIdsRef = React.useRef(new Set<string>());
  // Ref mirror of webrtc state — used inside useEffect callbacks to avoid stale closures
  const webrtcRef = React.useRef<import('./lib/webrtc').WebRTCManager | null>(null);

  const ts = () => new Date().toLocaleTimeString('tr-TR');
  const addLocalLog = (msg: string, type: LogType = 'info') => setLogs(p => [{ time: ts(), msg, type }, ...p].slice(0, 50));

  const handleVideoMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!inputEnabled || !webrtc || rtcState !== 'connected' || !remoteStream) return;
    const now = Date.now();
    if (now - lastMouseMoveRef.current < 33) return; // ~30 fps throttle
    lastMouseMoveRef.current = now;
    const rect = e.currentTarget.getBoundingClientRect();
    webrtc.sendInput({ type: 'mousemove', x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
  };
  const handleVideoMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!inputEnabled || !webrtc || rtcState !== 'connected' || !remoteStream) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    webrtc.sendInput({ type: 'mousedown', button: e.button, x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
  };
  const handleVideoMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!inputEnabled || !webrtc || rtcState !== 'connected' || !remoteStream) return;
    const rect = e.currentTarget.getBoundingClientRect();
    webrtc.sendInput({ type: 'mouseup', button: e.button, x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
  };
  const handleVideoWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!inputEnabled || !webrtc || rtcState !== 'connected' || !remoteStream) return;
    const rect = e.currentTarget.getBoundingClientRect();
    webrtc.sendInput({ type: 'wheel', dx: e.deltaX, dy: e.deltaY, x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
  };
  const handleVideoKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!inputEnabled || !webrtc || rtcState !== 'connected' || !remoteStream) return;
    e.preventDefault();
    webrtc.sendInput({ type: 'keydown', key: e.key, code: e.code });
  };
  const handleVideoKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!inputEnabled || !webrtc || rtcState !== 'connected' || !remoteStream) return;
    webrtc.sendInput({ type: 'keyup', key: e.key, code: e.code });
  };
  const addLog = async (msg: string, type: LogType = 'info') => {
    addLocalLog(msg, type);
    if (!currentUser) return;
    await supabase.from('logs').insert({ user_id: currentUser.id, msg, type });
  };

  React.useEffect(() => { rtcStateRef.current = rtcState; }, [rtcState]);
  React.useEffect(() => { webrtcRef.current = webrtc; }, [webrtc]);
  React.useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);
  React.useEffect(() => { if (showAuth && authMode === 'mfa') setTimeout(() => mfaRefs.current[0]?.focus(), 100); }, [showAuth, authMode]);
  React.useEffect(() => {
    const on = () => { setIsOnline(true); addLocalLog('Internet baglantisi kuruldu.', 'sys'); };
    const off = () => { setIsOnline(false); addLocalLog('Internet baglantisi kesildi.', 'warn'); };
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  React.useLayoutEffect(() => {
    if (remoteStream && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
      remoteVideoRef.current.play().catch(() => {});
    }
  }, [remoteStream]);

  React.useEffect(() => {
    const ids = Array.from(new Set([currentUser?.id, connectionId].filter((v): v is string => !!v && v.trim().length > 0)));
    if (ids.length === 0) return;
    const channels = ids.map(rid =>
      supabase.channel(`call-in:${rid}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'signals', filter: `to_id=eq.${rid}` }, (payload) => {
          const sig = payload.new as any;
          if (sig.type === 'offer') {
            // Skip ICE restart offers during an active or establishing connection;
            // those are handled internally by WebRTCManager's own subscription.
            if (rtcStateRef.current === 'connected' || rtcStateRef.current === 'connecting') return;
            setIncomingCall({ fromId: sig.from_id, offerPayload: sig.payload, sessionId: sig.session_id });
            addLocalLog(`${sig.from_id} baglanmak istiyor...`, 'warn');
          }
          if (sig.type === 'hangup') {
            setIncomingCall(null);
            addLocalLog('Karsi taraf baglantıyi kesti.', 'warn');
            // Disconnect the active WebRTCManager (uses ref to avoid stale closure)
            webrtcRef.current?.disconnect().catch(() => {});
            setWebrtc(null);
            setRtcState('idle');
            setRemoteStream(null);
            setIsConnecting(false);
            setInputEnabled(false);
            if (localVideoRef.current?.srcObject) {
              (localVideoRef.current.srcObject as MediaStream)?.getTracks().forEach(t => t.stop());
              localVideoRef.current.srcObject = null;
            }
          }
        }).subscribe()
    );
    return () => { channels.forEach(ch => supabase.removeChannel(ch)); };
  }, [currentUser?.id, connectionId]);

  // Polling fallback: detects incoming offers via HTTP when Realtime WebSocket is unavailable.
  // Runs alongside the WebSocket listener; processedOfferIdsRef deduplicates between the two.
  React.useEffect(() => {
    const ids = Array.from(new Set([currentUser?.id, connectionId].filter((v): v is string => !!v && v.trim().length > 0)));
    if (ids.length === 0) return;

    const poll = async () => {
      if (rtcStateRef.current === 'connected' || rtcStateRef.current === 'connecting') return;
      for (const rid of ids) {
        try {
          const { data } = await supabase
            .from('signals')
            .select('id, from_id, payload, session_id, created_at')
            .eq('to_id', rid)
            .eq('type', 'offer')
            .gt('created_at', incomingPollSinceRef.current)
            .order('created_at', { ascending: true })
            .limit(5);
          if (!data || data.length === 0) continue;
          for (const sig of data) {
            if (processedOfferIdsRef.current.has(sig.id)) continue;
            processedOfferIdsRef.current.add(sig.id);
            incomingPollSinceRef.current = sig.created_at;
            setIncomingCall({ fromId: sig.from_id, offerPayload: sig.payload, sessionId: sig.session_id });
            addLocalLog(`${sig.from_id} baglanmak istiyor... (polling)`, 'warn');
          }
        } catch { /* ignore transient errors */ }
      }
    };

    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [currentUser?.id, connectionId]);

  React.useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_e, session) => {
      const user = session?.user ?? null;
      setCurrentUser(user);
      if (user) {
        setIsEmailVerified(!!user.email_confirmed_at);
        const pid = generateProfileId(user.id);
        setConnectionId(pid);
        setSessionToken(generateSessionToken());
        const fp = generateDeviceFingerprint();
        setDeviceFingerprint(fp);
        await supabase.from('users').upsert({ id: user.id, email: user.email, connection_id: pid, device_fingerprint: fp, last_seen: new Date().toISOString() }, { onConflict: 'id' });
        const { data: prof } = await supabase.from('users').select('*').eq('id', user.id).single();
        if (prof) { setUserProfile(prof as UserProfile); if (prof.theme) setTheme(prof.theme as Theme); if (prof.display_name) setDisplayName(prof.display_name); if (prof.phone) setPhone(prof.phone); }
        const { data: lgData } = await supabase.from('logs').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
        if (lgData) setLogs(lgData.map(l => ({ time: new Date(l.created_at).toLocaleTimeString('tr-TR'), msg: l.msg, type: l.type as LogType })));
        const { data: cxData } = await supabase.from('connections').select('*').eq('caller_id', user.id).order('created_at', { ascending: false }).limit(20);
        if (cxData) setConnectionHistory(cxData as ConnectionEntry[]);
      } else {
        setIsEmailVerified(true); setUserProfile(null); setSessionToken(''); setDeviceFingerprint(''); setConnectionId(getOrCreateGuestId());
        setLogs([{ time: ts(), msg: 'Arku Remote v1.0.0 baslatildi...', type: 'sys' }, { time: ts(), msg: 'Lutfen giris yapin.', type: 'warn' }]);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const updateTheme = async (t: Theme) => {
    setTheme(t);
    if (currentUser) { const { error } = await supabase.from('users').update({ theme: t }).eq('id', currentUser.id); if (error) addLocalLog(`Tema kaydedilemedi: ${error.message}`, 'error'); }
  };
  const copyId = () => {
    const write = () => { setCopied(true); addLog('Kimlik panoya kopyalandi.', 'info'); setTimeout(() => setCopied(false), 2000); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(connectionId).then(write);
    else { const ta = document.createElement('textarea'); ta.value = connectionId; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); write(); }
  };

  const handleRegister = async () => {
    setAuthError('');
    if (!displayName.trim()) { setAuthError('Ad Soyad zorunludur.'); return; }
    if (password.length < 6) { setAuthError('Sifre en az 6 karakter olmali.'); return; }
    const { error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName, phone } } });
    if (error) { setAuthError(error.message); return; }
    setShowAuth(false); addLog('Kayit basarili. E-posta kutunuzu kontrol edin.', 'warn');
  };
  const handleLogin = async () => {
    setAuthError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setAuthError(error.message); return; }
    // Check if user has MFA enrolled and requires second factor
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === 'aal1' && aal?.nextLevel === 'aal2') {
      setAuthMode('mfa');
      return;
    }
    setShowAuth(false); addLog('Giris basarili.', 'sys');
  };
  const handlePasswordReset = async () => {
    setAuthError('');
    if (!resetEmail) { setAuthError('E-posta adresinizi girin.'); return; }
    const { error } = await supabase.auth.resetPasswordForEmail(resetEmail);
    if (error) { setAuthError(error.message); return; }
    setResetSent(true);
  };
  const handleUpdateProfile = async () => {
    if (!currentUser) return; setProfileUpdateDone(false);
    const { error } = await supabase.from('users').update({ display_name: displayName, phone }).eq('id', currentUser.id);
    if (error) { addLog(`Profil guncellenemedi: ${error.message}`, 'error'); return; }
    setProfileUpdateDone(true); addLog('Profil guncellendi.', 'sys'); setTimeout(() => setProfileUpdateDone(false), 3000);
  };
  const handleChangePassword = async () => {
    setPasswordChangeError('');
    if (!currentPassword) { setPasswordChangeError('Mevcut sifrenizi girin.'); return; }
    if (newPassword.length < 6) { setPasswordChangeError('Yeni sifre en az 6 karakter olmali.'); return; }
    if (newPassword !== newPasswordConfirm) { setPasswordChangeError('Sifreler eslesmiyor.'); return; }
    const { error: e1 } = await supabase.auth.signInWithPassword({ email: currentUser?.email || '', password: currentPassword });
    if (e1) { setPasswordChangeError('Mevcut sifreniz hatali.'); return; }
    const { error: e2 } = await supabase.auth.updateUser({ password: newPassword });
    if (e2) { setPasswordChangeError(e2.message); return; }
    setPasswordChangeDone(true); setCurrentPassword(''); setNewPassword(''); setNewPasswordConfirm(''); addLog('Sifre guncellendi.', 'sys');
  };
  const validateMfa = async () => {
    setIsMfaValidating(true);
    setAuthError('');
    try {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totp = factors?.totp?.find(f => f.status === 'verified');
      if (!totp) { setAuthError('MFA faktoru bulunamadi.'); setIsMfaValidating(false); return; }
      const { data: challenge, error: cErr } = await supabase.auth.mfa.challenge({ factorId: totp.id });
      if (cErr || !challenge) { setAuthError(cErr?.message ?? 'Challenge olusturulamadi.'); setIsMfaValidating(false); return; }
      const { error: vErr } = await supabase.auth.mfa.verify({ factorId: totp.id, challengeId: challenge.id, code: mfaCode.join('') });
      if (vErr) { setAuthError(vErr.message); setMfaCode(['','','','','','']); mfaRefs.current[0]?.focus(); }
      else { setShowAuth(false); addLog('MFA dogrulamasi basarili.', 'sys'); setMfaCode(['','','','','','']); }
    } catch (err) { setAuthError(String(err)); }
    setIsMfaValidating(false);
  };
  const handleLogout = async () => {
    if (connTimeoutRef.current) clearTimeout(connTimeoutRef.current);
    if (webrtc) { await webrtc.disconnect(); setWebrtc(null); }
    await supabase.auth.signOut();
    setCurrentUser(null); setUserProfile(null); setIsGuest(false); setConnectionHistory([]);
    setRemoteStream(null); setRtcState('idle'); setIsConnecting(false);
    setConnectionId(getOrCreateGuestId()); setDisplayName(''); setPhone(''); setSessionToken(''); setDeviceFingerprint('');
    setActiveTab('dashboard'); addLocalLog('Oturum kapatildi.', 'warn');
  };
  const handleGuestLogin = () => { setIsGuest(true); setShowAuth(false); setAuthError(''); addLog('Misafir olarak devam ediliyor.', 'warn'); };

  const buildManager = (): WebRTCManager => {
    const myId = currentUser?.id || connectionId;
    const m = new WebRTCManager(myId);
    m.onStateChange = (state) => {
      setRtcState(state);
      if (state === 'connected') {
        setIsConnecting(false);
        if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
      }
      if (state === 'disconnected') {
        setIsConnecting(false);
        setRemoteStream(null);
        setInputEnabled(false);
        if (localVideoRef.current?.srcObject) {
          (localVideoRef.current.srcObject as MediaStream)?.getTracks().forEach(t => t.stop());
          localVideoRef.current.srcObject = null;
        }
        if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
      }
      if (state === 'idle') { setIsConnecting(false); setRemoteStream(null); setInputEnabled(false); }
    };
    m.onRemoteStream = (stream) => {
      setRemoteStream(stream);
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
      addLog('Uzak ekran aliniyor.', 'sys');
    };
    m.onLog = (msg, type) => addLog(msg, (type as LogType) || 'info');
    m.onInputEvent = (event: InputEventMsg) => {
      // Forward to Electron main process if running as desktop app
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI?.sendInput?.(event);
    };
    m.onConnectionSaved = async () => {
      if (currentUser) {
        const { data } = await supabase.from('connections').select('*').eq('caller_id', currentUser.id).order('created_at', { ascending: false }).limit(20);
        if (data) setConnectionHistory(data as ConnectionEntry[]);
      }
    };
    return m;
  };

  const handleConnect = async () => {
    if (!currentUser && !isGuest) { setShowAuth(true); setAuthMode('login'); return; }
    if (currentUser && !isEmailVerified) { addLog('Baglanmak icin e-posta dogrulamasi gerekli.', 'error'); setShowAuth(true); return; }
    if (!targetId.trim()) return;
    if (targetId.trim() === connectionId || (currentUser && targetId.trim() === currentUser.id)) { addLog('Kendi cihaziniza baglanamazsiniz.', 'error'); return; }

    if (webrtc) await webrtc.disconnect();
    setWebrtc(null); setRemoteStream(null); setRtcState('idle'); setIsConnecting(true);
    addLog(`${targetId} adresine baglaniliyor...`, 'warn');

    const nd = (v: string) => { const d = v.replace(/\D/g, '').slice(0, 9); return d.length === 9 ? `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6,9)}` : v.trim(); };
    const normalizedTarget = nd(targetId);
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedTarget);

    let peerSignalId = normalizedTarget;

    if (!isGuest && currentUser && !looksLikeUuid) {
      const rawDigits = targetId.replace(/\D/g, '').slice(0, 9);
      let peerUser: { id: string } | null = null;
      const q1 = await supabase.from('users').select('id').eq('connection_id', normalizedTarget).maybeSingle();
      if (q1.data?.id) peerUser = q1.data;
      if (!peerUser && rawDigits.length === 9) {
        const rd = `${rawDigits.slice(0,3)}-${rawDigits.slice(3,6)}-${rawDigits.slice(6,9)}`;
        const q2 = await supabase.from('users').select('id').eq('connection_id', rd).maybeSingle();
        if (q2.data?.id) peerUser = q2.data;
      }
      if (!peerUser) { setIsConnecting(false); addLog(`Hedef kimlik bulunamadi: ${normalizedTarget}`, 'error'); return; }
      peerSignalId = peerUser.id;
      if (peerSignalId === currentUser.id) { setIsConnecting(false); addLog('Kendi hesabiniza baglamazsiniz.', 'error'); return; }
      addLog(`Hedef cozumlendi -> ${peerSignalId.slice(0,8)}...`, 'sys');
    }

    const m = buildManager();
    setWebrtc(m);
    try { await m.call(peerSignalId); }
    catch (err) { addLog(`Baglantiyi gonderilemedi: ${String(err)}`, 'error'); setWebrtc(null); setIsConnecting(false); return; }

    if (connTimeoutRef.current) clearTimeout(connTimeoutRef.current);
    connTimeoutRef.current = setTimeout(async () => {
      if (!m.isConnected()) { await m.disconnect(); setWebrtc(null); setIsConnecting(false); addLog(`${targetId} yanit vermedi (zaman asimi).`, 'error'); }
    }, 30000);
  };

  const handleCancelConnect = async () => {
    if (connTimeoutRef.current) clearTimeout(connTimeoutRef.current);
    if (webrtc) { await webrtc.disconnect(); setWebrtc(null); }
    setIsConnecting(false); setRtcState('idle'); addLog('Baglaniti istegi iptal edildi.', 'warn');
  };

  const handleAcceptCall = async () => {
    if (!incomingCall) return;
    const { fromId, offerPayload, sessionId } = incomingCall;
    // getDisplayMedia must be called while still in the user gesture context
    // (button click). Closing the modal first breaks the gesture chain in Chrome.
    let screen: MediaStream | null = null;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: captureFrameRate }, audio: false });
    } catch { addLog('Ekran paylasimi secilmedi veya reddedildi.', 'error'); return; }
    setIncomingCall(null);
    if (localVideoRef.current) localVideoRef.current.srcObject = screen;
    if (webrtc) await webrtc.disconnect();
    const m = buildManager();
    setWebrtc(m); setTargetId(fromId); setIsConnecting(true);

    // When the user stops screen sharing via the browser's native "Stop sharing" button,
    // the track fires onended. We use `m` directly (not the `webrtc` state variable) to
    // avoid a stale closure — `m` is always the current manager for this call.
    screen.getTracks().forEach(track => {
      track.onended = async () => {
        addLog('Ekran paylasimi durduruldu — baglaniti kesiliyor.', 'warn');
        try { await m.disconnect(); } catch {}
        setWebrtc(null);
        setRtcState('idle');
        setRemoteStream(null);
        setIsConnecting(false);
        setInputEnabled(false);
        if (localVideoRef.current) { localVideoRef.current.srcObject = null; }
      };
    });

    try { await m.accept(fromId, offerPayload, screen, sessionId); }
    catch (err) {
      screen?.getTracks().forEach(t => { t.onended = null; t.stop(); });
      addLog(`Baglaniti kabul edilemedi: ${String(err)}`, 'error');
      setWebrtc(null); setIsConnecting(false);
      if (localVideoRef.current) localVideoRef.current.srcObject = null; return;
    }
    if (connTimeoutRef.current) clearTimeout(connTimeoutRef.current);
    connTimeoutRef.current = setTimeout(async () => {
      if (!m.isConnected()) {
        screen?.getTracks().forEach(t => { t.onended = null; t.stop(); });
        await m.disconnect(); setWebrtc(null); setIsConnecting(false);
        if (localVideoRef.current) localVideoRef.current.srcObject = null;
        addLog('Baglaniti kurulamadi (zaman asimi).', 'error');
      }
    }, 30000);
  };

  const handleRejectCall = async () => {
    if (!incomingCall) return;
    await supabase.from('signals').insert({ from_id: currentUser?.id || connectionId, to_id: incomingCall.fromId, type: 'hangup', payload: { reason: 'rejected' } });
    setIncomingCall(null); addLog('Baglaniti istegi reddedildi.', 'warn');
  };

  const handleDisconnect = async () => {
    if (connTimeoutRef.current) clearTimeout(connTimeoutRef.current);
    if (webrtc) { await webrtc.disconnect(); setWebrtc(null); }
    if (localVideoRef.current?.srcObject) { (localVideoRef.current.srcObject as MediaStream)?.getTracks().forEach(t => t.stop()); localVideoRef.current.srcObject = null; }
    setRemoteStream(null); setRtcState('idle'); setIsConnecting(false); addLog('Baglaniti kesildi.', 'warn');
  };

  const isLight = theme === 'umay';

  return (
    <div className="min-h-screen flex flex-col selection:bg-steppe-gold selection:text-steppe-stone">
      <header className="border-b border-steppe-border sticky top-0 z-50 backdrop-blur-md" style={{ background: isLight ? 'rgba(240,244,248,0.92)' : 'rgba(17,16,16,0.85)' }}>
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 gokturk-border flex items-center justify-center overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
              <img src="/icons/64x64.png" alt="Arku" className="w-9 h-9 object-contain" />
            </div>
            <div>
              <h1 className="text-lg text-steppe-gold leading-none">Arku Remote</h1>
              <span className="text-[7px] px-1 border border-steppe-border text-steppe-gold opacity-60 uppercase tracking-widest">v1.0.0</span>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2 px-3 py-1 border border-steppe-border" style={{ background: 'var(--surface-primary)' }}>
            <div className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-green-400' : 'bg-red-400'}`} />
            <span className="text-[9px] uppercase tracking-widest text-steppe-muted">{isOnline ? 'Cevrimici' : 'Cevrimdisi'}</span>
            {isGuest && <span className="text-[9px] text-yellow-400 ml-2 pl-2 border-l border-steppe-border uppercase tracking-widest">Misafir</span>}
          </div>
          <nav className="hidden md:flex gap-8 items-center">
            {(['dashboard','connections','settings'] as Tab[]).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`text-[11px] uppercase tracking-widest transition-colors ${activeTab === tab ? 'text-steppe-gold' : 'text-steppe-muted hover:text-steppe-paper'}`}>
                {tab === 'dashboard' ? 'Panel' : tab === 'connections' ? 'Baglantilar' : 'Ayarlar'}
              </button>
            ))}
            {currentUser ? (
              <div className="flex items-center gap-4">
                <span className="text-[10px] text-steppe-gold opacity-70">{userProfile?.display_name || currentUser.email}</span>
                <button onClick={handleLogout} className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-steppe-muted hover:text-red-400 transition-colors"><LogOut size={12} /> Cikis</button>
              </div>
            ) : isGuest ? (
              <div className="flex items-center gap-4">
                <span className="text-[10px] text-yellow-400 opacity-70">Misafir</span>
                <button onClick={() => { setShowAuth(true); setAuthMode('login'); setIsGuest(false); }} className="btn-ghost px-5 py-2">Giris Yap</button>
              </div>
            ) : (
              <button onClick={() => { setShowAuth(true); setAuthMode('login'); }} className="btn-ghost px-5 py-2">Giris Yap</button>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-10">
        {activeTab === 'dashboard' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            <div className="lg:col-span-4 space-y-6">
              <div className="gokturk-border p-6 surface-card">
                <p className="text-[10px] uppercase tracking-widest text-steppe-muted mb-4 flex items-center gap-2"><User size={12} className="text-steppe-gold" /> Sizin Kimliginiz</p>
                <div className="flex items-center justify-between">
                  <span className="text-2xl font-display text-steppe-gold">{connectionId}</span>
                  <button onClick={copyId} className="p-2 border border-steppe-border hover:border-steppe-gold transition-colors text-steppe-muted hover:text-steppe-gold">
                    {copied ? <CheckCircle size={16} className="text-green-400" /> : <Copy size={16} />}
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <div className={`w-1.5 h-1.5 rounded-full ${currentUser ? 'bg-green-400' : isGuest ? 'bg-yellow-400' : 'bg-gray-400'}`} />
                  <span className="text-[9px] text-steppe-muted uppercase tracking-widest">{currentUser ? 'Profil ID' : isGuest ? 'Misafir ID' : 'Cihaz ID (Gecici)'}</span>
                </div>
                {currentUser && sessionToken && (
                  <div className="mt-2 p-2 border border-steppe-border" style={{ background: 'var(--log-bg)' }}>
                    <p className="text-[8px] text-steppe-muted font-mono">SESSION: {sessionToken.slice(0,8)}...</p>
                    <p className="text-[8px] text-steppe-muted font-mono">FP: {deviceFingerprint.slice(0,8)}...</p>
                  </div>
                )}
              </div>

              <div className="gokturk-border p-6 surface-card">
                {currentUser && !isEmailVerified && (
                  <div className="mb-4 p-3 border border-yellow-500/40 text-yellow-300 text-[10px]" style={{ background: 'rgba(234,179,8,0.08)' }}>
                    Hesabiniz dogrulanmamis. E-posta kutunuzu kontrol edin.
                  </div>
                )}
                <p className="text-[10px] uppercase tracking-widest text-steppe-muted mb-4 flex items-center gap-2"><Monitor size={12} className="text-steppe-gold" /> Uzak Masaustu Baglan</p>
                <input type="text" placeholder="HEDEF KIMLIK (Orn: 123-456-789)" className="input-field mb-4" value={targetId}
                  onChange={e => setTargetId(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && targetId.trim() && !isConnecting && rtcState !== 'connected') { if (!currentUser && !isGuest) { setShowAuth(true); return; } handleConnect(); } }}
                />
                {rtcState === 'connected' ? (
                  <button onClick={handleDisconnect} className="btn-primary w-full" style={{ background: 'rgba(239,68,68,0.8)' }}>Baglantıyi Kes</button>
                ) : isConnecting ? (
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={handleCancelConnect} className="btn-ghost">Iptal Et</button>
                    <button disabled className="btn-primary opacity-50">Baglaniyor...</button>
                  </div>
                ) : (
                  <button onClick={handleConnect} disabled={!targetId.trim()} className="btn-primary w-full disabled:opacity-40">Baglaniti Kur</button>
                )}
                {!currentUser && !isGuest && <p className="text-[9px] text-steppe-muted mt-3 text-center">Giris yapin veya misafir olarak devam edin</p>}
                {isGuest && <p className="text-[9px] text-yellow-400 mt-3 text-center uppercase tracking-wider">Misafir mod - gecmis kaydedilmez</p>}
              </div>

              <div className="p-5 surface-card border border-steppe-border" style={{ background: isLight ? 'rgba(46,111,191,0.06)' : 'rgba(197,160,89,0.05)' }}>
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm" style={{ background: 'var(--accent-primary)', color: 'var(--btn-text)' }}>Q</div>
                  <p className="text-[11px] uppercase tracking-widest text-steppe-gold">QRtim ile Tanisin</p>
                </div>
                <p className="text-[10px] text-steppe-muted leading-relaxed mb-4">Dijital kartvizitinizi olusturun. Arku Remote hesabinizla entegre calisir.</p>
                <button onClick={() => window.open('https://qartim.com','_blank')} className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-steppe-gold hover:opacity-80 transition-opacity"><ExternalLink size={12} /> qartim.com</button>
              </div>

              <div className="p-5 surface-card border border-steppe-border">
                <div className="flex items-center gap-3 mb-3"><Heart size={14} className="text-steppe-gold" /><p className="text-[11px] uppercase tracking-widest text-steppe-gold">Destek Ol</p></div>
                <p className="text-[10px] text-steppe-muted leading-relaxed mb-4">Arku Remote tamamen ucretsizdir.</p>
                <button onClick={() => setShowDonation(true)} className="btn-ghost w-full">Bagis Yap</button>
              </div>
            </div>

            <div className="lg:col-span-8 space-y-6">
              <div className="grid grid-cols-3 gap-4">
                <StatCard icon={<Shield size={18} />} title="Guvenlik" value="AES-256" sub="Uctan Uca" />
                <StatCard icon={<Zap size={18} />} title="Gecikme" value={rtcState === 'connected' ? '4ms' : '12ms'} sub="Dusuk Gecikme" />
                <StatCard icon={<Globe size={18} />} title="Sunucu" value="Frankfurt" sub="Aktif" />
              </div>

              {rtcState !== 'idle' && (
                <div className={`flex items-center gap-3 px-4 py-2 border ${rtcState === 'connected' ? 'border-green-500/30' : rtcState === 'connecting' ? 'border-yellow-500/30' : 'border-red-500/30'}`}
                  style={{ background: rtcState === 'connected' ? 'rgba(34,197,94,0.05)' : rtcState === 'connecting' ? 'rgba(234,179,8,0.05)' : 'rgba(239,68,68,0.05)' }}>
                  <div className={`w-2 h-2 rounded-full animate-pulse ${rtcState === 'connected' ? 'bg-green-400' : rtcState === 'connecting' ? 'bg-yellow-400' : 'bg-red-400'}`} />
                  <span className="text-[10px] uppercase tracking-widest text-steppe-muted">
                    {rtcState === 'connected' ? `P2P Bagli - ${targetId}` : rtcState === 'connecting' ? 'Baglaniyor...' : 'Baglaniti Kesildi'}
                  </span>
                  {rtcState === 'connected' && <button onClick={handleDisconnect} className="ml-auto text-[9px] text-red-400 hover:text-red-300 uppercase tracking-widest">Kes</button>}
                </div>
              )}

              <div
                ref={videoContainerRef}
                className="relative aspect-video gokturk-border overflow-hidden flex items-center justify-center focus:outline-none"
                style={{ background: 'rgba(0,0,0,0.45)', cursor: inputEnabled && remoteStream ? 'none' : 'default' }}
                tabIndex={remoteStream ? 0 : -1}
                onMouseMove={handleVideoMouseMove}
                onMouseDown={handleVideoMouseDown}
                onMouseUp={handleVideoMouseUp}
                onWheel={handleVideoWheel}
                onKeyDown={handleVideoKeyDown}
                onKeyUp={handleVideoKeyUp}
                onContextMenu={e => { if (inputEnabled && remoteStream) e.preventDefault(); }}
              >
                <div className="absolute inset-0 opacity-5 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle, var(--accent-primary) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
                {remoteStream ? (
                  <div className="absolute inset-0">
                    <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-contain bg-black" />
                    <div className="absolute top-3 left-3 flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(0,0,0,0.7)' }}>
                      <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                      <span className="text-[9px] text-green-400 uppercase tracking-widest">Bagli - {targetId}</span>
                    </div>
                    <div className="absolute top-3 right-3 flex gap-2">
                      <button
                        onClick={() => setInputEnabled(v => !v)}
                        className="px-2 py-1 text-[9px] uppercase tracking-widest rounded transition-colors"
                        style={{ background: inputEnabled ? 'var(--accent-primary)' : 'rgba(0,0,0,0.7)', color: inputEnabled ? '#000' : 'var(--text-muted)' }}
                        title="Klavye/fare kontrolünü aç-kapat"
                      >{inputEnabled ? 'Kontrol: AÇIK' : 'Kontrol'}</button>
                      <button onClick={() => videoContainerRef.current?.requestFullscreen()} className="px-2 py-1 text-[9px] uppercase tracking-widest text-steppe-muted hover:text-steppe-gold rounded" style={{ background: 'rgba(0,0,0,0.7)' }}>Tam Ekran</button>
                      <button onClick={handleDisconnect} className="px-2 py-1 text-[9px] uppercase tracking-widest text-white rounded bg-red-500/80 hover:bg-red-500">Kes</button>
                    </div>
                    {inputEnabled && (
                      <div className="absolute bottom-3 left-3 flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(0,0,0,0.7)' }}>
                        <div className="w-2 h-2 rounded-full bg-steppe-gold animate-pulse" />
                        <span className="text-[9px] text-steppe-gold uppercase tracking-widest">Kontrol Aktif</span>
                      </div>
                    )}
                  </div>
                ) : isConnecting && rtcState !== 'idle' ? (
                  <div className="absolute inset-0">
                    <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-contain bg-black" />
                    <div className="absolute top-3 left-3 flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(0,0,0,0.7)' }}>
                      <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                      <span className="text-[9px] text-yellow-400 uppercase tracking-widest">Ekran Paylasiliyor - Baglaniliyor...</span>
                    </div>
                    <button onClick={handleCancelConnect} className="absolute top-3 right-3 px-2 py-1 text-[9px] uppercase tracking-widest text-white rounded bg-red-500/80">Iptal</button>
                  </div>
                ) : (
                  <div className="text-center z-10 p-12">
                    <motion.div animate={{ scale: [1,1.04,1] }} transition={{ duration: 4, repeat: Infinity }} className="mb-6 inline-block p-6 rounded-full border border-steppe-border" style={{ background: 'var(--border-primary)' }}>
                      <Monitor size={44} className="text-steppe-gold opacity-50" />
                    </motion.div>
                    <h3 className="text-base text-steppe-gold opacity-60 mb-2">Baglaniti Bekleniyor</h3>
                    <p className="text-[11px] text-steppe-muted max-w-xs mx-auto leading-relaxed">Uzak masaustune baglanmak icin sol panelden hedef kimligi girin.</p>
                  </div>
                )}
                {['top-3 left-3 border-t-2 border-l-2','top-3 right-3 border-t-2 border-r-2','bottom-3 left-3 border-b-2 border-l-2','bottom-3 right-3 border-b-2 border-r-2'].map((c,i) => (
                  <div key={i} className={`absolute w-4 h-4 ${c}`} style={{ borderColor: 'var(--border-strong)' }} />
                ))}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="surface-card border border-steppe-border p-5">
                  <h3 className="text-[10px] uppercase tracking-widest text-steppe-muted mb-4 flex items-center gap-2"><Terminal size={12} className="text-steppe-gold" /> Sistem Gunlugu</h3>
                  <div className="font-mono text-[10px] space-y-2 h-36 overflow-y-auto flex flex-col-reverse" style={{ background: 'var(--log-bg)', padding: '0.75rem' }}>
                    {logs.length > 0 ? logs.map((log, i) => (
                      <div key={i} className={log.type === 'error' ? 'text-red-400' : log.type === 'warn' ? 'text-yellow-400' : log.type === 'sys' ? 'text-green-400' : 'text-steppe-muted'}>
                        <span className="opacity-40 mr-2">[{log.time}]</span>{log.msg}
                      </div>
                    )) : <div className="text-steppe-muted opacity-30">Gunluk kaydi bulunamadi...</div>}
                  </div>
                </div>
                <div className="surface-card border border-steppe-border p-5">
                  <h3 className="text-[10px] uppercase tracking-widest text-steppe-muted mb-4 flex items-center gap-2"><Lock size={12} className="text-steppe-gold" /> Guvenlik Altyapisi</h3>
                  <div className="space-y-3">
                    <SecurityFeature title="P2P Dogrudan Baglaniti" desc="Verileriniz merkezi sunucularimiza ugramaz." />
                    <SecurityFeature title="WebRTC DTLS/SRTP" desc="Tum baglantilar uctan uca sifrelenir." />
                    <SecurityFeature title="Acik Kaynak Kod" desc="Topluluk tarafindan denetlenebilir." />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'connections' && (
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl text-steppe-gold flex items-center gap-3"><Monitor size={20} /> Baglaniti Gecmisi</h2>
              <div className="flex gap-2">
                {(['all','active','timeout'] as const).map(f => (
                  <button key={f} onClick={() => setConnFilter(f)} className={`text-[9px] uppercase tracking-widest px-3 py-1 border transition-all ${connFilter === f ? 'border-steppe-gold text-steppe-gold' : 'border-steppe-border text-steppe-muted hover:border-steppe-gold'}`}>
                    {f === 'all' ? 'Tumu' : f === 'active' ? 'Aktif' : 'Zaman Asimi'}
                  </button>
                ))}
              </div>
            </div>
            <div className="gokturk-border surface-card p-8">
              {!currentUser && !isGuest ? (
                <div className="text-center py-16"><Monitor size={32} className="text-steppe-muted mx-auto mb-4 opacity-30" /><p className="text-[11px] text-steppe-muted mb-4">Baglaniti gecmisini gormek icin giris yapin.</p><button onClick={() => setShowAuth(true)} className="btn-ghost px-6 py-2">Giris Yap</button></div>
              ) : isGuest ? (
                <div className="text-center py-16"><Monitor size={32} className="text-steppe-muted mx-auto mb-4 opacity-30" /><p className="text-[11px] text-steppe-muted mb-4">Misafir modunda gecmis kaydedilmez.</p><button onClick={() => { setShowAuth(true); setAuthMode('register'); }} className="btn-ghost px-6 py-2">Hesap Olustur</button></div>
              ) : connectionHistory.filter(c => connFilter === 'all' || c.status === connFilter).length > 0 ? (
                <div className="space-y-3">
                  {connectionHistory.filter(c => connFilter === 'all' || c.status === connFilter).map(conn => (
                    <div key={conn.id} className="flex justify-between items-center p-4 border border-steppe-border hover:border-steppe-gold transition-colors">
                      <div className="flex items-center gap-4">
                        <div className="p-2" style={{ background: 'var(--border-primary)' }}><Monitor size={14} className="text-steppe-gold" /></div>
                        <div><p className="text-sm text-steppe-gold">{conn.receiver_id}</p><p className="text-[10px] text-steppe-muted">{new Date(conn.created_at).toLocaleString('tr-TR')}</p></div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-[9px] uppercase tracking-widest px-2 py-1 ${conn.status === 'active' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{conn.status === 'active' ? 'Aktif' : 'Zaman Asimi'}</span>
                        <button onClick={() => { setTargetId(conn.receiver_id); setActiveTab('dashboard'); }} className="btn-ghost text-[9px] py-1 px-3">Tekrar Baglan</button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : <div className="text-center py-16 text-steppe-muted italic text-sm">{connFilter === 'all' ? 'Henuz baglaniti kaydi bulunmuyor.' : 'Bu filtrede kayit yok.'}</div>}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="max-w-2xl mx-auto space-y-6">
            <h2 className="text-xl text-steppe-gold flex items-center gap-3"><Settings size={20} /> Uygulama Ayarlari</h2>
            <section className="gokturk-border surface-card p-8">
              <h3 className="text-[10px] uppercase tracking-widest text-steppe-muted mb-6 flex items-center gap-2"><Sun size={12} className="text-steppe-gold" /> Gorunum Temasi</h3>
              <div className="grid grid-cols-4 gap-3">{THEMES.map(t => <ThemeButton key={t.id} active={theme === t.id} onClick={() => updateTheme(t.id)} label={t.label} color={t.color} isLight={!!t.light} />)}</div>
            </section>
            <section className="gokturk-border surface-card p-8">
              <h3 className="text-[10px] uppercase tracking-widest text-steppe-muted mb-6 flex items-center gap-2"><User size={12} className="text-steppe-gold" /> Profil Bilgileri</h3>
              {currentUser ? (
                <div className="space-y-4">
                  <div className="p-3 border border-steppe-border text-[10px] text-steppe-muted" style={{ background: 'var(--surface-primary)' }}><span className="text-steppe-gold">E-posta:</span> {currentUser.email}</div>
                  <input type="text" placeholder="AD SOYAD" className="input-field" value={displayName} onChange={e => setDisplayName(e.target.value)} />
                  <input type="tel" placeholder="TELEFON" className="input-field" value={phone} onChange={e => setPhone(e.target.value)} />
                  {profileUpdateDone && <div className="p-3 border border-green-500/30 text-center" style={{ background: 'rgba(34,197,94,0.05)' }}><CheckCircle size={14} className="text-green-400 mx-auto mb-1" /><p className="text-[10px] text-green-400">Profil guncellendi!</p></div>}
                  <button onClick={handleUpdateProfile} className="btn-primary">Profili Guncelle</button>
                </div>
              ) : <div className="text-center py-6"><p className="text-[10px] text-steppe-muted mb-4">Profil bilgilerini gormek icin giris yapin.</p><button onClick={() => setShowAuth(true)} className="btn-ghost px-6 py-2">Giris Yap</button></div>}
            </section>
            <section className="gokturk-border surface-card p-8">
              <h3 className="text-[10px] uppercase tracking-widest text-steppe-muted mb-6 flex items-center gap-2"><Shield size={12} className="text-steppe-gold" /> Hesap Guvenligi</h3>
              <div className="space-y-4">
                <button onClick={() => { setShowChangePassword(!showChangePassword); setPasswordChangeError(''); setPasswordChangeDone(false); }} className="w-full py-3 border border-steppe-border text-steppe-gold text-[10px] uppercase tracking-widest hover:border-steppe-gold transition-all">{showChangePassword ? 'Iptal' : 'Sifreyi Degistir'}</button>
                {showChangePassword && (
                  <div className="space-y-3 pt-2">
                    <input type="password" placeholder="MEVCUT SIFRE" className="input-field" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
                    <input type="password" placeholder="YENI SIFRE" className="input-field" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                    <input type="password" placeholder="YENI SIFRE (TEKRAR)" className="input-field" value={newPasswordConfirm} onChange={e => setNewPasswordConfirm(e.target.value)} />
                    {passwordChangeError && <p className="text-[10px] text-red-400">{passwordChangeError}</p>}
                    {passwordChangeDone && <div className="p-3 border border-green-500/30 text-center" style={{ background: 'rgba(34,197,94,0.05)' }}><CheckCircle size={16} className="text-green-400 mx-auto mb-1" /><p className="text-[10px] text-green-400">Sifreniz guncellendi!</p></div>}
                    {!passwordChangeDone && <button onClick={handleChangePassword} className="btn-primary">Sifreyi Guncelle</button>}
                  </div>
                )}
              </div>
            </section>
            <section className="gokturk-border surface-card p-8">
              <h3 className="text-[10px] uppercase tracking-widest text-steppe-muted mb-6 flex items-center gap-2"><Monitor size={12} className="text-steppe-gold" /> Ekran Yakalama</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-steppe-paper">Kare Hizi (FPS)</p>
                    <p className="text-[9px] text-steppe-muted mt-0.5">Daha yuksek FPS daha iyi akicilik, daha fazla bant genisligi kullanir.</p>
                  </div>
                  <select
                    value={captureFrameRate}
                    onChange={e => setCaptureFrameRate(Number(e.target.value))}
                    className="input-field py-1 w-28 text-center"
                    style={{ background: 'var(--surface-primary)' }}
                  >
                    {[5, 10, 15, 24, 30].map(fps => (
                      <option key={fps} value={fps}>{fps} FPS</option>
                    ))}
                  </select>
                </div>
              </div>
            </section>
            <section className="gokturk-border surface-card p-8">
              <h3 className="text-[10px] uppercase tracking-widest text-steppe-muted mb-6 flex items-center gap-2"><QrCode size={12} className="text-steppe-gold" /> QRtim Entegrasyonu</h3>
              <div className="flex items-center justify-between p-4 border border-steppe-border mb-4" style={{ background: 'var(--surface-primary)' }}>
                <div className="flex items-center gap-3"><div className="w-2 h-2 rounded-full bg-yellow-400" /><div><p className="text-[11px] text-steppe-paper">QRtim Hesabi</p><p className="text-[9px] text-steppe-muted">Henuz baglanmadi</p></div></div>
                <span className="text-[9px] uppercase tracking-widest text-yellow-400 border border-yellow-400/30 px-2 py-1">Bagli Degil</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => window.open('https://qartim.com/register','_blank')} className="btn-primary">Hesap Olustur</button>
                <button onClick={() => window.open('https://qartim.com/login','_blank')} className="btn-ghost">Giris Yap</button>
              </div>
            </section>
          </div>
        )}
      </main>

      {/* Gelen Cagri Modali */}
      <AnimatePresence>
        {incomingCall && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="w-full max-w-sm gokturk-border p-8 text-center" style={{ background: 'var(--bg-primary)' }}>
              <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 border-2 border-steppe-gold animate-pulse" style={{ background: 'var(--border-primary)' }}>
                <Monitor size={28} className="text-steppe-gold" />
              </div>
              <h2 className="text-lg text-steppe-gold mb-2">Gelen Baglaniti Istegi</h2>
              <p className="text-[10px] text-steppe-muted mb-3">Asagidaki kimlik ekraniniza erismek istiyor:</p>
              <div className="px-4 py-3 border border-steppe-border mb-4 font-mono" style={{ background: 'var(--log-bg)' }}>
                <span className="text-steppe-gold text-base">{incomingCall.fromId.slice(0,8)}...</span>
              </div>
              <p className="text-[10px] text-steppe-muted mb-6 leading-relaxed">Kabul edersen ekraninizi secmeniz istenecek ve karsi tarafa paylasilacak.</p>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={handleRejectCall} className="py-3 border border-red-500/30 text-red-400 text-[10px] uppercase tracking-widest hover:bg-red-500/10 transition-all">Reddet</button>
                <button onClick={handleAcceptCall} className="btn-primary">Kabul Et</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Auth Modali */}
      <AnimatePresence>
        {showAuth && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/75 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }} className="w-full max-w-md gokturk-border p-8 relative" style={{ background: 'var(--bg-primary)' }}>
              <button onClick={() => { setShowAuth(false); setAuthError(''); setResetSent(false); }} className="absolute top-4 right-4 text-steppe-muted hover:text-steppe-gold transition-colors text-xs">[X]</button>
              {authMode === 'login' && (
                <><h2 className="text-lg text-steppe-gold mb-6">Giris Yap</h2>
                <div className="space-y-4">
                  <input type="email" placeholder="E-POSTA" className="input-field" value={email} onChange={e => setEmail(e.target.value)} />
                  <input type="password" placeholder="SIFRE" className="input-field" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleLogin(); }} />
                  {authError && <p className="text-[10px] text-red-400">{authError}</p>}
                  <button onClick={handleLogin} className="btn-primary">Devam Et</button>
                  <button onClick={() => { setAuthMode('reset'); setAuthError(''); setResetSent(false); setResetEmail(''); }} className="w-full text-[10px] text-steppe-muted hover:text-steppe-gold transition-colors text-center">Sifremi Unuttum</button>
                  <button onClick={handleGuestLogin} className="w-full flex items-center justify-center gap-2 p-3 border border-steppe-border hover:border-steppe-gold transition-all" style={{ background: 'var(--surface-primary)' }}>
                    <User size={14} className="text-steppe-muted" /><span className="text-[10px] uppercase tracking-widest text-steppe-muted">Hesap Acmadan Devam Et</span>
                  </button>
                  <p className="text-[10px] text-center text-steppe-muted">Hesabiniz yok mu?{' '}<button onClick={() => { setAuthMode('register'); setAuthError(''); }} className="text-steppe-gold underline underline-offset-2">Kayit Ol</button></p>
                </div></>
              )}
              {authMode === 'register' && (
                <><h2 className="text-lg text-steppe-gold mb-6">Hesap Olustur</h2>
                <div className="space-y-4">
                  <input type="text" placeholder="AD SOYAD" className="input-field" value={displayName} onChange={e => setDisplayName(e.target.value)} />
                  <input type="email" placeholder="E-POSTA" className="input-field" value={email} onChange={e => setEmail(e.target.value)} />
                  <input type="tel" placeholder="TELEFON (Istege bagli)" className="input-field" value={phone} onChange={e => setPhone(e.target.value)} />
                  <input type="password" placeholder="SIFRE (min. 6 karakter)" className="input-field" value={password} onChange={e => setPassword(e.target.value)} />
                  {authError && <p className="text-[10px] text-red-400">{authError}</p>}
                  <button onClick={handleRegister} className="btn-primary">Kayit Ol</button>
                  <p className="text-[10px] text-center text-steppe-muted">Zaten hesabiniz var mi?{' '}<button onClick={() => { setAuthMode('login'); setAuthError(''); }} className="text-steppe-gold underline underline-offset-2">Giris Yap</button></p>
                </div></>
              )}
              {authMode === 'mfa' && (
                <><h2 className="text-lg text-steppe-gold mb-2">MFA Dogrulama</h2>
                <div className="space-y-6">
                  <div className="flex justify-between gap-2">
                    {mfaCode.map((d, i) => (
                      <input key={i} type="text" maxLength={1} ref={(el: HTMLInputElement | null) => { mfaRefs.current[i] = el; }} className="w-full aspect-square text-center text-xl text-steppe-gold focus:outline-none" style={{ background: 'var(--log-bg)', border: '1px solid var(--border-primary)' }} value={d}
                        onChange={e => { const nc = [...mfaCode]; nc[i] = e.target.value; setMfaCode(nc); if (e.target.value && i < 5) mfaRefs.current[i+1]?.focus(); }}
                        onKeyDown={e => { if (e.key === 'Backspace' && !mfaCode[i] && i > 0) mfaRefs.current[i-1]?.focus(); }} />
                    ))}
                  </div>
                  {authError && <p className="text-[10px] text-red-400">{authError}</p>}
                  <button onClick={validateMfa} disabled={isMfaValidating} className="btn-primary disabled:opacity-50">{isMfaValidating ? 'Dogrulanıyor...' : 'Dogrula'}</button>
                </div></>
              )}
              {authMode === 'reset' && (
                <><h2 className="text-lg text-steppe-gold mb-2">Sifre Sifirla</h2>
                <div className="space-y-4">
                  {!resetSent ? (
                    <><input type="email" placeholder="E-POSTA ADRESINIZ" className="input-field" value={resetEmail} onChange={e => setResetEmail(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handlePasswordReset(); }} />
                    {authError && <p className="text-[10px] text-red-400">{authError}</p>}
                    <button onClick={handlePasswordReset} className="btn-primary">Sifirlama Baglantisi Gonder</button></>
                  ) : (
                    <div className="text-center py-6">
                      <CheckCircle size={28} className="text-green-400 mx-auto mb-3" />
                      <p className="text-[12px] text-green-400 mb-2">E-posta gonderildi!</p>
                      <p className="text-[10px] text-steppe-muted"><span className="text-steppe-gold">{resetEmail}</span> adresini kontrol edin.</p>
                    </div>
                  )}
                  <button onClick={() => { setAuthMode('login'); setAuthError(''); setResetSent(false); setResetEmail(''); }} className="w-full text-[10px] text-steppe-muted hover:text-steppe-gold transition-colors text-center">Giris ekranina don</button>
                </div></>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showDonation && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/75 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.93 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.93 }} className="w-full max-w-md gokturk-border p-8 relative" style={{ background: 'var(--bg-primary)' }}>
              <button onClick={() => setShowDonation(false)} className="absolute top-4 right-4 text-steppe-muted hover:text-steppe-gold transition-colors text-xs">[X]</button>
              <Heart size={20} className="text-steppe-gold mb-4" />
              <h2 className="text-lg text-steppe-gold mb-2">Bozkira Destek Ol</h2>
              <p className="text-[11px] text-steppe-muted mb-8">Arku Remote tamamen ucretsizdir.</p>
              <div className="space-y-3 mb-8">
                {[{amount:'50 TL',label:'Kimiz Ismarla'},{amount:'250 TL',label:'At Kostur'},{amount:'1000 TL',label:'Otag Kur'},{amount:'Dilediginiz kadar',label:'Kendi Miktarinizi Belirleyin'}].map(opt => (
                  <div key={opt.amount} className="flex justify-between items-center p-4 border border-steppe-border hover:border-steppe-gold cursor-pointer" style={{ background: 'var(--surface-primary)' }}>
                    <span className="text-[11px] text-steppe-muted">{opt.label}</span><span className="text-steppe-gold font-display text-sm">{opt.amount}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => setShowDonation(false)} className="btn-primary">Odeme Sayfasina Git</button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <footer className="border-t border-steppe-border py-6 text-center" style={{ background: isLight ? 'rgba(240,244,248,0.8)' : 'rgba(0,0,0,0.2)' }}>
        <p className="text-[9px] text-steppe-muted tracking-[0.3em] uppercase">2026 Arku Remote - ITrend Technology</p>
      </footer>
    </div>
  );
}

function ThemeButton({ active, onClick, label, color, isLight }: { key?: React.Key; active: boolean; onClick: () => void | Promise<void>; label: string; color: string; isLight?: boolean }) {
  return (
    <button onClick={onClick} className={`p-3 border transition-all flex flex-col items-center gap-2 group ${active ? 'border-steppe-border' : 'border-transparent hover:border-steppe-border'}`} style={{ background: active ? 'var(--border-primary)' : 'transparent' }}>
      <div className="w-7 h-7 rounded-full border-2 border-white/20" style={{ background: color }} />
      <span className={`text-[9px] uppercase tracking-widest transition-colors ${active ? 'text-steppe-gold' : 'text-steppe-muted group-hover:text-steppe-paper'}`}>{label}</span>
      {isLight && <Sun size={10} className="text-steppe-muted" />}
    </button>
  );
}
function StatCard({ icon, title, value, sub }: { icon: React.ReactNode; title: string; value: string; sub: string }) {
  return <div className="p-5 surface-card border border-steppe-border group"><div className="text-steppe-gold opacity-50 mb-3 group-hover:opacity-100 transition-opacity">{icon}</div><div className="text-[9px] uppercase tracking-widest text-steppe-muted mb-1">{title}</div><div className="text-lg font-display text-steppe-gold">{value}</div><div className="text-[9px] text-steppe-muted uppercase tracking-tight">{sub}</div></div>;
}
function SecurityFeature({ title, desc }: { title: string; desc: string }) {
  return <div className="flex gap-3"><div className="mt-1.5 w-1 h-1 rounded-full shrink-0" style={{ background: 'var(--accent-primary)' }} /><div><h4 className="text-[10px] text-steppe-gold mb-1">{title}</h4><p className="text-[10px] text-steppe-muted leading-relaxed">{desc}</p></div></div>;
}
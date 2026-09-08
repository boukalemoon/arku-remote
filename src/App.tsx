import React from 'react';
import { Shield, Lock, Zap, Heart, Monitor, Settings, User, Terminal, Globe, LogOut, Sun, ExternalLink, Copy, CheckCircle, QrCode, ArrowRight, Building2, Users, Plus, Trash2, Tag, Bookmark } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { supabase, ARKU_ANON_KEY, fetchEntitlements, FREE_ENTITLEMENTS, planCapabilities } from './lib/supabase';
import type { UserProfile, LogType, ConnectionEntry, Entitlements } from './lib/supabase';
import {
  listMyOrganizations, createOrganization, updateOrganization, deleteOrganization,
  listOrgMembers, addOrgMember, updateOrgMember, removeOrgMember,
  listCategories, createCategory, deleteCategory,
  listSavedContacts, createSavedContact, deleteSavedContact, touchSavedContact,
  fetchPresence, sendHeartbeat, bindOrgInvites,
} from './lib/enterprise';
import type { Organization, OrgMember, ContactCategory, SavedContact, OrgRole, PresenceRow } from './lib/enterprise';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { WebRTCManager } from './lib/webrtc';
import type { ConnectionState, InputEventMsg, RtcQuality, ControlMsg, RemoteScreen } from './lib/webrtc';
import { EMBED, postSessionEvent, resetSessionEvents } from './lib/embed';
import { resetIceCache } from './lib/ice';

type Theme = 'otuken' | 'umay' | 'gok' | 'gece';
type Tab = 'dashboard' | 'connections' | 'contacts' | 'organization' | 'settings';
type AuthMode = 'login' | 'register' | 'mfa' | 'reset';
interface LogEntryLocal { time: string; msg: string; type: LogType; }
// toId: arayanın bize ulaşmak için kullandığı kimlik (UUID veya 123-456-789).
// Cevabı bu kimlikle imzalamamız gerekir, yoksa arayan yanıtı tanıyamaz.
interface IncomingCall { fromId: string; toId?: string; offerPayload: Record<string, unknown>; sessionId?: string; signalId?: string; }
interface QrtimUser { qrtim_id: string; email: string; name: string; username: string; photo_url: string | null; title: string | null; company: string | null; plan: string; }

const QRTIM_BASE_URL = import.meta.env.VITE_QRTIM_URL ?? 'https://qartim.com';
// QRtım entegrasyonu artık Arku edge fonksiyonları üzerinden yürür:
//   qrtim-auth  -> SSO ile giriş, qrtim-sync -> hesap bağlama + abonelik senkronu.
// Bu fonksiyonlar QRtım'in arku-link'ini server-to-server kendileri çağırır;
// client'ın QRtım anon key'ini tutmasına gerek kalmadı.
const QRTIM_AUTH_URL = 'https://jpmbttlxyxrqmpghymbq.supabase.co/functions/v1/qrtim-auth';
const QRTIM_SYNC_URL = 'https://jpmbttlxyxrqmpghymbq.supabase.co/functions/v1/qrtim-sync';

const generateDeviceFingerprint = (): string => {
  const nav = window.navigator;
  const raw = [nav.userAgent, nav.language, screen.width + 'x' + screen.height, screen.colorDepth, new Date().getTimezoneOffset(), nav.hardwareConcurrency || 0].join('|');
  return Math.abs(raw.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)).toString(36).toUpperCase();
};
const generateSessionToken = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * Oturum parolası alfabesi — telefonda okunacak bir değer olduğu için
 * karıştırılabilen karakterler (0/O, 1/I/L) çıkarılmıştır.
 * 32 karakter, 256 % 32 === 0 olduğu için modulo sapması yok.
 */
const PW_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Her oturum için yeni üretilen 6 karakterlik parola (~1,07 milyar olasılık).
 *
 * NEDEN: Eskiden kimliği bilen HERKES karşı tarafı çaldırabiliyordu ve
 * kimlikler 9 haneli olduğu için taranabilirdi. Parola, "kimliği bilmek"
 * ile "bağlanma yetkisi" arasındaki farkı kurar — TeamViewer'ın temel
 * güvenlik modeli budur.
 */
const generateSessionPassword = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(b => PW_ALPHABET[b % PW_ALPHABET.length]).join('');
const formatId = (raw: string): string => { const c = raw.replace(/\D/g, '').padStart(9, '0').slice(0, 9); return `${c.slice(0,3)}-${c.slice(3,6)}-${c.slice(6,9)}`; };
/**
 * ESKİ kimlik üretimi — yalnızca yedek yol olarak duruyor.
 *
 * 32-bit djb2 hash, sonra 9 haneye KIRPMA ("2147483647" -> "214748364").
 * Doğum günü sınırı ~33.000 kullanıcıda %50. users.connection_id unique
 * olduğu için çakışma yanlış kişiye bağlanmaya yol açmaz; onun yerine
 * upsert sessizce başarısız olur ve kullanıcı ULAŞILAMAZ hâle gelir.
 * arku_ensure_connection_id RPC'si uygulandıktan sonra bu yol kullanılmaz.
 */
const generateProfileId = (uid: string): string => formatId(Math.abs(uid.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)).toString());

/**
 * Kimliği sunucudan ister (benzersizliği veritabanı garanti eder).
 * Migration henüz uygulanmamışsa eski istemci üretimine düşer, böylece
 * migration ile uygulama sürümünün yayın sırası önemsizdir.
 */
const resolveMyConnectionId = async (uid: string): Promise<{ id: string; fromServer: boolean }> => {
  try {
    const { data, error } = await supabase.rpc('arku_ensure_connection_id');
    if (!error && typeof data === 'string' && data.trim()) return { id: data.trim(), fromServer: true };
  } catch { /* fonksiyon yok / ağ hatası — yedek yola düş */ }
  return { id: generateProfileId(uid), fromServer: false };
};
/**
 * Oturumsuz misafir kimliği.
 *
 * Eskiden cihaz PARMAK İZİNDEN türetiliyordu (userAgent + dil + çözünürlük +
 * timezone + çekirdek sayısı). Aynı imajla kurulmuş kurumsal bir filoda tüm
 * makineler aynı parmak izini üretir, dolayısıyla AYNI misafir kimliğini
 * alırdı — çağrılar yanlış makinede çalardı. Artık rastgele.
 */
const getOrCreateGuestId = (): string => {
  const k = 'arku_guest_id';
  let id = localStorage.getItem(k);
  if (!id) {
    const n = (crypto.getRandomValues(new Uint32Array(1))[0] % 900000000) + 100000000;
    id = formatId(String(n));
    localStorage.setItem(k, id);
  }
  return id;
};

const THEMES: { id: Theme; label: string; color: string; light?: boolean }[] = [
  { id: 'otuken', label: 'Otüken', color: '#c5a059' },
  { id: 'umay',   label: 'Umay',   color: '#2e6fbf', light: true },
  { id: 'gok',    label: 'Gok',    color: '#64ffda' },
  { id: 'gece',   label: 'Gece',   color: '#ff0080' },
];

export default function App() {
  const [currentUser, setCurrentUser] = React.useState<SupabaseUser | null>(null);
  const [userProfile, setUserProfile] = React.useState<UserProfile | null>(null);
  // Kullanıcının AÇIK tercihi ("Misafir olarak devam et"). Anonim Supabase
  // oturumunun varlığıyla KARIŞTIRILMAMALI: o oturum yalnızca ulaşılabilirlik
  // içindir (RLS her istemciden bir kimlik ister) ve kullanıcı onayı sayılmaz.
  const [isGuest, setIsGuest] = React.useState(() => {
    try { return localStorage.getItem('arku_guest_choice') === '1'; } catch { return false; }
  });
  const setGuestChoice = (v: boolean) => {
    setIsGuest(v);
    try { if (v) localStorage.setItem('arku_guest_choice', '1'); else localStorage.removeItem('arku_guest_choice'); } catch { /* yok say */ }
  };
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
  // Arayanin girdigi oturum parolasi (karsi tarafin ekraninda yazan).
  const [targetPassword, setTargetPassword] = React.useState('');
  // Bu cihazin gecerli oturum parolasi. Her oturum bitiminde yenilenir.
  const [sessionPassword, setSessionPassword] = React.useState(() => generateSessionPassword());
  const [requirePassword, setRequirePassword] = React.useState(() => {
    try { return localStorage.getItem('arku_require_password') !== '0'; } catch { return true; }
  });
  // processIncomingOffer, bagimliliklari dar olan bir effect icinden cagriliyor;
  // parola durumunu ref uzerinden okumak bayat closure'i onler.
  const sessionPasswordRef = React.useRef(sessionPassword);
  const requirePasswordRef = React.useRef(requirePassword);
  // Kaba kuvvet frenleme: from_id basina yanlis deneme sayisi.
  const badPasswordTriesRef = React.useRef(new Map<string, number>());
  const [connectionHistory, setConnectionHistory] = React.useState<ConnectionEntry[]>([]);
  const [copied, setCopied] = React.useState(false);
  const [sessionToken, setSessionToken] = React.useState('');
  const [deviceFingerprint, setDeviceFingerprint] = React.useState('');
  const [webrtc, setWebrtc] = React.useState<WebRTCManager | null>(null);
  const [rtcState, setRtcState] = React.useState<ConnectionState>('idle');
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [remoteStream, setRemoteStream] = React.useState<MediaStream | null>(null);
  // Canlı bağlantı kalitesi (yol, gecikme, bit hızı, kayıp). Destek ekibinin
  // "yavaş/bulanık" şikayetlerini teşhis edebilmesi için görünür kılınır.
  const [quality, setQuality] = React.useState<RtcQuality | null>(null);
  // Bu oturumda TURN (relay) kullanılabiliyor mu — yoksa kısıtlı ağlarda
  // bağlantı hiç kurulamaz ve kullanıcı sebebini bilmelidir.
  const [turnAvailable, setTurnAvailable] = React.useState(true);
  const [incomingCall, setIncomingCall] = React.useState<IncomingCall | null>(null);
  const connTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const rtcStateRef = React.useRef<ConnectionState>('idle');
  const remoteVideoRef = React.useRef<HTMLVideoElement>(null);
  const localVideoRef = React.useRef<HTMLVideoElement>(null);
  const videoContainerRef = React.useRef<HTMLDivElement>(null);
  const [logs, setLogs] = React.useState<LogEntryLocal[]>([]);
  const [inputEnabled, setInputEnabled] = React.useState(false);
  // Ekranı paylaşan tarafın (alıcı) açık onayı olmadan uzaktan gelen
  // klavye/fare komutları işletilmez. Her oturumda kapalı başlar.
  const [remoteControlAllowed, setRemoteControlAllowed] = React.useState(false);
  const remoteControlAllowedRef = React.useRef(false);
  const [captureFrameRate, setCaptureFrameRate] = React.useState(15);
  // Elle güncelleme kontrolü (yalnızca masaüstü uygulamasında anlamlı)
  const [updateCheck, setUpdateCheck] = React.useState<{ status: string; version?: string; message?: string } | null>(null);
  const [updateChecking, setUpdateChecking] = React.useState(false);
  const [qrtimUser, setQrtimUser] = React.useState<QrtimUser | null>(null);
  const [qrtimLinking, setQrtimLinking] = React.useState(false);
  const [entitlements, setEntitlements] = React.useState<Entitlements>(FREE_ENTITLEMENTS);
  // Kurumsal + kayıtlı müşteri durumu
  const [savedContacts, setSavedContacts] = React.useState<SavedContact[]>([]);
  const [categories, setCategories] = React.useState<ContactCategory[]>([]);
  const [organizations, setOrganizations] = React.useState<Organization[]>([]);
  const [activeOrgId, setActiveOrgId] = React.useState<string | null>(null);
  const [orgMembers, setOrgMembers] = React.useState<OrgMember[]>([]);
  // Kayitli musterilerin cevrimici durumu (kimlik -> durum).
  const [presence, setPresence] = React.useState<Map<string, PresenceRow>>(new Map());
  const caps = planCapabilities(entitlements.plan);
  const lastMouseMoveRef = React.useRef(0);
  // Şu an basılı tuttuğumuz tuşlar (KeyboardEvent.code). Odak kaybedilirse
  // keyup asla gelmez; bunları uzak tarafta bırakmak için izliyoruz.
  const heldKeysRef = React.useRef(new Set<string>());
  // Girdi enjeksiyonunun uzak makinede gerçekten çalışıp çalışmadığı.
  const [controlNotice, setControlNotice] = React.useState<string>('');
  // Coklu monitor: karsi tarafin ekran listesi ve su an paylasilan ekran.
  const [remoteScreens, setRemoteScreens] = React.useState<RemoteScreen[]>([]);
  const [currentRemoteScreen, setCurrentRemoteScreen] = React.useState('');
  // Polling fallback refs for when Supabase Realtime WebSocket is unavailable
  const incomingPollSinceRef = React.useRef(new Date().toISOString());
  const processedOfferIdsRef = React.useRef(new Set<string>());
  // Ref mirror of webrtc state — used inside useEffect callbacks to avoid stale closures
  const webrtcRef = React.useRef<import('./lib/webrtc').WebRTCManager | null>(null);

  // "Gerçekten giriş yapmış kullanıcı". Arayüz ve yetki kararlarının tamamı bunu
  // kullanmalı; `currentUser` anonim (misafir) oturumda da doludur.
  const isRegistered = !!currentUser && !currentUser.is_anonymous;

  const ts = () => new Date().toLocaleTimeString('tr-TR');
  const addLocalLog = (msg: string, type: LogType = 'info') => setLogs(p => [{ time: ts(), msg, type }, ...p].slice(0, 50));

  const canSendInput = () =>
    inputEnabled && EMBED.mode !== 'view' && !!webrtc && rtcState === 'connected' && !!remoteStream;

  /**
   * Olay, video üstündeki kendi düğmelerimizden mi geliyor?
   * "Kontrol", "Tam Ekran" ve "Kes" düğmeleri kapsayıcının İÇİNDE durduğu için
   * onlara tıklamak uzak tarafa da tıklama gönderiyordu (sağ üst köşeye).
   */
  const isOverlayControl = (e: React.MouseEvent) =>
    !!(e.target as HTMLElement | null)?.closest?.('button');

  /**
   * İmleç konumunu videonun GERÇEK çizim alanına göre normalize eder.
   *
   * Video `object-contain` ile 16:9 bir kutuda duruyor ama uzak ekran 16:10
   * (çoğu dizüstü), 4:3 veya rastgele en-boy oranlı bir pencere olabilir; o
   * zaman siyah bantlar (letterbox) oluşur. Eskiden koordinat KAPSAYICI kutuya
   * göre hesaplanıyordu, dolayısıyla oranlar farklı olduğu her an tüm
   * tıklamalar kayıyordu.
   *
   * Bandın üstüne gelen tıklamalar kenara sıkıştırılmak yerine hiç
   * gönderilmez — orada uzak ekranda karşılığı olan bir nokta yoktur.
   */
  const normalizeToVideo = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const v = remoteVideoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const r = v.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const dw = v.videoWidth * scale;
    const dh = v.videoHeight * scale;
    const x = (clientX - r.left - (r.width - dw) / 2) / dw;
    const y = (clientY - r.top - (r.height - dh) / 2) / dh;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  const handleVideoMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canSendInput()) return;
    if (isOverlayControl(e)) return;
    const now = Date.now();
    if (now - lastMouseMoveRef.current < 33) return; // ~30 fps throttle
    const p = normalizeToVideo(e.clientX, e.clientY);
    if (!p) return;
    lastMouseMoveRef.current = now;
    webrtc!.sendInput({ type: 'mousemove', x: p.x, y: p.y });
  };
  const handleVideoMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canSendInput()) return;
    if (isOverlayControl(e)) return;
    // preventDefault tıklayarak odaklanmayı da iptal eder; klavye
    // yönlendirmesinin çalışması için odağı ELLE veriyoruz. Eskiden odak
    // hangi öğede kaldıysa klavye oraya gidiyordu — çoğu zaman hiçbir yere.
    e.preventDefault();
    videoContainerRef.current?.focus();
    const p = normalizeToVideo(e.clientX, e.clientY);
    if (!p) return;
    webrtc!.sendInput({ type: 'mousedown', button: e.button, x: p.x, y: p.y });
  };
  const handleVideoMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canSendInput()) return;
    if (isOverlayControl(e)) return;
    const p = normalizeToVideo(e.clientX, e.clientY);
    if (!p) return;
    webrtc!.sendInput({ type: 'mouseup', button: e.button, x: p.x, y: p.y });
  };
  const handleVideoWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!canSendInput()) return;
    if (isOverlayControl(e)) return;
    const p = normalizeToVideo(e.clientX, e.clientY);
    if (!p) return;
    webrtc!.sendInput({ type: 'wheel', dx: e.deltaX, dy: e.deltaY, x: p.x, y: p.y });
  };
  const handleVideoKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canSendInput()) return;
    e.preventDefault();
    heldKeysRef.current.add(e.code);
    webrtc!.sendInput({ type: 'keydown', key: e.key, code: e.code });
  };
  const handleVideoKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canSendInput()) return;
    heldKeysRef.current.delete(e.code);
    webrtc!.sendInput({ type: 'keyup', key: e.key, code: e.code });
  };
  const addLog = async (msg: string, type: LogType = 'info') => {
    addLocalLog(msg, type);
    // Misafir (anonim) oturumda geçmiş tutulmaz — kayıt yalnızca yereldedir.
    if (!currentUser || currentUser.is_anonymous) return;
    await supabase.from('logs').insert({ user_id: currentUser.id, msg, type });
  };

  React.useEffect(() => { rtcStateRef.current = rtcState; }, [rtcState]);
  React.useEffect(() => { webrtcRef.current = webrtc; }, [webrtc]);
  React.useEffect(() => { remoteControlAllowedRef.current = remoteControlAllowed; }, [remoteControlAllowed]);
  React.useEffect(() => { sessionPasswordRef.current = sessionPassword; }, [sessionPassword]);
  React.useEffect(() => { requirePasswordRef.current = requirePassword; }, [requirePassword]);
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

  // Kontrol açıldığı anda video alanına odaklan — kullanıcı ayrıca tıklamak
  // zorunda kalmasın. (Tıklama yolu da mousedown içinde ayrıca ele alınıyor.)
  React.useEffect(() => {
    if (inputEnabled && remoteStream) videoContainerRef.current?.focus();
  }, [inputEnabled, remoteStream]);

  // Ekran listesi yalnızca kontrol izni varken verilir; kontrol açılınca iste,
  // kapanınca listeyi düşür (karşı taraf artık cevap vermeyecek).
  React.useEffect(() => {
    if (!remoteStream || rtcState !== 'connected') { setRemoteScreens([]); return; }
    if (!inputEnabled) { setRemoteScreens([]); return; }
    webrtcRef.current?.sendControl({ k: 'screens-req' });
  }, [inputEnabled, remoteStream, rtcState]);

  // Odak/görünürlük kaybında basılı tuşları uzak tarafta bırak.
  // Operatör Alt+Tab yaptığında keyup olayı bu pencereye HİÇ gelmez; bu
  // olmadan uzak makinede Alt (veya Ctrl/Shift) basılı kalıyordu.
  React.useEffect(() => {
    const releaseAll = () => {
      const held = heldKeysRef.current;
      const mgr = webrtcRef.current;
      if (!mgr) { held.clear(); return; }
      for (const code of held) mgr.sendInput({ type: 'keyup', key: '', code });
      held.clear();
      // Uzak taraf ayrıca kendi izlediği her şeyi bıraksın (fare düğmeleri dahil).
      mgr.sendInput({ type: 'release-all' });
    };
    const onVisibility = () => { if (document.hidden) releaseAll(); };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Kontrol kapatıldığında da basılı tuşlar kalmamalı.
  React.useEffect(() => {
    if (inputEnabled) return;
    const held = heldKeysRef.current;
    const mgr = webrtcRef.current;
    if (mgr && held.size > 0) {
      for (const code of held) mgr.sendInput({ type: 'keyup', key: '', code });
      mgr.sendInput({ type: 'release-all' });
    }
    held.clear();
  }, [inputEnabled]);

  // Kendi giden bağlantı denememizi yerel olarak sonlandır (çağrı çakışmasında
  // geri çekilirken kullanılır). Yalnızca ref'lere dokunur, bayat closure riski yok.
  const teardownOutgoing = () => {
    if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
    const m = webrtcRef.current;
    setWebrtc(null); setIsConnecting(false); setRtcState('idle');
    m?.disconnect().catch(() => {});
  };

  /**
   * Gelen bir offer ile ne yapılacağına karar verir:
   *  'ignore' — alıcı rolündeyken karşı taraftan gelen ICE restart offer'ı;
   *             WebRTCManager kendi aboneliğinde işler.
   *  'busy'   — başka bir oturumdayız; arayan 30 sn sessizlik yerine anında
   *             "meşgul" cevabı almalı.
   *  'yield'  — çağrı çakışması: iki taraf da aynı anda aradı. İki taraf da aynı
   *             deterministik kuralı uyguladığı için tam olarak biri geri çekilir.
   *  'show'   — normal gelen çağrı.
   */
  const decideIncomingOffer = (fromId: string): 'ignore' | 'busy' | 'yield' | 'show' => {
    const state = rtcStateRef.current;
    if (state !== 'connected' && state !== 'connecting') return 'show';
    const mgr = webrtcRef.current;
    const isActivePeer = !!mgr?.isPeer(fromId);
    if (isActivePeer && mgr?.getRole() === 'receiver') return 'ignore';
    if (state === 'connecting' && isActivePeer && mgr?.getRole() === 'caller') {
      const myCallId = currentUser?.id || connectionId;
      return myCallId < fromId ? 'ignore' : 'yield';
    }
    return 'busy';
  };

  // Meşgul/red bildirimini, arayanın bizi çağırdığı kimlikle imzala; aksi halde
  // arayan bu sinyali "başkasından" sanıp yok sayar.
  const sendBusySignal = async (toId: string, addressedAs?: string, reason = 'busy') => {
    try {
      await supabase.from('signals').insert({
        from_id: addressedAs || currentUser?.id || connectionId,
        to_id: toId, type: 'hangup', payload: { reason },
      });
    } catch { /* bildirim gönderilemedi — arayan zaman aşımına düşer */ }
  };

  const processIncomingOffer = async (
    sig: { id?: string; from_id: string; to_id?: string; payload: Record<string, unknown>; session_id?: string },
    via = '',
  ) => {
    // Mükerrer işlemeyi tek noktada engelle: aynı offer hem WebSocket hem polling
    // yolundan gelebilir; iki kez işlenirse iki kez "meşgul" sinyali gönderilirdi.
    if (sig.id) {
      if (processedOfferIdsRef.current.has(sig.id)) return;
      if (processedOfferIdsRef.current.size > 200) processedOfferIdsRef.current.clear();
      processedOfferIdsRef.current.add(sig.id);
    }

    const decision = decideIncomingOffer(sig.from_id);
    if (decision === 'ignore') return;

    // Parola kontrolu, cagri ekranda GOSTERILMEDEN ve kendi giden cagrimiz
    // geri cekilmeden ONCE yapilir: yanlis parola ile arayan ne rahatsizlik
    // verebilir ne de cagri cakismasi uydurup bizi geri cekilmeye zorlayabilir.
    // Kimligi bilmek artik tek basina yetmiyor.
    if (requirePasswordRef.current) {
      const given = String((sig.payload as { pw?: unknown } | null)?.pw ?? '').trim().toUpperCase();
      if (given !== sessionPasswordRef.current) {
        const tries = (badPasswordTriesRef.current.get(sig.from_id) ?? 0) + 1;
        badPasswordTriesRef.current.set(sig.from_id, tries);
        addLocalLog(`${sig.from_id} yanlis parola ile baglanmak istedi (${tries}. deneme).`, 'warn');
        // Ilk denemelerde sebebi bildir ki mesru kullanici parolayi duzeltsin;
        // sonrasinda sessizce yut — kaba kuvvet icin geri bildirim vermeyelim.
        if (tries <= 3) await sendBusySignal(sig.from_id, sig.to_id, 'badpass');
        return;
      }
      badPasswordTriesRef.current.delete(sig.from_id);
    }
    if (decision === 'busy') {
      addLocalLog(`${sig.from_id} baglanmak istedi, mesgul oldugunuz bildirildi.`, 'warn');
      await sendBusySignal(sig.from_id, sig.to_id);
      return;
    }
    if (decision === 'yield') {
      addLocalLog('Cagri cakismasi: kendi istegimiz geri cekildi, gelen cagri gosteriliyor.', 'warn');
      teardownOutgoing();
    }
    setIncomingCall({ fromId: sig.from_id, toId: sig.to_id, offerPayload: sig.payload, sessionId: sig.session_id, signalId: sig.id });
    addLocalLog(`${sig.from_id} baglanmak istiyor...${via}`, 'warn');
  };

  React.useEffect(() => {
    const ids = Array.from(new Set([currentUser?.id, connectionId].filter((v): v is string => !!v && v.trim().length > 0)));
    if (ids.length === 0) return;
    const channels = ids.map(rid =>
      supabase.channel(`call-in:${rid}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'signals', filter: `to_id=eq.${rid}` }, (payload) => {
          const sig = payload.new as any;
          if (sig.type === 'offer') {
            processIncomingOffer(sig);
          }
          if (sig.type === 'hangup') {
            // Yalnızca ilgili taraftan gelen hangup'ı işle. Aynı hesapla birden
            // fazla pencere/oturum açıkken, başka bir oturumun hangup'ı bu
            // pencerenin aktif bağlantısını KESMEMELİ (sinyaller to_id=hesapID
            // ile hepsine ulaşır; ayrım from_id ile yapılır).
            setIncomingCall(prev => (prev && prev.fromId === sig.from_id) ? null : prev);
            // Karşı taraf bize hangi kimlikle cevap veriyorsa onu tanı (UUID veya
            // profil kimliği); isPeer bu eş anlamlıların hepsini kapsar.
            if (!webrtcRef.current?.isPeer(sig.from_id)) return;
            const reason = (sig.payload as { reason?: string } | null)?.reason;
            addLocalLog(
              reason === 'busy' ? 'Karsi taraf mesgul, su an baska bir oturumda.'
              : reason === 'rejected' ? 'Baglanti istegi reddedildi.'
              : reason === 'badpass' ? 'Oturum parolasi hatali. Karsi tarafin ekranindaki parolayi kontrol edin.'
              : 'Karsi taraf baglantıyi kesti.',
              'warn',
            );
            // Bekleyen 30 sn zaman aşımını iptal et. Aksi halde reddedilen veya
            // yanlış parolayla düşen bir çağrıdan 30 sn SONRA "yanit vermedi
            // (zaman asimi)" satırı düşüyor ve gerçek sebebin üstünü örtüyordu.
            if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
            // Disconnect the active WebRTCManager (uses ref to avoid stale closure)
            webrtcRef.current?.disconnect().catch(() => {});
            setWebrtc(null);
            setRtcState('idle');
            setRemoteStream(null);
            setQuality(null);
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
      for (const rid of ids) {
        try {
          const { data } = await supabase
            .from('signals')
            .select('id, from_id, to_id, payload, session_id, created_at')
            .eq('to_id', rid)
            .eq('type', 'offer')
            .gte('created_at', incomingPollSinceRef.current)
            .order('created_at', { ascending: true })
            .limit(5);
          if (!data || data.length === 0) continue;
          for (const sig of data) {
            incomingPollSinceRef.current = sig.created_at;
            await processIncomingOffer(sig, ' (polling)');
          }
        } catch { /* ignore transient errors */ }
      }
    };

    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [currentUser?.id, connectionId]);

  // Gelen çağrı penceresi sonsuza kadar açık kalmasın: arayan vazgeçip sekmeyi
  // kapatırsa hangup sinyali hiç gelmez ve pencere ekranda asılı kalırdı.
  // Arayanın kendi zaman aşımı 30 sn; bunu biraz sonrasına koyuyoruz.
  React.useEffect(() => {
    if (!incomingCall) return;
    const t = setTimeout(() => {
      setIncomingCall(null);
      addLocalLog('Gelen baglanti istegi zaman asimina ugradi.', 'warn');
    }, 45000);
    return () => clearTimeout(t);
  }, [incomingCall]);

  React.useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_e, session) => {
      // Realtime WebSocket'i kendi JWT'sini taşır ve RLS'i onunla değerlendirir.
      // Politikalar auth.uid()'e bağlandığında bu çağrı yapılmazsa postgres_changes
      // olayları SESSİZCE hiç gelmez — 2026-07-27'de bağlantıyı bozan tam olarak buydu.
      supabase.realtime.setAuth(session?.access_token ?? null);

      const user = session?.user ?? null;
      const anon = !!user?.is_anonymous;
      setCurrentUser(user);
      // Gerçek bir hesapla giriş yapıldıysa misafir tercihi düşer.
      // Anonim oturum açılması ise kullanıcıyı "misafir" YAPMAZ — o tercih
      // yalnızca "Misafir olarak devam et" ile verilir.
      if (user && !anon) setGuestChoice(false);
      if (user) {
        // Anonim kullanıcının doğrulanacak bir e-postası yoktur.
        setIsEmailVerified(anon || !!user.email_confirmed_at);
        setSessionToken(generateSessionToken());
        const fp = generateDeviceFingerprint();
        setDeviceFingerprint(fp);
        // Kimlik artık SUNUCUDA üretiliyor: benzersizliği veritabanı garanti
        // eder ve mevcut kimlik asla değişmez. Eski istemci üretimi 32-bit
        // hash'ti; çakışan kullanıcının upsert'ü sessizce başarısız oluyor ve
        // o kullanıcı kimliksiz — yani ulaşılamaz — kalıyordu.
        const { id: pid, fromServer } = await resolveMyConnectionId(user.id);
        setConnectionId(pid);
        // Kimlik bağlama: bu satır, display kimliğini (123-456-789) auth.uid()'e
        // bağlar. signals RLS'ini kimliğe dayandırmanın ön koşulu budur —
        // misafirler dahil herkes için yazılır.
        const profileRow: Record<string, unknown> = {
          id: user.id, email: user.email ?? null,
          device_fingerprint: fp, last_seen: new Date().toISOString(),
        };
        // Sunucu atadıysa kimliği tekrar yazmayız (RPC zaten yazdı).
        if (!fromServer) profileRow.connection_id = pid;
        await supabase.from('users').upsert(profileRow, { onConflict: 'id' });
        if (anon) {
          // Misafir: profil/geçmiş/abonelik yüklenmez, kayıt tutulmaz.
          setUserProfile(null);
          setEntitlements(FREE_ENTITLEMENTS);
          setLogs([{ time: ts(), msg: `Arku Remote v${__APP_VERSION__} baslatildi...`, type: 'sys' }, { time: ts(), msg: 'Misafir olarak devam ediliyor.', type: 'warn' }]);
          return;
        }
        const { data: prof } = await supabase.from('users').select('*').eq('id', user.id).single();
        if (prof) {
          setUserProfile(prof as UserProfile);
          if (prof.theme) setTheme(prof.theme as Theme);
          if (prof.display_name) setDisplayName(prof.display_name);
          if (prof.phone) setPhone(prof.phone);
          if (prof.qrtim_id) {
            setQrtimUser({ qrtim_id: prof.qrtim_id, email: prof.qrtim_email ?? '', name: prof.qrtim_name ?? '', username: prof.qrtim_username ?? '', photo_url: null, title: null, company: null, plan: 'free' });
          }
        }
        const { data: lgData } = await supabase.from('logs').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
        if (lgData) setLogs(lgData.map(l => ({ time: new Date(l.created_at).toLocaleTimeString('tr-TR'), msg: l.msg, type: l.type as LogType })));
        const { data: cxData } = await supabase.from('connections').select('*').eq('caller_id', user.id).order('created_at', { ascending: false }).limit(20);
        if (cxData) setConnectionHistory(cxData as ConnectionEntry[]);
        setEntitlements(await fetchEntitlements());
        // Kurumsal davetleri hesaba bagla. Bu cagri olmadan admin'in ekledigi
        // cihaz etiketleri hicbir zaman cozumlenmez ve kurumsal vanity kimlik
        // (acme-01) calismaz — organization_members.user_id NULL kalirdi.
        bindOrgInvites()
          .then(n => { if (n > 0) addLocalLog(`${n} kurumsal davet hesabiniza baglandi.`, 'sys'); })
          .catch(() => { /* RPC yoksa yok say */ });
      } else {
        setIsEmailVerified(true); setUserProfile(null); setSessionToken(''); setDeviceFingerprint(''); setConnectionId(getOrCreateGuestId());
        setEntitlements(FREE_ENTITLEMENTS);
        setLogs([{ time: ts(), msg: `Arku Remote v${__APP_VERSION__} baslatildi...`, type: 'sys' }, { time: ts(), msg: 'Lutfen giris yapin.', type: 'warn' }]);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // Her sekmeye gerçek bir oturum kazandır: oturumu olmayanlar anonim olarak
  // imzalanır. Böylece misafirler dahil her istemcinin bir auth.uid()'i ve
  // sunucuda kimlik bağlaması olur — signals RLS'ini kimliğe dayandırmanın ön koşulu.
  //
  // Supabase'de "Allow anonymous sign-ins" kapalıysa burası sessizce başarısız olur
  // ve uygulama bugünkü (oturumsuz misafir) davranışıyla çalışmaya devam eder.
  const anonBootstrapRef = React.useRef(false);
  React.useEffect(() => {
    // QRtım SSO dönüşünde atlanır; o akış kendi oturumunu açar.
    if (new URLSearchParams(window.location.search).get('qrtim_token')) return;
    if (anonBootstrapRef.current) return;
    anonBootstrapRef.current = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) return;
      const { error } = await supabase.auth.signInAnonymously();
      if (error) {
        anonBootstrapRef.current = false;
        addLocalLog('Anonim oturum acilamadi, misafir modunda devam ediliyor.', 'warn');
      }
    })();
  }, []);

  // QRtım'den ?qrtim_token=... ile dönüşte tek noktadan işle:
  // oturum açıksa hesabı bağla, açık değilse QRtım ile giriş yap (SSO).
  React.useEffect(() => {
    const qrtimToken = new URLSearchParams(window.location.search).get('qrtim_token');
    if (!qrtimToken) return;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      // DİKKAT: anonim oturum her sekmede açık olduğu için "oturum var mı"
      // sorusu artık her zaman EVET. Hesap bağlama yolu yalnızca GERÇEK bir
      // hesap için geçerlidir; aksi halde QRtım kimliği anonim kullanıcıya
      // bağlanır ve giriş hiç gerçekleşmez.
      if (session?.user && !session.user.is_anonymous) {
        await handleQrtimCallback(qrtimToken, session.user);
      } else {
        // Anonim oturumu kapat ki SSO gerçek hesabı açabilsin.
        if (session?.user?.is_anonymous) {
          try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* yok say */ }
        }
        await handleQrtimSsoLogin(qrtimToken);
      }
    })();
  }, []);

  // --- Embed (Nexus iframe) entegrasyonu ---
  const autoConnectRef = React.useRef(false);
  // Ana uygulamanın (Nexus) "Bitir" düğmesi {type:'arku:command', action:'end'}
  // gönderir. handleDisconnect aşağıda tanımlandığı için ref üzerinden çağrılır.
  const handleDisconnectRef = React.useRef<(() => Promise<void>) | null>(null);

  React.useEffect(() => {
    if (!EMBED.embed) return;
    const onMsg = (e: MessageEvent) => {
      if (EMBED.parentOrigin !== '*' && e.origin !== EMBED.parentOrigin) return;
      const d = e.data as { type?: string; action?: string } | null;
      if (d?.type !== 'arku:command') return;
      if (d.action === 'end') handleDisconnectRef.current?.();
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // session=<kod> geldiyse hedef kimliği doldur.
  React.useEffect(() => {
    if (EMBED.embed && EMBED.session) setTargetId(EMBED.session);
  }, []);

  // Embed'de kimlik çözülemezse (oturum yok) misafir moduna düş — böylece
  // auth modalı göstermeden otomatik bağlantı kurulabilir. Kalıcı oturumun
  // çözülmesi için kısa bir gecikme verilir.
  React.useEffect(() => {
    if (!EMBED.embed || !EMBED.session) return;
    const t = setTimeout(() => {
      setGuestChoice(!isRegistered && !isGuest ? true : isGuest);
    }, 1500);
    return () => clearTimeout(t);
  }, [currentUser]);

  // Kimlik hazır olunca verilen session koduna bir kez otomatik bağlan.
  React.useEffect(() => {
    if (!EMBED.embed || !EMBED.session || autoConnectRef.current) return;
    if (rtcState !== 'idle' || isConnecting) return;
    if (targetId !== EMBED.session) return;
    const ready = (isRegistered && isEmailVerified) || isGuest;
    if (!ready) return;
    autoConnectRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    handleConnect();
  }, [currentUser, isGuest, isEmailVerified, rtcState, isConnecting, targetId]);

  const updateTheme = async (t: Theme) => {
    setTheme(t);
    if (currentUser) { const { error } = await supabase.from('users').update({ theme: t }).eq('id', currentUser.id); if (error) addLocalLog(`Tema kaydedilemedi: ${error.message}`, 'error'); }
  };
  const copyId = () => {
    const write = () => { setCopied(true); addLog('Kimlik panoya kopyalandi.', 'info'); setTimeout(() => setCopied(false), 2000); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(connectionId).then(write);
    else { const ta = document.createElement('textarea'); ta.value = connectionId; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); write(); }
  };

  // Oturumsuz kalmamak için: RLS her istemciden bir kimlik ister, oturumsuz
  // sekmeye kimse bağlanamaz. Kullanıcı arayüzünde "misafir" göstermez.
  const ensureAnonSession = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) return;
    try { await supabase.auth.signInAnonymously(); } catch { /* ayar kapaliysa yok say */ }
  };

  const handleRegister = async () => {
    setAuthError('');
    if (!displayName.trim()) { setAuthError('Ad Soyad zorunludur.'); return; }
    if (password.length < 6) { setAuthError('Sifre en az 6 karakter olmali.'); return; }
    // Anonim oturum açıkken signUp, YENİ hesap açmak yerine mevcut anonim
    // kullanıcıya kimlik bağlar. Kayıt akışının öngörülebilir olması ve e-posta
    // doğrulamasının beklendiği gibi işlemesi için önce anonim oturumu kapatıyoruz.
    if (currentUser?.is_anonymous) {
      try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* yok say */ }
    }
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName, phone } } });
    if (error) { setAuthError(error.message); await ensureAnonSession(); return; }
    // "Confirm email" açıkken Supabase oturum DÖNDÜRMEZ; kullanıcı doğrulamadan giriş yapamaz.
    const dogrulamaGerekli = !data.session;
    setShowAuth(false);
    addLog(dogrulamaGerekli
      ? 'Kayit alindi. Hesabinizi kullanabilmek icin e-postanizdaki dogrulama baglantisina tiklayin.'
      : 'Kayit basarili.', 'warn');
    if (dogrulamaGerekli) await ensureAnonSession();
  };
  const handleLogin = async () => {
    setAuthError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // Supabase bu durumu İngilizce döndürür; kullanıcıya ne yapacağını söyleyelim.
      const dogrulanmamis = /confirm/i.test(error.message);
      setAuthError(dogrulanmamis
        ? 'E-posta adresiniz henuz dogrulanmamis. Gelen kutunuzdaki dogrulama baglantisina tiklayin.'
        : error.message);
      await ensureAnonSession();
      return;
    }
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
    if (webrtc) { try { await webrtc.disconnect(); } catch { /* yok say */ } setWebrtc(null); }
    // signOut'un sunucu çağrısı (global scope) başarısız olsa bile yerel oturumu
    // kesin temizle; aksi halde state güncellenmez ve "çıkış yapılmıyor" görünür.
    try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* yok say */ }
    // QRtım yeniden-giriş döngüsünü kır: kalan callback/token izlerini temizle.
    try { sessionStorage.removeItem('partner_callback'); } catch { /* yok say */ }
    // TURN kimlik bilgisi çağıranın kimliğine bağlıdır — sonraki kullanıcı
    // öncekinin kimliğiyle relay kullanmasın.
    resetIceCache();
    setCurrentUser(null); setUserProfile(null); setGuestChoice(false); setConnectionHistory([]);
    setQrtimUser(null);
    setRemoteStream(null); setQuality(null); setRtcState('idle'); setIsConnecting(false);
    setConnectionId(getOrCreateGuestId()); setDisplayName(''); setPhone(''); setSessionToken(''); setDeviceFingerprint('');
    setActiveTab('dashboard'); addLocalLog('Oturum kapatildi.', 'warn');
    // Çıkıştan sonra da ulaşılabilir kal (RLS oturum ister), ama kullanıcı
    // "misafir" sayılmaz: arayüz yine "Giris Yap" gösterir.
    await ensureAnonSession();
  };
  // Misafir olarak devam: oturum yoksa anonim imzalanır (kimlik bağlaması için).
  // Oturum zaten varsa yalnızca modalı kapatır — tekrar çağrılması güvenlidir.
  const handleGuestLogin = async () => {
    setGuestChoice(true); setShowAuth(false); setAuthError('');
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) await supabase.auth.signInAnonymously().catch(() => {});
    addLog('Misafir olarak devam ediliyor.', 'warn');
  };

  const refreshEntitlements = async () => {
    try { setEntitlements(await fetchEntitlements()); }
    catch { setEntitlements(FREE_ENTITLEMENTS); }
  };

  const refreshContacts = async () => {
    const [sc, cat] = await Promise.all([listSavedContacts(), listCategories()]);
    setSavedContacts(sc); setCategories(cat);
  };
  const refreshOrganizations = async () => {
    const orgs = await listMyOrganizations();
    setOrganizations(orgs);
    setActiveOrgId(prev => prev && orgs.some(o => o.id === prev) ? prev : (orgs[0]?.id ?? null));
  };

  // Kurumsal/kayıtlı verileri, ilgili sekme açıldığında ve giriş yapılınca yükle
  React.useEffect(() => {
    if (!isRegistered) { setSavedContacts([]); setCategories([]); setOrganizations([]); setOrgMembers([]); setActiveOrgId(null); return; }
    if (activeTab === 'contacts' && caps.savedContacts) refreshContacts();
    if (activeTab === 'organization' && caps.organizations) refreshOrganizations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, currentUser, entitlements.plan]);

  // Seçili org değişince üyeleri yükle
  React.useEffect(() => {
    if (activeOrgId) listOrgMembers(activeOrgId).then(setOrgMembers); else setOrgMembers([]);
  }, [activeOrgId]);

  // Oturum bitince parolayı yenile — bir kez paylaşılan parola tekrar
  // kullanılamasın. YALNIZCA gerçekten biten bir oturumdan sonra: aksi halde
  // karşı taraf parolayı okuyup çevirene kadar parola değişebilirdi.
  const prevRtcStateRef = React.useRef<ConnectionState>('idle');
  React.useEffect(() => {
    const prev = prevRtcStateRef.current;
    prevRtcStateRef.current = rtcState;
    if (rtcState === 'idle' && (prev === 'connected' || prev === 'disconnected')) {
      setSessionPassword(generateSessionPassword());
      badPasswordTriesRef.current.clear();
      addLocalLog('Oturum parolasi yenilendi.', 'sys');
    }
  }, [rtcState]);

  const regenerateSessionPassword = () => {
    setSessionPassword(generateSessionPassword());
    badPasswordTriesRef.current.clear();
    addLocalLog('Oturum parolasi yenilendi.', 'sys');
  };

  const toggleRequirePassword = (v: boolean) => {
    setRequirePassword(v);
    try { localStorage.setItem('arku_require_password', v ? '1' : '0'); } catch { /* yok say */ }
    addLocalLog(v ? 'Baglanti icin parola zorunlu.' : 'Parola zorunlulugu kapatildi.', v ? 'sys' : 'warn');
  };

  // Kalp atışı: karşı taraf bizi ancak last_seen güncel kalırsa "çevrimiçi"
  // görebilir. 60 sn aralık, sunucudaki 90 sn eşiğiyle uyumlu — bir atış
  // kaçtığında cihaz çevrimdışı görünmez.
  React.useEffect(() => {
    if (!currentUser) return;
    const uid = currentUser.id;
    const beat = () => { sendHeartbeat(uid).catch(() => { /* geçici ağ hatası */ }); };
    beat();
    const timer = setInterval(beat, 60000);
    // Sekme geri geldiğinde hemen bildir (uyku sonrası bekleme olmasın).
    const onVisible = () => { if (!document.hidden) beat(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [currentUser?.id]);

  // Kayıtlı müşterilerin çevrimiçi durumu — yalnızca Kayıtlı sekmesi açıkken.
  React.useEffect(() => {
    if (activeTab !== 'contacts' || savedContacts.length === 0) { return; }
    const ids = savedContacts.map(c => c.connection_id);
    const load = () => { fetchPresence(ids).then(setPresence).catch(() => { /* RPC yoksa boş kalır */ }); };
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [activeTab, savedContacts]);

  // ── Kayıtlı müşteri form durumu + eylemleri ────────────────────────────────
  const [scConnId, setScConnId] = React.useState('');
  const [scName, setScName] = React.useState('');
  const [scCategory, setScCategory] = React.useState('');
  const [scNotes, setScNotes] = React.useState('');
  const [newCatName, setNewCatName] = React.useState('');
  const [newCatColor, setNewCatColor] = React.useState('#c5a059');
  const [entError, setEntError] = React.useState('');

  const activeOrg = organizations.find(o => o.id === activeOrgId) ?? null;
  const myMembership = orgMembers.find(m => m.user_id === currentUser?.id);
  const canManageOrg = activeOrg?.owner_id === currentUser?.id || myMembership?.role === 'owner' || myMembership?.role === 'admin';

  const handleSaveContact = async () => {
    setEntError('');
    if (!scConnId.trim()) { setEntError('Kimlik gerekli.'); return; }
    // Kayıtlı sekmesi kişisel kayıt oluşturur (owner_id = ben). Kurumsal
    // paylaşımlı kayıtlar sonraki adımda org kapsamıyla eklenecek.
    const { error } = await createSavedContact({
      connection_id: scConnId, display_name: scName, category_id: scCategory || null, notes: scNotes,
    });
    if (error) { setEntError(error); return; }
    setScConnId(''); setScName(''); setScCategory(''); setScNotes('');
    await refreshContacts();
  };
  const handleDeleteContact = async (id: string) => { await deleteSavedContact(id); await refreshContacts(); };
  const handleCreateCategory = async () => {
    setEntError('');
    if (!newCatName.trim()) return;
    const { error } = await createCategory(newCatName.trim(), newCatColor);
    if (error) { setEntError(error); return; }
    setNewCatName(''); await refreshContacts();
  };
  const handleDeleteCategory = async (id: string) => { await deleteCategory(id); await refreshContacts(); };
  const connectToContact = (cid: string) => { setTargetId(cid); setActiveTab('dashboard'); };

  // ── Organizasyon form durumu + eylemleri ───────────────────────────────────
  const [newOrgName, setNewOrgName] = React.useState('');
  const [newOrgSlug, setNewOrgSlug] = React.useState('');
  const [orgEditName, setOrgEditName] = React.useState('');
  const [orgEditLogo, setOrgEditLogo] = React.useState('');
  const [memberEmail, setMemberEmail] = React.useState('');
  const [memberLabel, setMemberLabel] = React.useState('');
  const [memberRole, setMemberRole] = React.useState<OrgRole>('operator');

  React.useEffect(() => {
    if (activeOrg) { setOrgEditName(activeOrg.name); setOrgEditLogo(activeOrg.logo_url ?? ''); }
  }, [activeOrgId]);

  const handleCreateOrg = async () => {
    setEntError('');
    const { org, error } = await createOrganization(newOrgName.trim(), newOrgSlug.trim().toLowerCase());
    if (error) { setEntError(error); return; }
    setNewOrgName(''); setNewOrgSlug('');
    await refreshOrganizations();
    if (org) setActiveOrgId(org.id);
  };
  const handleSaveOrg = async () => {
    if (!activeOrgId) return;
    setEntError('');
    const { error } = await updateOrganization(activeOrgId, { name: orgEditName.trim(), logo_url: orgEditLogo.trim() || null });
    if (error) { setEntError(error); return; }
    await refreshOrganizations();
  };
  const handleDeleteOrg = async () => {
    if (!activeOrgId) return;
    await deleteOrganization(activeOrgId);
    await refreshOrganizations();
  };
  const handleAddMember = async () => {
    if (!activeOrgId) return;
    setEntError('');
    if (!memberEmail.trim() && !memberLabel.trim()) { setEntError('E-posta veya cihaz etiketi girin.'); return; }
    const { error } = await addOrgMember(activeOrgId, { invited_email: memberEmail.trim() || undefined, device_label: memberLabel.trim() || undefined, role: memberRole });
    if (error) { setEntError(error); return; }
    setMemberEmail(''); setMemberLabel('');
    setOrgMembers(await listOrgMembers(activeOrgId));
  };
  const handleRemoveMember = async (id: string) => {
    await removeOrgMember(id);
    if (activeOrgId) setOrgMembers(await listOrgMembers(activeOrgId));
  };
  const handleMemberLabel = async (id: string, label: string) => {
    await updateOrgMember(id, { device_label: label || null });
    if (activeOrgId) setOrgMembers(await listOrgMembers(activeOrgId));
  };

  const handleQrtimCallback = async (token: string, _user: SupabaseUser) => {
    setQrtimLinking(true);
    try {
      // qrtim-sync (Arku edge function): QRtım token'ını server-to-server doğrular,
      // kimliği users satırına yazar ve ücretli QRtım planı için ücretsiz Arku
      // aboneliği verir. Çağrı, kullanıcının kendi oturum jetonuyla yapılır.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { addLocalLog('QRtım bağlantısı için oturum gerekli.', 'error'); return; }
      const res = await fetch(QRTIM_SYNC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: ARKU_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ qrtim_token: token }),
      });
      const data = await res.json();
      if (!res.ok || !data.valid) {
        addLocalLog(`QRtım bağlantısı başarısız: ${data.error || 'Bilinmeyen hata'}`, 'error');
        return;
      }
      if (data.user.name && !displayName) setDisplayName(data.user.name);
      setQrtimUser(data.user);
      await refreshEntitlements();
      const planNote = data.arku_plan && data.arku_plan !== 'free' ? ` (Arku ${data.arku_plan} aboneliği tanımlandı)` : '';
      addLocalLog(`QRtım hesabı bağlandı: ${data.user.name}${planNote}`, 'sys');
    } catch (err) {
      addLocalLog(`QRtım bağlantısı hatası: ${String(err)}`, 'error');
    } finally {
      setQrtimLinking(false);
      window.history.replaceState({}, '', window.location.pathname);
    }
  };

  // QRtım'in geri döneceği adres. Masaüstü (Electron) uygulamada sayfa file://
  // ile yüklüdür; QRtim file:// callback'i kabul etmez (ve https -> file://
  // yönlendirme tarayıcıca engellenir). Bu yüzden Electron'da callback olarak
  // güvenilen web adresi kullanılır; dönüş electron/main.cjs tarafından
  // yakalanıp token yerel uygulamaya aktarılır.
  const qrtimCallbackUrl = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).electronAPI?.isElectron) return 'https://arku-remote.vercel.app';
    return window.location.origin + window.location.pathname;
  };

  const handleQrtimConnect = () => {
    if (!isRegistered) { setShowAuth(true); setAuthMode('login'); return; }
    window.location.href = `${QRTIM_BASE_URL}/login?callback=${encodeURIComponent(qrtimCallbackUrl())}&source=arku`;
  };

  // Giriş ekranından QRtım ile tek tıkla giriş (oturum gerekmez).
  const handleQrtimLogin = () => {
    window.location.href = `${QRTIM_BASE_URL}/login?callback=${encodeURIComponent(qrtimCallbackUrl())}&source=arku`;
  };

  // QRtım token'ı ile dönüldüğünde: oturum varsa hesabı bağla, yoksa SSO ile giriş yap.
  const handleQrtimSsoLogin = async (token: string) => {
    setQrtimLinking(true);
    try {
      const res = await fetch(QRTIM_AUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: ARKU_ANON_KEY,
          Authorization: `Bearer ${ARKU_ANON_KEY}`,
        },
        body: JSON.stringify({ qrtim_token: token }),
      });
      const data = await res.json();
      if (!res.ok || !data.token_hash) {
        addLocalLog(`QRtım ile giriş başarısız: ${data.error || 'Bilinmeyen hata'}`, 'error');
        return;
      }
      const { error } = await supabase.auth.verifyOtp({ token_hash: data.token_hash, type: 'magiclink' });
      if (error) {
        addLocalLog(`QRtım oturumu açılamadı: ${error.message}`, 'error');
        return;
      }
      setShowAuth(false);
      addLocalLog('QRtım ile giriş yapıldı.', 'sys');
    } catch (err) {
      addLocalLog(`QRtım giriş hatası: ${String(err)}`, 'error');
    } finally {
      setQrtimLinking(false);
      window.history.replaceState({}, '', window.location.pathname);
    }
  };

  const handleQrtimDisconnect = async () => {
    if (!currentUser) return;
    await supabase.from('users').update({
      qrtim_id: null, qrtim_username: null, qrtim_name: null,
      qrtim_email: null, qrtim_connected_at: null,
    }).eq('id', currentUser.id);
    setQrtimUser(null);
    addLocalLog('QRtım hesabı bağlantısı kesildi.', 'warn');
  };

  // Uzaktan kontrol iznini kapat. Masaüstünde ana süreçteki yetkiyi de düşürür —
  // asıl kapı orası; buradaki bayrak yalnızca arayüz durumudur.
  // ── Pano paylasimi ─────────────────────────────────────────────────────────
  // forRemote/fromRemote = "islemi karsi taraf istedi". Ana surec bu durumda
  // kontrol iznini arar; operatorun kendi dugmesine basmasi kapiya takilmaz.
  const readLocalClipboard = async (forRemote: boolean): Promise<string | null> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (api?.readClipboard) { try { return await api.readClipboard({ forRemote }); } catch { return null; } }
    // Web surumu: tarayici izin ve odak ister, reddedilebilir.
    try { return await navigator.clipboard.readText(); } catch { return null; }
  };

  const writeLocalClipboard = async (text: string, fromRemote: boolean): Promise<boolean> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (api?.writeClipboard) { api.writeClipboard({ text, fromRemote }); return true; }
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  };

  const sendClipboardToRemote = async () => {
    if (!webrtc || rtcState !== 'connected') return;
    const text = await readLocalClipboard(false);
    if (!text) { addLocalLog('Yerel pano bos veya okunamadi.', 'warn'); return; }
    webrtc.sendControl({ k: 'clip-set', text });
    addLocalLog(`Pano karsi tarafa gonderildi (${text.length} karakter).`, 'sys');
  };

  const requestRemoteClipboard = () => {
    if (!webrtc || rtcState !== 'connected') return;
    webrtc.sendControl({ k: 'clip-req' });
    addLocalLog('Uzak pano istendi...', 'info');
  };

  const disableRemoteControl = () => {
    setRemoteControlAllowed(false);
    setControlNotice('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI?.revokeRemoteControl?.();
  };

  // İzin verme yolu: masaüstünde onayı ana süreç kendi penceresinde sorar, böylece
  // web içeriği ele geçirilse bile kontrol tek başına açılamaz.
  const toggleRemoteControl = async () => {
    if (remoteControlAllowed) {
      disableRemoteControl();
      addLocalLog('Uzaktan kontrol izni kapatildi.', 'warn');
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).electronAPI;
    if (api?.requestRemoteControl) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let res: any = null;
      try { res = await api.requestRemoteControl(); } catch { res = null; }
      // Eski preload yalnızca boolean döndürüyordu; yeni sürüm
      // { granted, pointer, reason, error } veriyor. İkisi de desteklenir.
      const granted = res === true || res?.granted === true;
      if (!granted) {
        // Eskiden burada tek bir "izin verilmedi" satırı vardı ve nut-js hiç
        // yüklenmediyse kullanıcı sebebini ASLA öğrenemiyordu.
        const reason = res?.reason;
        addLocalLog(
          reason === 'unavailable'
            ? `Uzaktan kontrol bu kurulumda kullanilamiyor${res?.error ? `: ${res.error}` : '.'}`
            : reason === 'accessibility'
              ? 'macOS Erisilebilirlik izni yok — Sistem Ayarlari > Gizlilik ve Guvenlik > Erisilebilirlik.'
              : 'Uzaktan kontrol izni verilmedi.',
          reason === 'denied' || !reason ? 'warn' : 'error',
        );
        return;
      }
      // Tek pencere paylaşıldıysa fare koordinatı güvenilir eşlenemez;
      // ana süreç fareyi reddeder, klavye çalışmaya devam eder.
      const pointerOff = res !== true && res?.pointer === false;
      setControlNotice(pointerOff ? 'Yalnizca klavye' : '');
      if (pointerOff) {
        addLocalLog('Tek pencere paylasildi: fare kontrolu kapali, klavye calisiyor. Fare icin tum ekrani paylasin.', 'warn');
      }
    }
    setRemoteControlAllowed(true);
    addLocalLog('Uzaktan kontrole izin verildi.', 'warn');
  };

  const buildManager = (): WebRTCManager => {
    const myId = currentUser?.id || connectionId;
    const m = new WebRTCManager(myId);
    m.onQuality = setQuality;
    m.onControl = async (msg: ControlMsg) => {
      const role = m.getRole();
      if (msg.k === 'clip-req') {
        // Yalnizca KONTROL EDILEN taraf panosunu verir ve yalnizca izin varsa.
        // Panodaki bir parola, ekranda hic gorunmeden disari cikabilir —
        // bu yuzden klavye/fare ile ayni kapidan geciyor.
        if (role !== 'receiver' || !remoteControlAllowedRef.current) return;
        const text = await readLocalClipboard(true);
        if (!text) return;
        m.sendControl({ k: 'clip-set', text });
        addLocalLog('Panonuz karsi tarafa gonderildi.', 'warn');
        return;
      }
      if (msg.k === 'clip-set') {
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (!text) return;
        if (role === 'receiver') {
          // Karsi taraf PANOMUZA yaziyor — kontrol izni sart.
          if (!remoteControlAllowedRef.current) return;
          const ok = await writeLocalClipboard(text, true);
          if (ok) addLocalLog('Karsi taraf panonuza metin yazdi.', 'warn');
        } else {
          // Operator: kendi istedigi uzak panonun yaniti.
          const ok = await writeLocalClipboard(text, false);
          addLocalLog(ok ? `Uzak pano alindi (${text.length} karakter).` : 'Pano yazilamadi.', ok ? 'sys' : 'warn');
        }
        return;
      }

      // ── Coklu monitor ──
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).electronAPI;

      if (msg.k === 'screens-req') {
        // Yalnizca paylasan taraf listesini verir, yalnizca kontrol izniyle.
        if (role !== 'receiver' || !remoteControlAllowedRef.current || !api?.listScreens) return;
        const res = await api.listScreens();
        m.sendControl({ k: 'screens', list: res?.list ?? [], current: res?.current ?? '' });
        return;
      }

      if (msg.k === 'screens') {
        // Operator tarafi: listeyi arayuze al.
        setRemoteScreens(Array.isArray(msg.list) ? msg.list : []);
        setCurrentRemoteScreen(typeof msg.current === 'string' ? msg.current : '');
        return;
      }

      if (msg.k === 'screen-select') {
        if (role !== 'receiver' || !remoteControlAllowedRef.current || !api?.selectScreen) return;
        const ok = await api.selectScreen(msg.id);
        if (!ok) { addLocalLog('Ekran degistirilemedi.', 'warn'); return; }
        try {
          // Gecise yeniden pazarlik gerekmez: replaceTrack SDP'ye dokunmaz.
          // getUserMedia'nin chromeMediaSource yolu kullanici hareketi istemez.
          const next = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: msg.id,
                maxFrameRate: captureFrameRate,
              },
            },
          } as unknown as MediaStreamConstraints);
          const track = next.getVideoTracks()[0];
          if (!track) throw new Error('Video track alinamadi');
          await m.replaceVideoTrack(track);
          // Eski akisi durdur, onizlemeyi guncelle.
          const prev = localVideoRef.current?.srcObject as MediaStream | null;
          prev?.getTracks().forEach(t => { t.onended = null; t.stop(); });
          if (localVideoRef.current) localVideoRef.current.srcObject = next;
          // Paylasim durdurulursa oturum kapansin (ilk akistaki davranisin ayni).
          track.onended = async () => {
            addLocalLog('Ekran paylasimi durduruldu — baglanti kesiliyor.', 'warn');
            try { await m.disconnect(); } catch { /* yok say */ }
          };
          addLocalLog('Karsi taraf paylasilan ekrani degistirdi.', 'warn');
          const res2 = api.listScreens ? await api.listScreens() : null;
          m.sendControl({ k: 'screens', list: res2?.list ?? [], current: res2?.current ?? msg.id });
        } catch (err) {
          addLocalLog(`Ekran degistirilemedi: ${String(err)}`, 'error');
        }
      }
    };
    m.onStateChange = (state) => {
      setRtcState(state);
      if (state === 'connecting') {
        postSessionEvent('connecting', targetId, EMBED.mode);
        // ICE prepareIce() sırasında çözülür; TURN yoksa kullanıcıyı uyaralım.
        setTurnAvailable(m.getIce()?.hasTurn !== false);
      }
      if (state === 'connected') {
        setIsConnecting(false);
        setTurnAvailable(m.getIce()?.hasTurn !== false);
        postSessionEvent('connected', targetId, EMBED.mode);
        if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
      }
      if (state === 'disconnected') {
        setIsConnecting(false);
        setRemoteStream(null);
        setQuality(null);
        setRemoteScreens([]);
        setInputEnabled(false);
        disableRemoteControl();
        postSessionEvent('ended', targetId, EMBED.mode);
        if (localVideoRef.current?.srcObject) {
          (localVideoRef.current.srcObject as MediaStream)?.getTracks().forEach(t => t.stop());
          localVideoRef.current.srcObject = null;
        }
        if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
      }
      if (state === 'idle') { setIsConnecting(false); setRemoteStream(null); setQuality(null); setInputEnabled(false); disableRemoteControl(); }
    };
    m.onRemoteStream = (stream) => {
      setRemoteStream(stream);
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
      addLog('Uzak ekran aliniyor.', 'sys');
    };
    m.onLog = (msg, type) => addLog(msg, (type as LogType) || 'info');
    m.onInputEvent = (event: InputEventMsg) => {
      // Ekranı paylaşan kullanıcı izin vermeden uzaktan kontrol işletilmez
      if (!remoteControlAllowedRef.current) return;
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
    if (!isRegistered && !isGuest) { setShowAuth(true); setAuthMode('login'); return; }
    if (isRegistered && !isEmailVerified) { addLog('Baglanmak icin e-posta dogrulamasi gerekli.', 'error'); setShowAuth(true); return; }
    if (!targetId.trim()) return;
    if (targetId.trim() === connectionId || (currentUser && targetId.trim() === currentUser.id)) { addLog('Kendi cihaziniza baglanamazsiniz.', 'error'); return; }

    if (webrtc) await webrtc.disconnect();
    setWebrtc(null); setRemoteStream(null); setQuality(null); setRtcState('idle'); setIsConnecting(true);
    addLog(`${targetId} adresine baglaniliyor...${EMBED.op ? ` (operator: ${EMBED.op})` : ''}`, 'warn');
    resetSessionEvents();
    postSessionEvent('connecting', targetId, EMBED.mode);

    const nd = (v: string) => { const d = v.replace(/\D/g, '').slice(0, 9); return d.length === 9 ? `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6,9)}` : v.trim(); };
    // Harf içeren hedef = kurumsal vanity kimlik (acme-01); slug küçük harfle
    // saklandığı için normalize et. Salt numerik ID'ler eski biçimini korur.
    const hasLetters = /[a-z]/i.test(targetId);
    const normalizedTarget = hasLetters ? targetId.trim().toLowerCase() : nd(targetId);
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedTarget);

    let peerSignalId = normalizedTarget;

    if (!isGuest && isRegistered && currentUser && !looksLikeUuid) {
      const rawDigits = targetId.replace(/\D/g, '').slice(0, 9);
      // RLS, users tablosunu kendi satırıyla sınırlar; çözümleme yalnızca UUID
      // döndüren resolve_connection_id RPC'si üzerinden yapılır. Fonksiyon henüz
      // kurulmamışsa (eski şema) doğrudan sorguya düşülür.
      const resolve = async (cid: string): Promise<string | null> => {
        const { data, error } = await supabase.rpc('resolve_connection_id', { cid });
        if (!error) return (data as string | null) ?? null;
        const q = await supabase.from('users').select('id').eq('connection_id', cid).maybeSingle();
        return q.data?.id ?? null;
      };
      let peerId: string | null = await resolve(normalizedTarget);
      if (!peerId && rawDigits.length === 9) {
        peerId = await resolve(`${rawDigits.slice(0,3)}-${rawDigits.slice(3,6)}-${rawDigits.slice(6,9)}`);
      }
      if (peerId) {
        peerSignalId = peerId;
        if (peerSignalId === currentUser.id) { setIsConnecting(false); addLog('Kendi hesabiniza baglamazsiniz.', 'error'); return; }
        addLog(`Hedef cozumlendi -> ${peerSignalId.slice(0,8)}...`, 'sys');
      } else {
        // Çözümlenemeyen kimlik ille de hatalı değildir: misafir kullanıcıların
        // users satırı yoktur, dolayısıyla RPC null döner. Eskiden burada
        // iptal ediliyordu ve girişli bir kullanıcı bir misafire ASLA
        // bağlanamıyordu. Misafirler kendi kimliklerini dinlediği için
        // yazılan kimliğe doğrudan sinyal göndermek doğru davranıştır.
        addLog(`Kimlik kayitli degil, dogrudan deneniyor: ${normalizedTarget}`, 'warn');
      }
    }

    const m = buildManager();
    setWebrtc(m);
    try { await m.call(peerSignalId, { password: targetPassword.trim().toUpperCase() }); }
    catch (err) { postSessionEvent('error', targetId, EMBED.mode); addLog(`Baglantiyi gonderilemedi: ${String(err)}`, 'error'); setWebrtc(null); setIsConnecting(false); return; }
    // Kayıtlı bir müşteriye bağlanıldıysa son bağlantı zamanını güncelle (RLS izin verirse)
    if (currentUser) touchSavedContact(normalizedTarget).catch(() => {});

    if (connTimeoutRef.current) clearTimeout(connTimeoutRef.current);
    connTimeoutRef.current = setTimeout(async () => {
      if (!m.isConnected()) { await m.disconnect(); setWebrtc(null); setIsConnecting(false); postSessionEvent('error', targetId, EMBED.mode); addLog(`${targetId} yanit vermedi (zaman asimi).`, 'error'); }
    }, 30000);
  };

  const handleCancelConnect = async () => {
    if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
    // Arayüzü ÖNCE serbest bırak: teardown'ın herhangi bir adımı takılsa bile
    // kullanıcı "Baglaniyor..." ekranında kilitli kalmamalı.
    const m = webrtc;
    setWebrtc(null); setIsConnecting(false); setRtcState('idle');
    addLog('Baglaniti istegi iptal edildi.', 'warn');
    try { await m?.disconnect(); } catch { /* teardown hatasi arayuzu etkilemesin */ }
  };

  const handleAcceptCall = async () => {
    if (!incomingCall) return;
    const { fromId, toId, offerPayload, sessionId, signalId } = incomingCall;
    // getDisplayMedia must be called while still in the user gesture context
    // (button click). Closing the modal first breaks the gesture chain in Chrome.
    let screen: MediaStream | null = null;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({
        // cursor:'always' — operatör imleci görebilmeli. Standart dışı ama
        // Chromium bunu destekliyor; desteklemeyen tarayıcı sessizce yok sayar.
        video: { frameRate: captureFrameRate, cursor: 'always' } as MediaTrackConstraints,
        audio: false,
      });
    } catch { addLog('Ekran paylasimi secilmedi veya reddedildi.', 'error'); return; }
    setIncomingCall(null);
    if (localVideoRef.current) localVideoRef.current.srcObject = screen;
    if (webrtc) await webrtc.disconnect();
    disableRemoteControl(); // her oturum kontrol izni kapalı başlar
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
        setQuality(null);
        setIsConnecting(false);
        setInputEnabled(false);
        if (localVideoRef.current) { localVideoRef.current.srcObject = null; }
      };
    });

    try { await m.accept(fromId, offerPayload, screen, { sessionId, addressedAs: toId, offerSignalId: signalId }); }
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
    // Reddi, arayanın bizi çağırdığı kimlikle imzala; aksi halde arayan bu
    // hangup'ı "başka birinden" sanıp yok sayar ve 30 sn zaman aşımını bekler.
    const replyAs = incomingCall.toId || currentUser?.id || connectionId;
    setIncomingCall(null); addLog('Baglaniti istegi reddedildi.', 'warn');
    await supabase.from('signals').insert({ from_id: replyAs, to_id: incomingCall.fromId, type: 'hangup', payload: { reason: 'rejected' } });
  };

  const handleDisconnect = async () => {
    if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
    // Ekran paylaşımını ve arayüzü önce durdur, teardown'ı sonra bekle.
    const m = webrtc;
    if (localVideoRef.current?.srcObject) { (localVideoRef.current.srcObject as MediaStream)?.getTracks().forEach(t => t.stop()); localVideoRef.current.srcObject = null; }
    setWebrtc(null); setRemoteStream(null); setQuality(null); setRtcState('idle'); setIsConnecting(false);
    addLog('Baglaniti kesildi.', 'warn');
    postSessionEvent('ended', targetId, EMBED.mode);
    try { await m?.disconnect(); } catch { /* teardown hatasi arayuzu etkilemesin */ }
  };
  handleDisconnectRef.current = handleDisconnect; // her render'da güncel referans

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isElectron = !!(window as any).electronAPI?.isElectron;

  const handleCheckUpdates = async () => {
    setUpdateChecking(true); setUpdateCheck(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (window as any).electronAPI?.checkForUpdates?.();
      setUpdateCheck(res ?? { status: 'error', message: 'Guncelleme servisi kullanilamiyor.' });
    } catch (err) {
      setUpdateCheck({ status: 'error', message: String(err) });
    }
    setUpdateChecking(false);
  };

  const updateCheckMessage = (r: { status: string; version?: string; message?: string }): string => {
    if (r.status === 'available') return `Yeni surum mevcut${r.version ? ` (v${r.version})` : ''}. Hazir oldugunda bilgilendirileceksiniz.`;
    if (r.status === 'current') return `Uygulamaniz guncel${r.version ? ` (v${r.version})` : ''}.`;
    if (r.status === 'dev') return 'Gelistirme modunda guncelleme kontrolu yapilmaz.';
    return `Kontrol edilemedi: ${r.message ?? 'bilinmeyen hata'}`;
  };

  const isLight = theme === 'umay';

  // ── Bağlantı kalitesi göstergesi ───────────────────────────────────────────
  // "Yavaş / bulanık / kopuyor" şikayetlerinin teşhisi buradan yapılır:
  // RELAY etiketi TURN üzerinden gidildiğini (yani P2P delinemediğini),
  // gecikme ve kayıp ise hattın durumunu gösterir.
  const PATH_LABEL: Record<RtcQuality['path'], string> = {
    host: 'YEREL AG', srflx: 'P2P', relay: 'RELAY', unknown: 'ANALIZ',
  };
  const rttColor = (ms: number | null) =>
    ms === null ? 'var(--text-muted)' : ms < 80 ? '#4ade80' : ms < 200 ? '#facc15' : '#f87171';
  const lossColor = (pct: number | null) =>
    pct === null ? 'var(--text-muted)' : pct < 2 ? '#4ade80' : pct < 8 ? '#facc15' : '#f87171';

  const QualityChips = ({ compact = false }: { compact?: boolean }) => {
    if (!quality) return null;
    const q = quality;
    const mbps = q.kbps >= 1000 ? `${(q.kbps / 1000).toFixed(1)} Mbps` : `${q.kbps} kbps`;
    const chip = 'px-1.5 py-0.5 text-[8px] uppercase tracking-widest whitespace-nowrap';
    return (
      <div className={`flex items-center gap-1.5 ${compact ? '' : 'flex-wrap'}`}>
        <span
          className={chip}
          title={q.path === 'relay'
            ? 'Trafik TURN sunucusu üzerinden aktarılıyor (doğrudan bağlantı kurulamadı).'
            : 'Doğrudan uçtan uca bağlantı.'}
          style={{
            border: `1px solid ${q.path === 'relay' ? 'rgba(250,204,21,0.5)' : 'rgba(74,222,128,0.5)'}`,
            color: q.path === 'relay' ? '#facc15' : '#4ade80',
          }}
        >{PATH_LABEL[q.path]}</span>
        {q.rttMs !== null && (
          <span className={chip} title="Gidiş-dönüş gecikmesi" style={{ color: rttColor(q.rttMs) }}>{q.rttMs} ms</span>
        )}
        <span className={chip} title="Video bit hızı" style={{ color: 'var(--text-muted)' }}>{mbps}</span>
        {!compact && q.width && q.height && (
          <span className={chip} title="Çözünürlük ve kare hızı" style={{ color: 'var(--text-muted)' }}>
            {q.width}×{q.height}{q.fps !== null ? ` · ${q.fps} fps` : ''}
          </span>
        )}
        {q.lossPct !== null && q.lossPct > 0 && (
          <span className={chip} title="Paket kaybı" style={{ color: lossColor(q.lossPct) }}>%{q.lossPct} kayip</span>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen flex flex-col selection:bg-steppe-gold selection:text-steppe-stone">
      {!EMBED.embed && (
      <header className="border-b border-steppe-border sticky top-0 z-50 backdrop-blur-md" style={{ background: isLight ? 'rgba(240,244,248,0.92)' : 'rgba(17,16,16,0.85)' }}>
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 gokturk-border flex items-center justify-center overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
              <img src="./icons/64x64.png" alt="Arku" className="w-9 h-9 object-contain" />
            </div>
            <div>
              <h1 className="text-lg text-steppe-gold leading-none">Arku Remote</h1>
              <span className="text-[7px] px-1 border border-steppe-border text-steppe-gold opacity-60 uppercase tracking-widest">{`v${__APP_VERSION__}`}</span>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2 px-3 py-1 border border-steppe-border" style={{ background: 'var(--surface-primary)' }}>
            <div className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-green-400' : 'bg-red-400'}`} />
            <span className="text-[9px] uppercase tracking-widest text-steppe-muted">{isOnline ? 'Cevrimici' : 'Cevrimdisi'}</span>
            {isGuest && <span className="text-[9px] text-yellow-400 ml-2 pl-2 border-l border-steppe-border uppercase tracking-widest">Misafir</span>}
          </div>
          <nav className="hidden md:flex gap-8 items-center">
            {(['dashboard','connections',
               ...(isRegistered && caps.savedContacts ? ['contacts'] as Tab[] : []),
               ...(isRegistered && caps.organizations ? ['organization'] as Tab[] : []),
               'settings'] as Tab[]).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`text-[11px] uppercase tracking-widest transition-colors ${activeTab === tab ? 'text-steppe-gold' : 'text-steppe-muted hover:text-steppe-paper'}`}>
                {tab === 'dashboard' ? 'Panel' : tab === 'connections' ? 'Baglantilar' : tab === 'contacts' ? 'Kayitli' : tab === 'organization' ? 'Kurumsal' : 'Ayarlar'}
              </button>
            ))}
            <button
              onClick={() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const api = (window as any).electronAPI;
                if (api?.newWindow) api.newWindow();
                else window.open(window.location.origin + window.location.pathname, '_blank');
              }}
              title="Ayni hesapla ikinci bir musteriye baglanmak icin yeni bagimsiz oturum ac (Ctrl+N)"
              className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-steppe-muted hover:text-steppe-gold transition-colors"
            ><ExternalLink size={12} /> Yeni Oturum</button>
            {isRegistered ? (
              <div className="flex items-center gap-4">
                <span className="text-[10px] text-steppe-gold opacity-70">{userProfile?.display_name || currentUser?.email}</span>
                <button onClick={handleLogout} className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-steppe-muted hover:text-red-400 transition-colors"><LogOut size={12} /> Cikis</button>
              </div>
            ) : isGuest ? (
              <div className="flex items-center gap-4">
                <span className="text-[10px] text-yellow-400 opacity-70">Misafir</span>
                <button onClick={() => { setShowAuth(true); setAuthMode('login'); setGuestChoice(false); }} className="btn-ghost px-5 py-2">Giris Yap</button>
              </div>
            ) : (
              <button onClick={() => { setShowAuth(true); setAuthMode('login'); }} className="btn-ghost px-5 py-2">Giris Yap</button>
            )}
          </nav>
        </div>
      </header>
      )}

      <main className={`flex-1 max-w-7xl mx-auto w-full px-6 ${EMBED.embed ? 'py-4' : 'py-10'}`}>
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
                  <div className={`w-1.5 h-1.5 rounded-full ${isRegistered ? 'bg-green-400' : isGuest ? 'bg-yellow-400' : 'bg-gray-400'}`} />
                  <span className="text-[9px] text-steppe-muted uppercase tracking-widest">{isRegistered ? 'Profil ID' : isGuest ? 'Misafir ID' : 'Cihaz ID (Gecici)'}</span>
                  {isRegistered && entitlements.plan !== 'free' && (
                    <span className="text-[8px] px-1.5 py-0.5 rounded uppercase tracking-widest font-bold" style={{ background: 'var(--accent-primary)', color: 'var(--btn-text)' }}>
                      {entitlements.plan}{entitlements.source === 'qrtim' ? ' · QRtım' : ''}
                    </span>
                  )}
                </div>
                {/* Oturum parolasi — kimlikle birlikte karsi tarafa okunur.
                    Kimligi bilmek tek basina baglanmaya yetmez. */}
                <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-primary)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] uppercase tracking-widest text-steppe-muted flex items-center gap-2">
                      <Lock size={11} className="text-steppe-gold" /> Oturum Parolasi
                    </p>
                    <label className="flex items-center gap-1.5 cursor-pointer" title="Kapatirsaniz kimliginizi bilen herkes size baglanma istegi gonderebilir.">
                      <input
                        type="checkbox"
                        checked={requirePassword}
                        onChange={e => toggleRequirePassword(e.target.checked)}
                        className="w-3 h-3 accent-current"
                        style={{ accentColor: 'var(--accent-primary)' }}
                      />
                      <span className="text-[9px] uppercase tracking-widest text-steppe-muted">Zorunlu</span>
                    </label>
                  </div>
                  {requirePassword ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xl font-display tracking-[0.2em] text-steppe-gold select-all">{sessionPassword}</span>
                      <button
                        onClick={regenerateSessionPassword}
                        className="text-[9px] uppercase tracking-widest text-steppe-muted hover:text-steppe-gold border border-steppe-border hover:border-steppe-gold px-2 py-1 transition-colors"
                        title="Yeni parola uret"
                      >Yenile</button>
                    </div>
                  ) : (
                    <p className="text-[10px] text-yellow-400 leading-relaxed">
                      Parola kapali. Kimliginizi bilen herkes baglanti istegi gonderebilir.
                    </p>
                  )}
                </div>
                {isRegistered && sessionToken && (
                  <div className="mt-2 p-2 border border-steppe-border" style={{ background: 'var(--log-bg)' }}>
                    <p className="text-[8px] text-steppe-muted font-mono">SESSION: {sessionToken.slice(0,8)}...</p>
                    <p className="text-[8px] text-steppe-muted font-mono">FP: {deviceFingerprint.slice(0,8)}...</p>
                  </div>
                )}
              </div>

              <div className="gokturk-border p-6 surface-card">
                {isRegistered && !isEmailVerified && (
                  <div className="mb-4 p-3 border border-yellow-500/40 text-yellow-300 text-[10px]" style={{ background: 'rgba(234,179,8,0.08)' }}>
                    Hesabiniz dogrulanmamis. E-posta kutunuzu kontrol edin.
                  </div>
                )}
                <p className="text-[10px] uppercase tracking-widest text-steppe-muted mb-4 flex items-center gap-2"><Monitor size={12} className="text-steppe-gold" /> Uzak Masaustu Baglan</p>
                <input type="text" placeholder="HEDEF KIMLIK (Orn: 123-456-789)" className="input-field mb-3" value={targetId}
                  onChange={e => setTargetId(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && targetId.trim() && !isConnecting && rtcState !== 'connected') { if (!isRegistered && !isGuest) { setShowAuth(true); return; } handleConnect(); } }}
                />
                {/* Karsi tarafin ekraninda yazan oturum parolasi. Parola
                    zorunlulugunu kapatmis bir hedefe bos birakilabilir. */}
                <input type="text" placeholder="OTURUM PAROLASI" className="input-field mb-4 tracking-[0.2em] uppercase"
                  value={targetPassword} maxLength={12} autoComplete="off" spellCheck={false}
                  onChange={e => setTargetPassword(e.target.value.toUpperCase())}
                  onKeyDown={e => { if (e.key === 'Enter' && targetId.trim() && !isConnecting && rtcState !== 'connected') { if (!isRegistered && !isGuest) { setShowAuth(true); return; } handleConnect(); } }}
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
                {!isRegistered && !isGuest && <p className="text-[9px] text-steppe-muted mt-3 text-center">Giris yapin veya misafir olarak devam edin</p>}
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
                <div className={`px-4 py-2 border ${rtcState === 'connected' ? 'border-green-500/30' : rtcState === 'connecting' ? 'border-yellow-500/30' : 'border-red-500/30'}`}
                  style={{ background: rtcState === 'connected' ? 'rgba(34,197,94,0.05)' : rtcState === 'connecting' ? 'rgba(234,179,8,0.05)' : 'rgba(239,68,68,0.05)' }}>
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full animate-pulse ${rtcState === 'connected' ? 'bg-green-400' : rtcState === 'connecting' ? 'bg-yellow-400' : 'bg-red-400'}`} />
                    <span className="text-[10px] uppercase tracking-widest text-steppe-muted">
                      {rtcState === 'connected' ? `P2P Bagli - ${targetId}` : rtcState === 'connecting' ? 'Baglaniyor...' : 'Baglaniti Kesildi'}
                    </span>
                    {rtcState === 'connected' && <button onClick={handleDisconnect} className="ml-auto text-[9px] text-red-400 hover:text-red-300 uppercase tracking-widest">Kes</button>}
                  </div>
                  {rtcState === 'connected' && quality && (
                    <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--border-primary)' }}>
                      <QualityChips />
                    </div>
                  )}
                </div>
              )}

              {/* TURN yoksa kısıtlı ağlarda bağlantı hiç kurulamaz — sebebi
                  görünür olmalı, yoksa kullanıcı sadece "zaman aşımı" görür. */}
              {!turnAvailable && rtcState !== 'idle' && (
                <div className="px-4 py-2 border border-yellow-500/40 text-[9px] leading-relaxed text-yellow-300"
                  style={{ background: 'rgba(234,179,8,0.08)' }}>
                  Relay (TURN) sunucusu yapilandirilmamis. Kisitli aglarda (kurumsal guvenlik
                  duvari, mobil operator) baglanti kurulamayabilir.
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
                      <QualityChips compact />
                    </div>
                    <div className="absolute top-3 right-3 flex gap-2">
                      {EMBED.mode !== 'view' && (
                      <button
                        onClick={() => setInputEnabled(v => !v)}
                        className="px-2 py-1 text-[9px] uppercase tracking-widest rounded transition-colors"
                        style={{ background: inputEnabled ? 'var(--accent-primary)' : 'rgba(0,0,0,0.7)', color: inputEnabled ? '#000' : 'var(--text-muted)' }}
                        title="Klavye/fare kontrolünü aç-kapat"
                      >{inputEnabled ? 'Kontrol: AÇIK' : 'Kontrol'}</button>
                      )}
                      {/* Coklu monitor: yalnizca kontrol aciksa ve karsi tarafta
                          birden fazla ekran varsa gosterilir. */}
                      {remoteScreens.length > 1 && (
                        <select
                          value={currentRemoteScreen}
                          onChange={e => {
                            const id = e.target.value;
                            if (!id || !webrtc) return;
                            setCurrentRemoteScreen(id);
                            webrtc.sendControl({ k: 'screen-select', id });
                            addLocalLog('Ekran degisikligi istendi...', 'info');
                          }}
                          title="Karsi tarafta paylasilan ekrani degistir"
                          className="px-1 py-1 text-[9px] uppercase tracking-widest rounded border-0 outline-none"
                          style={{ background: 'rgba(0,0,0,0.7)', color: 'var(--text-muted)' }}
                        >
                          {remoteScreens.map(sc => (
                            <option key={sc.id} value={sc.id} style={{ background: '#111010' }}>{sc.name}</option>
                          ))}
                        </select>
                      )}
                      {EMBED.mode !== 'view' && (
                        <>
                          <button
                            onClick={sendClipboardToRemote}
                            className="px-2 py-1 text-[9px] uppercase tracking-widest text-steppe-muted hover:text-steppe-gold rounded"
                            style={{ background: 'rgba(0,0,0,0.7)' }}
                            title="Kendi panondaki metni karsi tarafin panosuna yaz (karsi tarafta kontrol izni gerekir)"
                          >Pano →</button>
                          <button
                            onClick={requestRemoteClipboard}
                            className="px-2 py-1 text-[9px] uppercase tracking-widest text-steppe-muted hover:text-steppe-gold rounded"
                            style={{ background: 'rgba(0,0,0,0.7)' }}
                            title="Karsi tarafin panosunu kendi panona al (karsi tarafta kontrol izni gerekir)"
                          >Pano ←</button>
                        </>
                      )}
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
                ) : (isConnecting || rtcState === 'connected') && rtcState !== 'idle' ? (
                  <div className="absolute inset-0">
                    <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-contain bg-black" />
                    <div className="absolute top-3 left-3 flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(0,0,0,0.7)' }}>
                      <div className={`w-2 h-2 rounded-full animate-pulse ${rtcState === 'connected' ? 'bg-green-400' : 'bg-yellow-400'}`} />
                      <span className={`text-[9px] uppercase tracking-widest ${rtcState === 'connected' ? 'text-green-400' : 'text-yellow-400'}`}>
                        {rtcState === 'connected' ? 'Ekran Paylasiliyor - Bagli' : 'Ekran Paylasiliyor - Baglaniliyor...'}
                      </span>
                      <QualityChips compact />
                    </div>
                    <div className="absolute top-3 right-3 flex gap-2">
                      {rtcState === 'connected' && (
                        <button
                          onClick={toggleRemoteControl}
                          className="px-2 py-1 text-[9px] uppercase tracking-widest rounded transition-colors"
                          style={{ background: remoteControlAllowed ? 'var(--accent-primary)' : 'rgba(0,0,0,0.7)', color: remoteControlAllowed ? '#000' : 'var(--text-muted)' }}
                          title="Karşı tarafın klavye/fare kontrolüne izin ver"
                        >{remoteControlAllowed ? 'Kontrol İzni: AÇIK' : 'Kontrol İzni'}</button>
                      )}
                      {rtcState === 'connected'
                        ? <button onClick={handleDisconnect} className="px-2 py-1 text-[9px] uppercase tracking-widest text-white rounded bg-red-500/80 hover:bg-red-500">Kes</button>
                        : <button onClick={handleCancelConnect} className="px-2 py-1 text-[9px] uppercase tracking-widest text-white rounded bg-red-500/80">Iptal</button>}
                    </div>
                    {remoteControlAllowed && rtcState === 'connected' && (
                      <div className="absolute bottom-3 left-3 flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(0,0,0,0.7)' }}>
                        <div className="w-2 h-2 rounded-full bg-steppe-gold animate-pulse" />
                        <span className="text-[9px] text-steppe-gold uppercase tracking-widest">Karsi taraf kontrol edebilir</span>
                        {controlNotice && (
                          <span className="text-[9px] uppercase tracking-widest pl-2 ml-1 border-l border-steppe-border text-yellow-400">{controlNotice}</span>
                        )}
                      </div>
                    )}
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
              {!isRegistered && !isGuest ? (
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

        {activeTab === 'contacts' && caps.savedContacts && (
          <div className="max-w-4xl mx-auto space-y-6">
            <h2 className="text-xl text-steppe-gold flex items-center gap-3"><Bookmark size={20} /> Kayitli Musteriler</h2>
            {entError && <div className="p-3 border border-red-500/40 text-red-400 text-[11px]">{entError}</div>}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Yeni kayıt */}
              <div className="gokturk-border surface-card p-5 space-y-3">
                <p className="text-[10px] uppercase tracking-widest text-steppe-muted flex items-center gap-2"><Plus size={12} className="text-steppe-gold" /> Yeni Musteri</p>
                <input className="input-field" placeholder="Kimlik (123-456-789 / acme-01)" value={scConnId} onChange={e => setScConnId(e.target.value)} />
                <input className="input-field" placeholder="Ad / etiket" value={scName} onChange={e => setScName(e.target.value)} />
                <select className="input-field" value={scCategory} onChange={e => setScCategory(e.target.value)}>
                  <option value="">Kategorisiz</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <textarea className="input-field" rows={2} placeholder="Not (opsiyonel)" value={scNotes} onChange={e => setScNotes(e.target.value)} />
                <button onClick={handleSaveContact} className="btn-primary w-full">Kaydet</button>

                <div className="pt-3 mt-2 border-t border-steppe-border">
                  <p className="text-[10px] uppercase tracking-widest text-steppe-muted flex items-center gap-2 mb-2"><Tag size={12} className="text-steppe-gold" /> Kategoriler</p>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {categories.length === 0 && <span className="text-[10px] text-steppe-muted italic">Kategori yok</span>}
                    {categories.map(c => (
                      <span key={c.id} className="text-[9px] uppercase tracking-widest px-2 py-1 flex items-center gap-1.5 border border-steppe-border" style={{ color: c.color }}>
                        <span className="w-2 h-2 rounded-full" style={{ background: c.color }} />{c.name}
                        <button onClick={() => handleDeleteCategory(c.id)} className="text-steppe-muted hover:text-red-400"><Trash2 size={10} /></button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input className="input-field flex-1" placeholder="Kategori adi" value={newCatName} onChange={e => setNewCatName(e.target.value)} />
                    <input type="color" className="w-9 h-9 bg-transparent border border-steppe-border cursor-pointer" value={newCatColor} onChange={e => setNewCatColor(e.target.value)} />
                    <button onClick={handleCreateCategory} className="btn-ghost px-3"><Plus size={14} /></button>
                  </div>
                </div>
              </div>

              {/* Liste */}
              <div className="lg:col-span-2 gokturk-border surface-card p-5">
                {savedContacts.length === 0 ? (
                  <div className="text-center py-16 text-steppe-muted italic text-sm">Henuz kayitli musteri yok. Soldan ekleyin.</div>
                ) : (
                  <div className="space-y-2">
                    {savedContacts.map(sc => {
                      const cat = categories.find(c => c.id === sc.category_id);
                      // Durum bilinmiyorsa (RPC yok / hiç okunmadı) nokta gösterilmez;
                      // "çevrimdışı" demek yanlış bilgi vermek olurdu.
                      const pres = presence.get(sc.connection_id);
                      return (
                        <div key={sc.id} className="flex items-center justify-between p-3 border border-steppe-border hover:border-steppe-gold transition-colors">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              {pres && (
                                <span
                                  title={pres.online
                                    ? 'Cevrimici'
                                    : pres.last_seen
                                      ? `Son gorulme: ${new Date(pres.last_seen).toLocaleString('tr-TR')}`
                                      : 'Cevrimdisi'}
                                  className={`w-2 h-2 rounded-full shrink-0 ${pres.online ? 'bg-green-400' : 'bg-steppe-muted opacity-40'}`}
                                />
                              )}
                              <span className="text-sm text-steppe-gold font-mono">{sc.connection_id}</span>
                              {sc.org_id && <span className="text-[8px] uppercase tracking-widest text-steppe-muted border border-steppe-border px-1">Kurumsal</span>}
                              {cat && <span className="text-[8px] uppercase tracking-widest px-1.5 py-0.5 flex items-center gap-1" style={{ color: cat.color }}><span className="w-1.5 h-1.5 rounded-full" style={{ background: cat.color }} />{cat.name}</span>}
                            </div>
                            {sc.display_name && <p className="text-[11px] text-steppe-paper truncate">{sc.display_name}</p>}
                            {sc.notes && <p className="text-[10px] text-steppe-muted truncate">{sc.notes}</p>}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button onClick={() => connectToContact(sc.connection_id)} className="btn-ghost text-[9px] py-1 px-3">Baglan</button>
                            <button onClick={() => handleDeleteContact(sc.id)} className="text-steppe-muted hover:text-red-400 p-1"><Trash2 size={13} /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'organization' && caps.organizations && (
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h2 className="text-xl text-steppe-gold flex items-center gap-3"><Building2 size={20} /> Kurumsal Yonetim</h2>
              {organizations.length > 0 && (
                <select className="input-field w-auto" value={activeOrgId ?? ''} onChange={e => setActiveOrgId(e.target.value || null)}>
                  {organizations.map(o => <option key={o.id} value={o.id}>{o.name} ({o.slug})</option>)}
                </select>
              )}
            </div>
            {entError && <div className="p-3 border border-red-500/40 text-red-400 text-[11px]">{entError}</div>}

            {/* Yeni firma */}
            <div className="gokturk-border surface-card p-5">
              <p className="text-[10px] uppercase tracking-widest text-steppe-muted flex items-center gap-2 mb-3"><Plus size={12} className="text-steppe-gold" /> Yeni Firma</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input className="input-field" placeholder="Firma adi" value={newOrgName} onChange={e => setNewOrgName(e.target.value)} />
                <input className="input-field font-mono" placeholder="slug (acme)" value={newOrgSlug} onChange={e => setNewOrgSlug(e.target.value.toLowerCase())} />
                <button onClick={handleCreateOrg} disabled={!newOrgName.trim() || !newOrgSlug.trim()} className="btn-primary disabled:opacity-40">Olustur</button>
              </div>
              <p className="text-[9px] text-steppe-muted mt-2">Cihazlar <span className="font-mono text-steppe-gold">{newOrgSlug || 'slug'}-01</span> gibi adreslenir.</p>
            </div>

            {activeOrg && (
              <>
                {/* Firma ayarları */}
                <div className="gokturk-border surface-card p-5 space-y-3">
                  <p className="text-[10px] uppercase tracking-widest text-steppe-muted mb-1">Firma Ayarlari · <span className="font-mono text-steppe-gold">{activeOrg.slug}</span></p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[9px] uppercase tracking-widest text-steppe-muted">Ad</label>
                      <input className="input-field mt-1" value={orgEditName} onChange={e => setOrgEditName(e.target.value)} disabled={!canManageOrg} />
                    </div>
                    <div>
                      <label className="text-[9px] uppercase tracking-widest text-steppe-muted">Logo URL</label>
                      <input className="input-field mt-1" placeholder="https://..." value={orgEditLogo} onChange={e => setOrgEditLogo(e.target.value)} disabled={!canManageOrg} />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {orgEditLogo && <img src={orgEditLogo} alt="logo" className="w-10 h-10 object-contain border border-steppe-border" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
                    {canManageOrg && <button onClick={handleSaveOrg} className="btn-primary">Kaydet</button>}
                    {activeOrg.owner_id === currentUser?.id && <button onClick={handleDeleteOrg} className="btn-ghost text-red-400 border-red-500/40">Firmayi Sil</button>}
                  </div>
                </div>

                {/* Üyeler / cihazlar */}
                <div className="gokturk-border surface-card p-5">
                  <p className="text-[10px] uppercase tracking-widest text-steppe-muted flex items-center gap-2 mb-3"><Users size={12} className="text-steppe-gold" /> Uyeler & Cihazlar</p>
                  {canManageOrg && (
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 mb-4">
                      <input className="input-field" placeholder="E-posta (operator)" value={memberEmail} onChange={e => setMemberEmail(e.target.value)} />
                      <input className="input-field font-mono" placeholder="cihaz etiketi (01)" value={memberLabel} onChange={e => setMemberLabel(e.target.value)} />
                      <select className="input-field" value={memberRole} onChange={e => setMemberRole(e.target.value as OrgRole)}>
                        <option value="operator">Operator</option>
                        <option value="admin">Yonetici</option>
                        <option value="member">Uye (cihaz)</option>
                      </select>
                      <button onClick={handleAddMember} className="btn-primary">Ekle</button>
                    </div>
                  )}
                  <div className="space-y-2">
                    {orgMembers.map(m => (
                      <div key={m.id} className="flex items-center justify-between p-3 border border-steppe-border gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[11px] text-steppe-paper truncate">{m.invited_email || (m.user_id === currentUser?.id ? 'Siz' : m.user_id?.slice(0,8)) || '—'}</span>
                            <span className="text-[8px] uppercase tracking-widest px-1.5 py-0.5 bg-steppe-gold/15 text-steppe-gold">{m.role}</span>
                            <span className={`text-[8px] uppercase tracking-widest px-1.5 py-0.5 ${m.status === 'active' ? 'text-green-400' : 'text-yellow-400'}`}>{m.status === 'active' ? 'Aktif' : m.status === 'invited' ? 'Davetli' : 'Pasif'}</span>
                            {m.device_label && <span className="text-[9px] font-mono text-steppe-gold">{activeOrg.slug}-{m.device_label}</span>}
                          </div>
                        </div>
                        {canManageOrg && (
                          <div className="flex items-center gap-2 shrink-0">
                            <input className="input-field w-20 text-[10px] py-1 font-mono" placeholder="etiket" defaultValue={m.device_label ?? ''} onBlur={e => { if (e.target.value !== (m.device_label ?? '')) handleMemberLabel(m.id, e.target.value.trim()); }} />
                            {m.role !== 'owner' && <button onClick={() => handleRemoveMember(m.id)} className="text-steppe-muted hover:text-red-400 p-1"><Trash2 size={13} /></button>}
                          </div>
                        )}
                      </div>
                    ))}
                    {orgMembers.length === 0 && <p className="text-[10px] text-steppe-muted italic text-center py-4">Uye yok.</p>}
                  </div>
                </div>
              </>
            )}
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
              <h3 className="text-[10px] uppercase tracking-widest text-steppe-muted mb-6 flex items-center gap-2"><Zap size={12} className="text-steppe-gold" /> Uygulama Guncelleme</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[11px] text-steppe-paper">Kurulu surum</p>
                    <p className="text-[9px] text-steppe-muted uppercase tracking-widest">{`Arku Remote v${__APP_VERSION__}`}</p>
                  </div>
                  {isElectron && (
                    <button onClick={handleCheckUpdates} disabled={updateChecking} className="btn-ghost px-5 py-2 disabled:opacity-40 whitespace-nowrap">
                      {updateChecking ? 'Kontrol ediliyor...' : 'Guncellemeleri Kontrol Et'}
                    </button>
                  )}
                </div>
                {updateCheck && (
                  <div className="p-3 border border-steppe-border text-[10px] text-steppe-muted" style={{ background: 'var(--surface-primary)' }}>
                    {updateCheckMessage(updateCheck)}
                  </div>
                )}
                <p className="text-[9px] text-steppe-muted">
                  {isElectron
                    ? 'Guncellemeler acilista ve 4 saatte bir otomatik kontrol edilir.'
                    : 'Web surumu her zaman gunceldir; sayfayi yenilemeniz yeterlidir.'}
                </p>
              </div>
            </section>
            <section className="gokturk-border surface-card p-8">
              <h3 className="text-[10px] uppercase tracking-widest text-steppe-muted mb-6 flex items-center gap-2"><User size={12} className="text-steppe-gold" /> Profil Bilgileri</h3>
              {isRegistered ? (
                <div className="space-y-4">
                  <div className="p-3 border border-steppe-border text-[10px] text-steppe-muted" style={{ background: 'var(--surface-primary)' }}><span className="text-steppe-gold">E-posta:</span> {currentUser?.email}</div>
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
                    style={{ background: 'var(--surface-primary)', color: 'var(--text-primary)' }}
                  >
                    {[5, 10, 15, 24, 30].map(fps => (
                      <option key={fps} value={fps} style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>{fps} FPS</option>
                    ))}
                  </select>
                </div>
              </div>
            </section>
            <section className="gokturk-border surface-card p-8">
              <h3 className="text-[10px] uppercase tracking-widest text-steppe-muted mb-6 flex items-center gap-2"><QrCode size={12} className="text-steppe-gold" /> QRtim Entegrasyonu</h3>
              {qrtimLinking ? (
                <div className="flex items-center gap-3 p-4 border border-steppe-border mb-4" style={{ background: 'var(--surface-primary)' }}>
                  <div className="w-2 h-2 rounded-full bg-steppe-gold animate-pulse" />
                  <p className="text-[10px] text-steppe-muted">QRtım hesabı bağlanıyor...</p>
                </div>
              ) : qrtimUser ? (
                <>
                  <div className="flex items-center justify-between p-4 border border-green-500/30 mb-4" style={{ background: 'rgba(34,197,94,0.05)' }}>
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-green-400" />
                      <div>
                        <p className="text-[11px] text-steppe-paper">{qrtimUser.name}</p>
                        <p className="text-[9px] text-steppe-muted">@{qrtimUser.username} · {qrtimUser.email}</p>
                      </div>
                    </div>
                    <span className="text-[9px] uppercase tracking-widest text-green-400 border border-green-400/30 px-2 py-1">Bağlı</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => window.open(qrtimUser.username ? `${QRTIM_BASE_URL}/card/${qrtimUser.username}` : `${QRTIM_BASE_URL}/dashboard`, '_blank')} className="btn-ghost flex items-center justify-center gap-2"><ExternalLink size={12} /> Kartı Gör</button>
                    <button onClick={handleQrtimDisconnect} className="py-3 border border-red-500/30 text-red-400 text-[10px] uppercase tracking-widest hover:bg-red-500/10 transition-all">Bağlantıyı Kes</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between p-4 border border-steppe-border mb-4" style={{ background: 'var(--surface-primary)' }}>
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-yellow-400" />
                      <div><p className="text-[11px] text-steppe-paper">QRtim Hesabi</p><p className="text-[9px] text-steppe-muted">Henuz baglanmadi</p></div>
                    </div>
                    <span className="text-[9px] uppercase tracking-widest text-yellow-400 border border-yellow-400/30 px-2 py-1">Bagli Degil</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => { window.open(`${QRTIM_BASE_URL}/signup?callback=${encodeURIComponent(qrtimCallbackUrl())}&source=arku`, '_blank'); }} className="btn-primary">Hesap Olustur</button>
                    <button onClick={handleQrtimConnect} className="btn-ghost">QRtım ile Bağla</button>
                  </div>
                  <p className="text-[9px] text-steppe-muted mt-3 text-center">QRtım hesabınız varsa "QRtım ile Bağla" butonuna tıklayın</p>
                </>
              )}
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
                  <div className="flex items-center gap-3 py-1"><div className="flex-1 h-px bg-steppe-border" /><span className="text-[9px] uppercase tracking-widest text-steppe-muted">veya</span><div className="flex-1 h-px bg-steppe-border" /></div>
                  <button onClick={handleQrtimLogin} className="w-full flex items-center justify-center gap-2 p-3 border border-steppe-gold/40 hover:border-steppe-gold hover:bg-steppe-gold/5 transition-all">
                    <QrCode size={14} className="text-steppe-gold" /><span className="text-[10px] uppercase tracking-widest text-steppe-gold">QRtım ile Giriş Yap</span>
                  </button>
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
        <p className="text-[9px] text-steppe-muted tracking-[0.3em] uppercase">2026 Arku Remote - TrendTech</p>
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
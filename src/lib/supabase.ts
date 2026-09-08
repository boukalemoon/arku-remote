import { createClient } from '@supabase/supabase-js';

// Public (anon) Supabase yapılandırması. Bu değerler tasarım gereği client'a
// gömülür ve her dağıtılan binary'de yer alır; RLS ile korunur. Ortam değişkeni
// yoksa (örn. CI build'i secret'sız çalıştığında) bu varsayılanlar kullanılır —
// böylece uygulama her zaman açılır, "createClient is required" çökmesi olmaz.
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string) || 'https://jpmbttlxyxrqmpghymbq.supabase.co';
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpwbWJ0dGx4eXhycW1wZ2h5bWJxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5NjU0NDgsImV4cCI6MjA5ODU0MTQ0OH0._zgdzPjHHfoeyzsFqDy7Bi2gz_YqBF_8vez_bgGBCvo';

// Edge function çağrılarında gateway `apikey` header'ı için (public anon key).
export const ARKU_ANON_KEY = SUPABASE_ANON_KEY;

// Edge function adreslerini tek yerden türetmek için (bkz. lib/ice.ts).
export const ARKU_FUNCTIONS_URL = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1`;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

export type LogType = 'info' | 'warn' | 'error' | 'sys';

export type ArkuPlan = 'free' | 'pro' | 'team' | 'business';

// arku_effective_subscription RPC'sinin döndürdüğü etkin abonelik özeti.
export interface Entitlements {
  plan: ArkuPlan;
  source: 'direct' | 'qrtim' | 'manual' | 'none';
  seats: number;
  is_org_member: boolean;
}

export const FREE_ENTITLEMENTS: Entitlements = { plan: 'free', source: 'none', seats: 1, is_org_member: false };

// Plan yeteneklerinin tek kaynağı. UI ve mantık bunu okur.
export function planCapabilities(plan: ArkuPlan) {
  return {
    savedContacts: plan !== 'free',              // kayıtlı müşteri ID'leri + kategori
    organizations: plan === 'team' || plan === 'business', // kurumsal (slug, logo, üyeler)
    customBranding: plan === 'business',         // logo + vanity slug
    multiOperator: plan === 'team' || plan === 'business',
  };
}

// Giriş yapmış kullanıcının etkin aboneliğini getirir (org üyeliği dahil en yüksek plan).
export async function fetchEntitlements(): Promise<Entitlements> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return FREE_ENTITLEMENTS;
  const { data, error } = await supabase.rpc('arku_effective_subscription', { p_uid: user.id });
  if (error || !data) return FREE_ENTITLEMENTS;
  return { ...FREE_ENTITLEMENTS, ...(data as Partial<Entitlements>) };
}

export interface UserProfile {
  id: string;
  email: string;
  display_name: string | null;
  phone: string | null;
  role: string;
  connection_id: string | null;
  device_fingerprint: string | null;
  last_seen: string | null;
  theme: string;
  created_at: string;
  qrtim_id: string | null;
  qrtim_username: string | null;
  qrtim_name: string | null;
  qrtim_email: string | null;
  qrtim_connected_at: string | null;
}

export interface LogEntry {
  id?: string;
  user_id: string;
  msg: string;
  type: LogType;
  created_at?: string;
}

export interface ConnectionEntry {
  id: string;
  caller_id: string;
  receiver_id: string;
  status: string;
  duration_seconds: number;
  created_at: string;
  ended_at: string | null;
}
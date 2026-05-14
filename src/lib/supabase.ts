import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

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
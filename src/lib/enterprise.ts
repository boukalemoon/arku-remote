// Arku Remote - Kurumsal + kayıtlı müşteri veri katmanı.
// Tüm erişim RLS ile korunur; bu fonksiyonlar yalnızca sorguları sarmalar.

import { supabase } from './supabase';

export type OrgRole = 'owner' | 'admin' | 'operator' | 'member';
export type MemberStatus = 'active' | 'invited' | 'disabled';

export interface Organization {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  subscription_id: string | null;
  created_at: string;
}

export interface OrgMember {
  id: string;
  org_id: string;
  user_id: string | null;
  role: OrgRole;
  device_label: string | null;
  invited_email: string | null;
  status: MemberStatus;
  created_at: string;
}

export interface ContactCategory {
  id: string;
  owner_id: string | null;
  org_id: string | null;
  name: string;
  color: string;
  created_at: string;
}

export interface SavedContact {
  id: string;
  owner_id: string | null;
  org_id: string | null;
  connection_id: string;
  display_name: string | null;
  category_id: string | null;
  notes: string | null;
  last_connected_at: string | null;
  created_at: string;
}

// slug: 3-32 karakter, küçük harf/rakam, tireyle ayrılabilir (baş/son harf-rakam)
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
export const isValidSlug = (s: string) => SLUG_RE.test(s);

// ── Organizasyonlar ─────────────────────────────────────────────────────────
export async function listMyOrganizations(): Promise<Organization[]> {
  const { data } = await supabase.from('organizations').select('*').order('created_at', { ascending: true });
  return (data as Organization[]) ?? [];
}

/**
 * Firma oluşturur.
 *
 * KURUCU ÜYELİĞİNİ SUNUCU YAZAR (trg_org_add_founder). Eskiden bunu istemci
 * yapıyordu ve RLS reddediyordu: organization_members ekleme politikası var
 * olan bir owner/admin ÜYELİĞİ arıyor, yeni firmada ise hiç üye yok. Dönen
 * hata da kontrol edilmediği için firma üyesiz kalıyor, owner bir daha hiç
 * üye ekleyemiyordu (açılış kilidi).
 * Gerekçe ve geri alma: supabase/migrations/20260912_org_owner_bootstrap.sql
 *
 * Migration henüz uygulanmadıysa kurucu üyeliği oluşmaz; bunu sessizce
 * geçmek yerine SÖYLÜYORUZ — aksi halde kullanıcı üye ekleyemediğinde
 * sebebini bulamıyor.
 */
export async function createOrganization(name: string, slug: string): Promise<{ org?: Organization; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Oturum gerekli' };
  if (!isValidSlug(slug)) return { error: 'Geçersiz slug (3-32, küçük harf/rakam/-)' };
  const { data, error } = await supabase.from('organizations')
    .insert({ owner_id: user.id, name, slug }).select().single();
  if (error) return { error: error.code === '23505' ? 'Bu slug zaten kullanımda.' : error.message };

  const org = data as Organization;
  // Trigger kurucuyu eklemiş olmalı. Doğrula: eklenmemişse eski şema demektir.
  const { data: founder } = await supabase.from('organization_members')
    .select('id').eq('org_id', org.id).eq('user_id', user.id).maybeSingle();
  if (!founder) {
    return {
      org,
      error: 'Firma açıldı ancak kurucu üyeliği oluşturulamadı; üye ekleyemezsiniz. '
        + 'Veritabanı güncellemesi (20260912_org_owner_bootstrap.sql) uygulanmalı.',
    };
  }
  return { org };
}

export async function updateOrganization(id: string, patch: Partial<Pick<Organization, 'name' | 'slug' | 'logo_url'>>): Promise<{ error?: string }> {
  if (patch.slug !== undefined && !isValidSlug(patch.slug)) return { error: 'Geçersiz slug' };
  const { error } = await supabase.from('organizations').update(patch).eq('id', id);
  if (error) return { error: error.code === '23505' ? 'Bu slug zaten kullanımda.' : error.message };
  return {};
}

export async function deleteOrganization(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.from('organizations').delete().eq('id', id);
  return error ? { error: error.message } : {};
}

// ── Üyeler / cihazlar ───────────────────────────────────────────────────────
export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const { data } = await supabase.from('organization_members')
    .select('*').eq('org_id', orgId).order('created_at', { ascending: true });
  return (data as OrgMember[]) ?? [];
}

export async function addOrgMember(orgId: string, opts: { invited_email?: string; role?: OrgRole; device_label?: string }): Promise<{ error?: string }> {
  const { error } = await supabase.from('organization_members').insert({
    org_id: orgId,
    invited_email: opts.invited_email ?? null,
    role: opts.role ?? 'member',
    device_label: opts.device_label ?? null,
    status: 'invited',
  });
  if (error) return { error: error.code === '23505' ? 'Bu etiket/üye zaten var.' : error.message };
  return {};
}

export async function updateOrgMember(id: string, patch: Partial<Pick<OrgMember, 'role' | 'device_label' | 'status'>>): Promise<{ error?: string }> {
  const { error } = await supabase.from('organization_members').update(patch).eq('id', id);
  if (error) return { error: error.code === '23505' ? 'Bu etiket zaten kullanımda.' : error.message };
  return {};
}

export async function removeOrgMember(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.from('organization_members').delete().eq('id', id);
  return error ? { error: error.message } : {};
}

// ── Kategoriler ─────────────────────────────────────────────────────────────
export async function listCategories(): Promise<ContactCategory[]> {
  const { data } = await supabase.from('contact_categories').select('*').order('name', { ascending: true });
  return (data as ContactCategory[]) ?? [];
}

export async function createCategory(name: string, color: string, orgId?: string): Promise<{ error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Oturum gerekli' };
  const row = orgId ? { org_id: orgId, name, color } : { owner_id: user.id, name, color };
  const { error } = await supabase.from('contact_categories').insert(row);
  return error ? { error: error.message } : {};
}

export async function deleteCategory(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.from('contact_categories').delete().eq('id', id);
  return error ? { error: error.message } : {};
}

// ── Kayıtlı müşteriler ──────────────────────────────────────────────────────
export async function listSavedContacts(): Promise<SavedContact[]> {
  const { data } = await supabase.from('saved_contacts').select('*').order('created_at', { ascending: false });
  return (data as SavedContact[]) ?? [];
}

export async function createSavedContact(input: {
  connection_id: string; display_name?: string; category_id?: string | null; notes?: string; orgId?: string;
}): Promise<{ error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Oturum gerekli' };
  const cid = input.connection_id.trim();
  if (!cid) return { error: 'Kimlik gerekli' };
  const row: Record<string, unknown> = {
    connection_id: cid,
    display_name: input.display_name || null,
    category_id: input.category_id || null,
    notes: input.notes || null,
  };
  if (input.orgId) row.org_id = input.orgId; else row.owner_id = user.id;
  const { error } = await supabase.from('saved_contacts').insert(row);
  return error ? { error: error.message } : {};
}

export async function updateSavedContact(id: string, patch: Partial<Pick<SavedContact, 'display_name' | 'category_id' | 'notes' | 'last_connected_at'>>): Promise<{ error?: string }> {
  const { error } = await supabase.from('saved_contacts').update(patch).eq('id', id);
  return error ? { error: error.message } : {};
}

export async function deleteSavedContact(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.from('saved_contacts').delete().eq('id', id);
  return error ? { error: error.message } : {};
}

// ── Çevrimiçi durum (presence) ──────────────────────────────────────────────
// users tablosunun RLS'i başkasının satırını vermez (PII koruması). Bu yüzden
// durum bilgisi yalnızca kimlik + son görülme döndüren bir RPC'den gelir.

export interface PresenceRow {
  connection_id: string;
  last_seen: string | null;
  online: boolean;
}

/**
 * Verilen kimliklerin çevrimiçi durumunu getirir.
 * RPC henüz uygulanmadıysa (eski şema) boş harita döner — arayüz durumu
 * "bilinmiyor" olarak gösterir, hiçbir şey bozulmaz.
 */
export async function fetchPresence(ids: string[]): Promise<Map<string, PresenceRow>> {
  const unique = Array.from(new Set(ids.filter(Boolean))).slice(0, 200);
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase.rpc('arku_presence', { p_ids: unique });
  if (error || !Array.isArray(data)) return new Map();
  return new Map((data as PresenceRow[]).map((r) => [r.connection_id, r]));
}

/**
 * Kendi son görülme zamanımızı güncelle (kalp atışı).
 * Karşı taraf bizim çevrimiçi olduğumuzu ancak böyle görebilir.
 */
export async function sendHeartbeat(userId: string): Promise<void> {
  await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', userId);
}

/**
 * Kullanıcının e-postasına açılmış kurumsal davetleri hesabına bağlar.
 * Bu çağrı olmadan admin'in eklediği cihaz etiketleri hiçbir zaman
 * çözümlenemez ve kurumsal vanity kimlik (acme-01) çalışmaz.
 * Bağlanan satır sayısını döndürür; RPC yoksa 0.
 */
export async function bindOrgInvites(): Promise<number> {
  const { data, error } = await supabase.rpc('arku_bind_org_invites');
  if (error || typeof data !== 'number') return 0;
  return data;
}

export async function touchSavedContact(connectionId: string): Promise<void> {
  // Bir kayıtlı kişiye bağlanınca son bağlantı zamanını güncelle (varsa)
  await supabase.from('saved_contacts')
    .update({ last_connected_at: new Date().toISOString() })
    .eq('connection_id', connectionId);
}

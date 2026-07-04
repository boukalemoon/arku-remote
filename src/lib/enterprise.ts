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

export async function createOrganization(name: string, slug: string): Promise<{ org?: Organization; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Oturum gerekli' };
  if (!isValidSlug(slug)) return { error: 'Geçersiz slug (3-32, küçük harf/rakam/-)' };
  const { data, error } = await supabase.from('organizations')
    .insert({ owner_id: user.id, name, slug }).select().single();
  if (error) return { error: error.code === '23505' ? 'Bu slug zaten kullanımda.' : error.message };
  // Kurucuyu owner üye olarak ekle
  await supabase.from('organization_members')
    .insert({ org_id: data.id, user_id: user.id, role: 'owner', status: 'active' });
  return { org: data as Organization };
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

export async function touchSavedContact(connectionId: string): Promise<void> {
  // Bir kayıtlı kişiye bağlanınca son bağlantı zamanını güncelle (varsa)
  await supabase.from('saved_contacts')
    .update({ last_connected_at: new Date().toISOString() })
    .eq('connection_id', connectionId);
}

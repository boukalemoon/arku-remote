/**
 * DataChannel mesaj şeması (denetim 2026-10-07, bulgular Y3 ve O5).
 *
 * Karşı taraftan gelen her JSON mesajı buradan geçer. Eskiden mesajlar
 * doğrudan `ControlMsg` / `InputEventMsg` türüne çevriliyordu; bir nesne
 * olarak gelen dosya adı React kökünü düşürüyor, sayı olmayan bir dosya
 * boyutu ise boyut sınırını devre dışı bırakıyordu.
 *
 * Kural: tanınmayan, eksik ya da sınır dışı her şey `null` döner ve atılır.
 * Bu modül tarayıcı ya da Node API'si kullanmaz; birim testleri Node ile
 * doğrudan çalışır (src/lib/dcschema.test.ts).
 */
import type { ControlMsg, InputEventMsg, RemoteScreen } from './webrtc.ts';

export const LIMITS = {
  id: 128,
  fileName: 255,
  /** 1 TiB — gerçek sınır (200/50 MB) webrtc.ts'te uygulanır. */
  fileSize: 2 ** 40,
  clipText: 1_000_000,
  consentVersion: 64,
  reason: 64,
  screens: 32,
  screenField: 256,
  key: 32,
  /** Tek wheel olayındaki piksel; main.cjs 100 piksel = 1 adım sayar. */
  wheel: 2000,
} as const;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const nonEmpty = (v: unknown, max: number): v is string => str(v, max) && v.length > 0;
const optStr = (v: unknown, max: number) => v === undefined || str(v, max);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Görüntülenecek adlardan denetim karakterlerini ve yön işaretlerini atar.
 * U+202E gibi karakterler `belge‮fdp.exe` adını `belgeexe.pdf` gibi gösterir.
 */
export function sanitizeDisplayName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').trim();
}

export function parseControlMsg(raw: unknown): ControlMsg | null {
  if (!isObj(raw) || typeof raw.k !== 'string') return null;
  const m = raw;
  switch (m.k) {
    case 'clip-req':
      return optStr(m.id, LIMITS.id) ? { k: 'clip-req', id: m.id as string | undefined } : null;
    case 'clip-set':
      return str(m.text, LIMITS.clipText) && optStr(m.id, LIMITS.id)
        ? { k: 'clip-set', text: m.text, id: m.id as string | undefined } : null;
    case 'screens-req':
      return { k: 'screens-req' };
    case 'screens': {
      if (!Array.isArray(m.list) || m.list.length > LIMITS.screens) return null;
      const list: RemoteScreen[] = [];
      for (const s of m.list) {
        if (!isObj(s) || !nonEmpty(s.id, LIMITS.screenField) || !str(s.name, LIMITS.screenField)) return null;
        list.push({ id: s.id, name: sanitizeDisplayName(s.name) });
      }
      if (!optStr(m.current, LIMITS.screenField)) return null;
      return { k: 'screens', list, current: m.current as string | undefined };
    }
    case 'screen-select':
      return nonEmpty(m.id, LIMITS.screenField) ? { k: 'screen-select', id: m.id } : null;
    case 'file-offer': {
      if (!nonEmpty(m.id, LIMITS.id) || !str(m.name, LIMITS.fileName * 4)) return null;
      const size = m.size;
      if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > LIMITS.fileSize) return null;
      const name = sanitizeDisplayName(m.name).slice(0, LIMITS.fileName);
      if (!name) return null;
      return { k: 'file-offer', id: m.id, name, size: size as number };
    }
    case 'file-accept':
    case 'file-reject':
    case 'file-end':
      return nonEmpty(m.id, LIMITS.id) ? { k: m.k, id: m.id } : null;
    case 'file-cancel':
      return nonEmpty(m.id, LIMITS.id) && optStr(m.reason, LIMITS.reason)
        ? { k: 'file-cancel', id: m.id, reason: m.reason as string | undefined } : null;
    case 'rec-request':
    case 'rec-accept':
      return nonEmpty(m.consentVersion, LIMITS.consentVersion)
        ? { k: m.k, consentVersion: m.consentVersion } : null;
    case 'rec-reject':
    case 'rec-started':
    case 'rec-stopped':
      return { k: m.k };
    default:
      return null;
  }
}

const clampWheel = (v: number) => Math.max(-LIMITS.wheel, Math.min(LIMITS.wheel, v));
const isButton = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 4;

export function parseInputEvent(raw: unknown): InputEventMsg | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  const e = raw;
  switch (e.type) {
    case 'mousemove':
      return finite(e.x) && finite(e.y) ? { type: 'mousemove', x: e.x, y: e.y } : null;
    case 'mousedown':
    case 'mouseup':
    case 'click':
      return isButton(e.button) && finite(e.x) && finite(e.y)
        ? { type: e.type, button: e.button, x: e.x, y: e.y } : null;
    case 'wheel':
      return finite(e.dx) && finite(e.dy) && finite(e.x) && finite(e.y)
        ? { type: 'wheel', dx: clampWheel(e.dx), dy: clampWheel(e.dy), x: e.x, y: e.y } : null;
    case 'keydown':
    case 'keyup':
      return str(e.key, LIMITS.key) && str(e.code, LIMITS.key)
        ? { type: e.type, key: e.key, code: e.code } : null;
    case 'release-all':
      return { type: 'release-all' };
    default:
      return null;
  }
}

/** DataChannel'dan gelen metni ayrıştırır; tanınmayan mesaj `null`. */
export function parseChannelText(text: unknown):
  | { kind: 'control'; msg: ControlMsg }
  | { kind: 'input'; msg: InputEventMsg }
  | null {
  if (typeof text !== 'string' || text.length > LIMITS.clipText + 1024) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (isObj(raw) && typeof raw.k === 'string') {
    const msg = parseControlMsg(raw);
    return msg ? { kind: 'control', msg } : null;
  }
  const ev = parseInputEvent(raw);
  return ev ? { kind: 'input', msg: ev } : null;
}

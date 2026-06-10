// Nexus (veya başka bir ana uygulama) içine iframe ile gömülme desteği.
//
// URL parametreleri:
//   embed=1            -> gömülü mod: Arku'nun kendi header/menüleri gizlenir
//   mode=control|view  -> control: klavye/fare enjeksiyonu açık; view: kapalı (sadece izleme)
//   session=<kod>      -> hedef bağlantı kodu (otomatik bağlanılır)
//   op=<ad>            -> operatör adı (loglama/etiketleme için)
//
// Çok kiracılı (multi-tenant): her müşteri kendi Nexus domaininde çalışır.
// postMessage hedef origin'i sabit değildir; bizi gömen ana sayfanın origin'i
// document.referrer'dan türetilir. Böylece hangi müşteri domaini gömerse
// mesajlar otomatik olarak ona gider, ekstra yapılandırma gerekmez.

export type EmbedMode = 'control' | 'view';
export type SessionEvent = 'connecting' | 'connected' | 'ended' | 'error';

export interface EmbedConfig {
  embed: boolean;
  mode: EmbedMode;
  session: string | null;
  op: string | null;
  /** postMessage hedef origin'i (bizi gömen ana sayfanın origin'i). */
  parentOrigin: string;
}

function detectParentOrigin(): string {
  // Önce referrer (bizi açan/gömen sayfa), olmazsa ancestorOrigins.
  try {
    if (document.referrer) return new URL(document.referrer).origin;
  } catch { /* yok say */ }
  try {
    const anc = (window.location as unknown as { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    if (anc && anc.length > 0) return anc[0];
  } catch { /* yok say */ }
  return '*';
}

function compute(): EmbedConfig {
  const p = new URLSearchParams(window.location.search);
  return {
    embed: p.get('embed') === '1',
    mode: p.get('mode') === 'view' ? 'view' : 'control',
    // Otomatik bağlanılacak hedef kimlik. Nexus firmaya tanımlı Arku ID'sini
    // `target` ile gönderir; `session` geriye dönük uyumluluk için alias.
    session: p.get('target') ?? p.get('session'),
    op: p.get('op'),
    parentOrigin: detectParentOrigin(),
  };
}

/** Sayfa yüklenirken bir kez hesaplanan sabit gömme yapılandırması. */
export const EMBED: EmbedConfig = compute();

let lastEvent: SessionEvent | '' = '';

/**
 * Oturum yaşam döngüsü olayını ana (parent) uygulamaya bildirir.
 * Yalnızca embed=1 modunda çalışır. Aynı olay art arda yinelenirse atlanır.
 */
export function postSessionEvent(event: SessionEvent, sessionId: string | null, mode: EmbedMode): void {
  if (!EMBED.embed) return;
  if (event === lastEvent) return; // yinelenen ardışık olayları atla (örn. çift 'ended')
  lastEvent = event;
  const message = {
    type: 'arku:session' as const,
    event,
    sessionId: sessionId ?? EMBED.session ?? null,
    mode,
    at: Date.now(),
  };
  try {
    window.parent?.postMessage(message, EMBED.parentOrigin);
  } catch { /* yok say */ }
}

/** Yeni bir bağlantı başlarken olay tekrarını sıfırlar. */
export function resetSessionEvents(): void {
  lastEvent = '';
}

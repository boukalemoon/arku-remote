// Arku Remote — sürüm karşılaştırma (zorunlu güncelleme kapısı için).
//
// Yalnızca "1.6.0" / "v1.6.0" biçimindeki üç parçalı sürümleri tanır.
// Ön sürüm eki ("-beta.1") ve derleme eki ("+abc") yok sayılır.

/** "v1.6.0" -> [1, 6, 0]; tanınmayan biçimde null. */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().replace(/^v/i, '').match(/^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:[-+].*)?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Kurulu sürüm, istenen en düşük sürümün ALTINDA mı?
 *
 * Biçimi bozuk bir değer (sunucuda yanlış yazılmış, boş) her zaman `false`
 * döner: zorunlu güncelleme kapısı hatalı bir yapılandırma yüzünden herkesi
 * kilitlememeli.
 */
export function isVersionBelow(current: unknown, minimum: unknown): boolean {
  const c = parseVersion(current);
  const m = parseVersion(minimum);
  if (!c || !m) return false;
  for (let i = 0; i < 3; i++) {
    if (c[i] !== m[i]) return c[i] < m[i];
  }
  return false;
}

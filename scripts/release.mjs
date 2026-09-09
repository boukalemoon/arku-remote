#!/usr/bin/env node
/**
 * Arku Remote — sürüm yayınlama yardımcısı.
 *
 * TEK KAYNAK: package.json (sürüm) + CHANGELOG.md (notlar).
 * Bu script o iki kaynaktan türeyen her yeri günceller, böylece web sitesi
 * ile uygulama sürümü birbirinden ayrı düşmez.
 *
 * Kullanım:
 *   node scripts/release.mjs sync         Sürümü web sitesine işle
 *   node scripts/release.mjs notes        CHANGELOG'dan güncel sürüm notunu yaz
 *   node scripts/release.mjs check        Tutarsızlık var mı (CI için, çıkış kodu)
 *
 * Web sitesindeki güncel sürüm alanları `data-arku-version` ile işaretlidir.
 * SÜRÜM GEÇMİŞİ bölümüne DOKUNULMAZ — orada eski sürüm numaraları kalmalı.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const sitePath = path.join(root, 'website', 'index.html');
const changelogPath = path.join(root, 'CHANGELOG.md');

const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;

/** CHANGELOG'dan verilen sürümün bölümünü çıkarır. */
function notesFor(v) {
  const md = readFileSync(changelogPath, 'utf8');
  // "## [1.1.0] — 2026-09-08" başlığından bir sonraki "## [" başlığına kadar.
  const re = new RegExp(`^## \\[${v.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^---\\s*$(?![\\s\\S]*?^## \\[))`, 'm');
  const m = md.match(re);
  if (!m) return null;
  return m[1].replace(/^---\s*$/gm, '').trim();
}

/**
 * `data-arku-version` taşıyan elemanların içindeki sürüm numarasını günceller.
 * Yalnızca işaretli alanlara dokunur; sürüm geçmişi bölümü korunur.
 */
function syncSite(write) {
  let html = readFileSync(sitePath, 'utf8');
  let hits = 0;
  const stale = [];
  html = html.replace(
    /(<[^>]*\bdata-arku-version\b[^>]*>)([\s\S]*?)(<\/[a-zA-Z]+>)/g,
    (whole, open, inner, close) => {
      const updated = inner.replace(/v\d+\.\d+\.\d+/g, (found) => {
        hits++;
        if (found !== `v${version}`) stale.push(found);
        return `v${version}`;
      });
      return open + updated + close;
    },
  );
  if (write) writeFileSync(sitePath, html);
  return { hits, stale };
}

const cmd = process.argv[2] ?? 'sync';

if (cmd === 'notes') {
  const notes = notesFor(version);
  if (!notes) {
    console.error(`HATA: CHANGELOG.md içinde [${version}] bölümü yok.`);
    process.exit(1);
  }
  process.stdout.write(notes + '\n');
} else if (cmd === 'check') {
  const problems = [];
  if (!notesFor(version)) problems.push(`CHANGELOG.md içinde [${version}] bölümü yok.`);
  const { hits, stale } = syncSite(false);
  if (hits === 0) problems.push('website/index.html içinde data-arku-version işaretli alan yok.');
  if (stale.length) problems.push(`Web sitesi eski sürümü gösteriyor: ${[...new Set(stale)].join(', ')} (beklenen v${version}).`);
  if (problems.length) {
    console.error('Sürüm tutarsizligi:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log(`Tutarli: v${version}, ${hits} alan, CHANGELOG bolumu mevcut.`);
} else if (cmd === 'sync') {
  const { hits, stale } = syncSite(true);
  console.log(`website/index.html: ${hits} alan v${version} olarak guncellendi.`);
  if (stale.length) console.log(`  (degistirilenler: ${[...new Set(stale)].join(', ')})`);
  if (!notesFor(version)) {
    console.warn(`UYARI: CHANGELOG.md icinde [${version}] bolumu yok — release notu bos kalir.`);
  }
} else {
  console.error('Bilinmeyen komut. Kullanim: sync | notes | check');
  process.exit(1);
}

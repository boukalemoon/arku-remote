# KVKK — İşlenen Veriler, Saklama Süreleri ve Kararların Gerekçesi

Bu belge Arku Remote'un **hangi kişisel veriyi neden işlediğini**, nerede
tuttuğunu ve ne kadar sonra sildiğini teknik gerçeğe sadık biçimde anlatır.
Aydınlatma metni ve veri işleme envanteri hazırlanırken buradaki tablo esas
alınmalıdır; kod değiştiğinde bu dosya da değişmelidir.

**Bu belge hukuki görüş değildir.** Teknik bir kayıttır: hangi verinin nereye
yazıldığını söyler, o veriyi işlemenin hukuki dayanağını sizin belirlemeniz
gerekir.

---

## 1. Temel mimari kararı: içerik sunucuya hiç gelmez

Arku'da ekran görüntüsü, ses, klavye/fare olayları, pano metni, aktarılan
dosyalar ve oturum kayıtları **iki cihaz arasında** akar (WebRTC, DTLS-SRTP).
Sunucu bunları görmez, saklamaz, saklayamaz — anahtar değişimi uçlar arasında
yapılır.

Sunucuya gelen tek şey **bağlantıyı kurmaya yeten üstveri** ve kullanıcının
kendi hesap bilgisidir. Aşağıdaki tablonun tamamı bundan oluşur.

TURN (relay) devreye girdiğinde trafik sunucu üzerinden **aktarılır** ama
şifreli geçer: relay paketleri iletir, içeriği açamaz.

---

## 2. İşlenen veriler

| Veri | Nerede | Neden | Saklama |
|---|---|---|---|
| E-posta, ad, telefon | `public.users` | Hesap kimliği, iletişim | Hesap silinene kadar |
| Bağlantı kimliği (`123-456-789`) | `public.users` | Karşı tarafın size ulaşması | Hesap silinene kadar |
| Cihaz parmak izi (tarayıcı özeti) | `public.users` | Oturum teşhisi | Hesap silinene kadar |
| Son görülme (`last_seen`) | `public.users` | "Çevrimiçi" göstergesi | Sürekli üzerine yazılır |
| Sinyalleşme (SDP + ICE adayları) | `public.signals` | Bağlantı kurulumu. **ICE adayları IP adresi içerir** | **5 dakika** (pg_cron) |
| Bağlantı geçmişi (kim, kime, süre) | `public.connections` | Kullanıcıya gösterilen oturum listesi | Kullanıcı silene kadar |
| Uygulama günlüğü | `public.logs` | Destek/teşhis | **90 gün** (pg_cron) |
| Denetim izi (olay, taraflar, rıza sürümü) | `public.session_audit` | İspat — aşağıda ayrı başlık | **Silinmez** (append-only) |
| Ziyaretçi analitiği (ülke, şehir, tarayıcı) | Firestore `arku_events` | Site istatistiği | Nexus tarafında tanımlı |
| Yorumlar (ad, unvan, metin, iletişim e-postası) | Firestore `arku_reviews` | Site referansları. E-posta **hiç yayımlanmaz** | Nexus tarafında tanımlı |

### İşlenmeyenler

Ekran içeriği · dosya içeriği · pano metni · tuş vuruşları · oturum kaydı
dosyası · ham IP adresi (analitikte) — hiçbiri sunucuya yazılmaz.

---

## 3. IP adresi

IP, bir kişiye bağlanabildiği anda kişisel veridir. İki yerde karşımıza çıkıyor
ve ikisi de ayrı ele alındı:

**Sinyalleşme (`signals`).** ICE adayları cihazın yerel ve genel IP adreslerini
içerir; bu, WebRTC'nin çalışması için zorunludur. Satırlar **5 dakika** sonra
`pg_cron` ile silinir (`arku-clean-signals`). Politikalar yalnızca bağlantının
taraflarının okumasına izin verir — üçüncü bir kullanıcı başkasının adaylarını
göremez.

**Site analitiği (`/api/track`).** Ham IP **saklanmaz**. Yerine günlük dönen,
gizli tuzlu bir özet yazılır (`ip_hash`): geri çevrilemez, ertesi gün eşleşmez,
tekil ziyaretçi sayımı yine çalışır. `ANALYTICS_IP_SALT` tanımlı değilse
**hiçbir IP türevi yazılmaz** — gizliliği koruyan güvenli varsayılan.

---

## 4. Denetim izi: silinemezlik ile silme hakkı

`public.session_audit` **append-only** bir hash zinciridir: kayıtlar
güncellenemez ve silinemez (yetki kaldırılmış, üstüne bir tetikleyici
reddediyor). Değeri buradan gelir — karşı taraf "sonradan yazılmış" diyemez.

Yazılanlar: olayın kendisi (oturum başlangıç/bitiş, kontrol izni, kayıt rızası),
tarafların kimlikleri, süre, **rıza metninin sürümü**, makine adı ve işletim
sistemi bilgisi.

### Bunun iki sonucu var, ikisi de yazılı olmalı

**1) Saklama süresi.** Tablo sonsuza kadar büyür. Bir süre belirlenmeli
(öneri: **10 yıl**, TTK'nın ticari defter saklama süresine paralel) ve süre
sonunda **satır silmek yerine dönem mühürlemesi** yapılmalı: zinciri kapatıp
arşivlemek, bütünlüğü bozmadan veriyi devreden çıkarmanın tek yolu.

**2) Silme talebi.** Bir ilgili kişi silme talep ettiğinde bu tablo teknik
olarak izin vermez — siz de silemezsiniz, tasarım gereği. Bu bir kusur değil
ama **bir tercih**, dolayısıyla dayanağı olmalı: KVKK m.28/1-(d) ve m.5/2-(e)
(bir hakkın tesisi, kullanılması veya korunması için veri işlemenin zorunlu
olması) bu tür ispat kayıtları için işletilen dayanaklardır. Aydınlatma
metninde "uzaktan erişim oturumlarına ilişkin ispat kayıtları şu süreyle
saklanır ve bu süre içinde silinemez" biçiminde **açıkça** yer alması gerekir.

### MAC adresi ve kullanıcı adı: varsayılan olarak KAPALI

MAC adresi zayıf bir delildir — saniyeler içinde değiştirilebilir ve Windows
10+ ile mobil cihazlarda Wi-Fi rastgeleleştirmesi varsayılan olarak açıktır.
Buna karşılık bir kişiye bağlanabildiği anda kişisel veridir ve toplanması
**ayrı bir işleme faaliyetidir**.

Bu yüzden MAC adresi ve işletim sistemi kullanıcı adı **varsayılan olarak
yazılmaz**. Kullanıcı Ayarlar → Denetim İzi altından açabilir; açtığında bunun
aydınlatma metninde yer alması gerektiği ekranda söylenir. Kaydın
çürütülemezliği zaten hash zincirinden gelir, MAC'ten değil.

---

## 5. Oturum kaydı

Kayıt **yalnızca iki taraf da onayladıktan sonra** başlar: izleyen taraf ister
(kendi rızası), ekranı paylaşan taraf onaylar (asıl veri sahibi o). Rıza
metninin sürümü mesajda taşınır ve denetim kaydına yazılır — kaydın hangi metne
dayandığı sonradan ispatlanabilsin.

Kayıt dosyası **bağlanan tarafın bilgisayarındaki bir klasöre** yazılır; Arku
sunucularına hiç gelmez. Kayıt süresince her iki ekranda "KAYIT" göstergesi
yanar.

**Dürüst sınır:** bu güvence bir **istemci sözleşmesidir**, kriptografik bir
garanti değil. Gelen görüntü akışı karşı tarafın ekranında olduğu için,
değiştirilmiş bir istemci (ya da basitçe bir ekran kaydı programı) onayı hiç
sormadan kayıt alabilir. Bu, mecranın doğasından gelir ve hiçbir uzak masaüstü
ürünü bunu engelleyemez. Arku'nun sağladığı şey, **kendi istemcisiyle alınan
kaydın rızaya dayandığının kayıt altında olmasıdır.**

---

## 6. Yurt dışına aktarım

| Hizmet | Ne gider | Not |
|---|---|---|
| Supabase | Hesap verisi, sinyalleşme, denetim izi | Proje bölgesi aydınlatma metninde belirtilmeli |
| Vercel | Web isteği üstverisi (IP, user-agent) | Barındırma |
| Google Firebase / Firestore | Site analitiği ve yorumlar | Nexus CRM tarafı |
| Google STUN (`stun.l.google.com`) | Bağlantı sırasında cihazın IP'si | Aşağıya bakın |

**Yazı tipleri artık Google'a gitmiyor.** Uygulama bir zamanlar Google Fonts'tan
yazı tipi çekiyordu; bu, her açılışta kullanıcının IP adresini Google'a açan bir
aktarımdı. Yazı tipleri v1.5.0 ile **uygulamanın içine** alındı (`src/fonts/`).

**STUN hâlâ Google'ın genel sunucularını kullanıyor.** NAT arkasındaki cihazın
genel adresini öğrenmesi için gereken tek istektir ve içerik taşımaz, ama IP'yi
Google'a gösterir. Kendi coturn sunucunuz zaten kuruluysa STUN'u da ona
yönlendirin (`STUN_URLS` secret'ı, bkz. `TURN_SETUP.md`) — o zaman bu aktarım
tamamen ortadan kalkar. **Kurumsal müşteri için önerilen yapılandırma budur.**

---

## 7. Misafir (anonim) kullanıcılar

Her istemci — misafir dahil — anonim bir oturum açar; bu, satır düzeyi
güvenliğin (RLS) her isteği bir kimliğe bağlaması için zorunludur. Misafirin
profili, geçmişi ve günlüğü **tutulmaz**.

Hiç bağlantı kurmamış ve denetim kaydı olmayan anonim hesaplar **30 gün** sonra
`pg_cron` ile silinir (`arku-purge-anon`). Bağlantı kurmuş veya denetim kaydı
olan hesaplara dokunulmaz — aksi halde ispat kaydının aktörü kaybolurdu.

---

## 8. Saklama sürelerini değiştirmek

Süreler tek yerde, `pg_cron` görevlerinde tanımlı:

```sql
select jobname, schedule, command from cron.job where jobname like 'arku-%';
```

| Görev | Ne siler | Süre | Dosya |
|---|---|---|---|
| `arku-clean-signals` | Sinyalleşme satırları | 5 dakika | `20260801_signals_ttl_cleanup_cron.sql` |
| `arku-clean-logs` | Uygulama günlüğü | 90 gün | `20260912_retention_cleanup.sql` |
| `arku-purge-anon` | Yetim anonim hesaplar | 30 gün | `20260912_retention_cleanup.sql` |

**Bu süreler aydınlatma metninizde yazılı olanla aynı olmalıdır.** Birini
değiştirdiğinizde diğerini de güncelleyin.

---

## 9. İlgili kişi talepleri — teknik karşılıkları

| Talep | Nasıl karşılanır |
|---|---|
| Erişim / bilgi | Ayarlar → Denetim İzi kendi kayıtlarını gösterir; hesap verisi `users` satırıdır |
| Düzeltme | Ayarlar → Profil (ad, telefon) |
| Silme | Hesap silindiğinde `users`, `logs`, `connections` **cascade** ile gider. `session_audit` GİTMEZ — §4'teki dayanak |
| İşlemeye itiraz | Oturum parolası zorunluluğu ve kontrol izni kullanıcının elindedir; izin verilmezse hiçbir şey işlenmez |
| Veri taşınabilirliği | Kayıtlı müşteri listesi ve bağlantı geçmişi Supabase'den dışa aktarılabilir |

---

**Son güncelleme:** 2026-09-12 (v1.5.0) · İlgili dosyalar:
`src/lib/audit.ts`, `supabase/migrations/20260909_session_audit_chain.sql`,
`supabase/migrations/20260912_retention_cleanup.sql`, `website/api/track.js`

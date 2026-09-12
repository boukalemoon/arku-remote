# Değişiklik Günlüğü

Bu dosya sürüm notlarının **tek kaynağıdır**. GitHub Release açıklaması ve web
sitesindeki sürüm bölümü buradan beslenir.

Biçim: [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) ·
Sürümleme: [Semantic Versioning](https://semver.org/lang/tr/)

---

## [1.5.0] — 2026-09-12

Kod tabanının tamamı (12.966 satır) satır satır denetlendi; çıkan 34 bulgunun
tamamı bu sürümde kapatıldı. Aşağıdakiler kullanıcıyı doğrudan etkileyenler.

### ⚠ Yükseltme notu

**İki taraf da v1.5.0 olmalı.** Oturum parolası artık düz metin
gönderilmiyor; v1.5.0 bir istemci v1.4.0 bir istemciyi aradığında karşı taraf
parolayı doğrulayamaz ve çağrı "parola hatalı" ile düşer. Ters yön (v1.4.0 →
v1.5.0) çalışmaya devam eder. Windows ve AppImage kurulumları otomatik
güncelleme aldığı için bu geçiş kendiliğinden tamamlanır.

**Veritabanı:** dört yeni migration var, ilki zorunlu. Sıra ve gerekçeler
`DEPLOYMENT.md` → "Veritabanı migration'ları" bölümünde.

### Düzeltildi

- **Kurumsal modül artık çalışıyor.** Firma açılıyor ama kurucu üyeliği
  veritabanı politikası tarafından reddediliyor, dönen hata da kontrol
  edilmediği için sessizce yutuluyordu: firma üyesiz kalıyor ve sahibi bir
  daha hiç üye ekleyemiyordu. Zincirleme etkisi, `acme-01` biçimindeki
  kurumsal kimliğin hiç çözümlenememesiydi. Kurucu üyeliğini artık sunucu
  yazıyor; bu hatayla açılmış mevcut firmalar migration ile onarılıyor.
- **Yazı tipleri uygulamanın içine alındı.** Web sürümünde içerik güvenlik
  politikası Google Fonts isteğini blokluyordu: arayüz sistem yazı tipine
  düşüyordu. Masaüstünde ise istek gerçekten gidiyor ve her açılışta
  kullanıcının IP adresi Google'a açılıyordu. İkisi de bitti; çevrimdışı
  kullanımda da doğru tipografi görünüyor.
- **"Kimliğiniz hazır" göstergesi artık doğruyu söylüyor.** Sunucu kimlik
  atayamadığında da yeşil yanıyordu; kullanıcı ekranda geçerli görünen bir
  numarayı karşı tarafa okuyor, ama o kimliğe hiçbir çağrı ulaşamıyordu.
  "Tekrar Dene" düğmesi de artık gerçekten kimliği yeniden istiyor.
- **Oturum kaydı artık kaybolmuyor.** Kayıt, durdurulana kadar tamamen
  bellekte tutuluyordu: bir saatlik kayıt ~1,8 GB RAM demek ve sekme çökerse
  kayıt tümüyle gidiyordu. Artık her parça anında diske yazılıyor. Alınan
  dosyalar için de aynı düzeltme yapıldı.
- **Çağrı çakışmasında bağlantı bozulması.** İki taraf aynı anda birbirini
  aradığında arayan tarafta bir istisna oluşuyor ve o turdaki diğer
  sinyaller de düşüyordu.
- **Panelde uydurma değerler kaldırıldı.** "Gecikme 4 ms" ölçüm değil sabitti,
  "Frankfurt" diye bir sunucu yok (mimari eşler arası), "AES-256" da yanlıştı.
  Üç kutu artık gerçek ölçümleri gösteriyor: şifreleme yöntemi, ölçülen
  gidiş-dönüş süresi ve bağlantı yolu (yerel ağ / P2P / relay).

### Güvenlik

- **Operatörün panosuna izinsiz yazma kapatıldı.** Karşı taraf, oturum
  boyunca istediği an operatörün panosundaki metni (IBAN, parola, komut)
  kendi metniyle değiştirebiliyordu. Artık yalnızca operatörün kendi
  isteğinin yanıtı kabul ediliyor; istenmemiş yazım reddedilip günlüğe
  düşüyor.
- **Çağrı kaçırma kapatıldı.** Kimliğinizi bilen biri, siz birini ararken
  araya girip meşru alıcıdan önce yanıt verebiliyor ve size taklit bir ekran
  gösterebiliyordu. Yanıtın sahipliği artık doğrulanıyor.
- **Oturum parolası düz metin gönderilmiyor.** Parola sinyalleşme tablosunda
  açıktan duruyordu; veritabanına erişen biri hem araya girebilir hem
  parolayı öğrenebilirdi. Artık yalnızca tekrar oynatılamaz bir kanıt gidiyor.
- **Tek pencere paylaşımından tüm ekrana geçiş artık onay istiyor.** Kontrol
  izni verdiğinizde karşı taraf, siz yalnızca bir pencere paylaşıyor olsanız
  bile sessizce tüm masaüstüne geçebiliyordu.
- **İki adımlı doğrulama (TOTP) eklendi.** Doğrulama ekranı vardı ama kayıt
  akışı hiç yoktu; özellik pratikte ulaşılamazdı. Ayarlar → Hesap Güvenliği
  altında QR kodla açılıyor.
- **Çıkış artık sunucudaki oturumu da iptal ediyor.** Yalnızca yerel jeton
  siliniyordu; ortak kullanılan bir makinede çıkış hiçbir şeyi
  değiştirmiyordu.
- **Parola en az 10 karakter** (eskiden 6). Bu hesap başkasının bilgisayarına
  bağlanma yetkisi taşıyor.
- **Plan sınırları artık sunucuda.** Ücretli özellikler yalnızca arayüzde
  gizliydi; doğrudan API çağrısıyla serbestçe kullanılabiliyordu. Koltuk
  sayısı da ilk kez zorlanıyor.
- **Kullanıcı kendi kimlik numarasını ve rolünü değiştiremiyor.** Kolon
  düzeyinde yetki kısıtı eklendi.
- **Abonelik sorgusu başkasının planını döndürmüyor.**
- Masaüstünde izin istekleri artık varsayılan olarak reddediliyor; QRtım
  askıda olduğu için gezinme izin listesi daraltıldı; TURN yapılandırmasına
  IPv6 iç ağ engelleme kuralları eklendi.
- **Otomatik güncelleme artık çıkışta sessizce kurulmuyor.** Paketler kod
  imzalı olmadığı için imza doğrulaması yapılamıyor; kurulum kullanıcı onayına
  bağlandı.
- `ws` ve `js-yaml` bağımlılıklarındaki yüksek öneme sahip uyarılar kapandı.

### KVKK

- **`KVKK.md` eklendi:** hangi verinin nereye yazıldığı, saklama süreleri,
  yurt dışı aktarımlar ve denetim izinin silinemezliğinin dayanağı.
- **Saklama süreleri tanımlandı.** Uygulama günlüğü 90 gün, hiç bağlantı
  kurmamış anonim hesaplar 30 gün sonra otomatik siliniyor. Sinyalleşme
  kayıtlarındaki 5 dakikalık süre zaten vardı.
- **MAC adresi ve kullanıcı adı artık varsayılan olarak kaydedilmiyor.**
  İkisi de kişisel veridir ve toplanmaları ayrı bir işleme faaliyetidir.
  Ayarlar → Denetim İzi altından açılabilir; açıldığında bunun aydınlatma
  metninde yer alması gerektiği söyleniyor.
- **Günlük hacmi düşürüldü.** WebRTC iç durumları (ICE, bağlantı durumu) artık
  sunucuya yazılmıyor, yerelde kalıyor.

### Değişti

- Boştaki uygulama artık sunucuyu yormuyor. Realtime bağlantısı sağlıklıyken
  yedek HTTP sorgusu durduruluyor; eskiden her istemci saniyede yaklaşık bir
  istek üretiyordu.
- Uygulama paketi parçalara ayrıldı (React / Supabase / arayüz kitaplıkları);
  güncellemelerde tarayıcı satıcı kodunu önbellekten kullanıyor.
- `DEPLOYMENT.md` baştan yazıldı — eski hâli Firebase, Socket.io ve Capacitor
  anlatıyordu; hiçbiri kullanılmıyor. Ölü dosyalar kaldırıldı
  (`firestore.rules`, `TODO.md`, `docs/`).

---

## [1.4.0] — 2026-09-09

### Sunucu tarafı (yayın sonrası, 2026-09-10)

Aşağıdaki değişiklikler yalnızca veritabanındadır; uygulama sürümünü
etkilemez, yeniden kurulum gerektirmez.

- Trigger fonksiyonları REST API yüzeyinden kaldırıldı. `arku_audit_chain`,
  `arku_signals_rate_limit`, `rls_auto_enable` ve diğer trigger fonksiyonları
  `/rest/v1/rpc/...` üzerinden çağrılabiliyordu. Doğrudan çağrılmaları zaten
  hata verir ama `SECURITY DEFINER` fonksiyonların genel API yüzeyinde
  durması gereksiz risktir.
- Üç fonksiyonda `search_path` sabitlendi.

### Güvenlik

- **Sinyalleşmeye hız sınırı.** Anonim giriş açık olduğu için sınırsız kimlik
  üretilip herhangi bir kimliğe sınırsız bağlantı denemesi yazılabiliyordu.
  Artık dakikada 400 sinyal ve 25 farklı hedef sınırı var. Devam eden bir
  oturum bu sınıra takılmaz; **kimlik taraması** ise durdurulur.
- **Analitikte IP adresi artık saklanmıyor.** IP, bir kişiye bağlanabildiği
  anda kişisel veridir. Yerine günlük dönen, gizli tuzlu bir özet yazılıyor:
  geri çevrilemez, ertesi gün eşleşmez, tekil ziyaretçi sayımı yine çalışır.
  Tuz tanımlı değilse hiçbir IP türevi saklanmaz.
- **Analitiğe hız sınırı.** `Origin`/`Referer` başlıkları taklit edilebildiği
  için sahte olay seli mümkündü (veri kirliliği + fatura). Ziyaretçi başına
  dakikada 60 olay sınırı eklendi.
- **Web dağıtımına içerik güvenlik politikası.** `default-src 'self'`,
  `object-src 'none'`, `base-uri 'none'` ve daraltılmış `connect-src`;
  ayrıca `X-Content-Type-Options` ve `Referrer-Policy`.
  > Masaüstü uygulamasına bilinçli olarak eklenmedi: `file://` origin'inde
  > CSP davranışı öngörülemez ve yanlış politika beyaz ekrana yol açar.
  > Orada koruma, ana süreçteki gezinme muhafızıdır (v1.1.0).

---

## [1.3.0] — 2026-09-09

### Eklendi

- **Denetim izi.** Oturum başlangıcı/bitişi, uzaktan kontrol izni, kayıt
  rızası ve kayıt başlangıcı/bitişi **değiştirilemez bir zincire** yazılır.
  Her kayıt bir öncekinin özetini (hash) taşır; bir kayıt silinse veya
  değiştirilse zincir kırılır ve doğrulama bunu gösterir.
  - Kayıtlar **güncellenemez ve silinemez** — yetki kaldırıldı, ayrıca
    veritabanı düzeyinde reddediliyor.
  - Özet **sunucuda** hesaplanır; istemci sahte zincir üretemez.
  - Kaydı üreten kullanıcı sunucuda belirlenir; kimse başkası adına
    denetim kaydı yazamaz.
  - Ayarlar → Denetim İzi altından kayıtlar görülebilir ve **zincirin
    sağlamlığı doğrulanabilir**.
- **Cihaz öznitelikleri** (makine adı, işletim sistemi, kullanıcı adı, MAC)
  oturum ve rıza kayıtlarına ekleniyor.
  > MAC adresi tek başına zayıf bir delildir: değiştirilebilir ve modern
  > sistemlerde Wi-Fi için rastgeleleştirilir. Ayrıca kişisel veridir ve
  > aydınlatma metninde yer almalıdır. Burada çapa değil, destekleyici
  > özniteliktir; kaydın asıl çürütülemezliği hash zincirinden gelir.

### Not

Denetim kaydına ekran görüntüsü, dosya içeriği, pano metni veya tuş
vuruşları **yazılmaz** — yalnızca olayın kendisi ve teknik öznitelikler.

---

## [1.2.0] — 2026-09-09

> Yayınlanmamış 1.1.0'ın tamamını içerir; 1.1.0 etiketi hiç yayına çıkmadı.

### Eklendi

- **Oturum kaydı.** Uzak masaüstü oturumunu videoya kaydedin ve sonradan
  izleyin. Kayıt **yalnızca iki taraf da onay verdiğinde** başlar: bağlanan
  taraf ister, ekranı paylaşan taraf onaylar. Kayıt süresince **iki ekranda
  da gösterge yanar** — sessiz kayıt yoktur. Her iki taraf da istediği an
  durdurabilir (onayın geri çekilmesi).
- Kayıt dosyası **Arku sunucularına hiç gitmez**; yalnızca kaydeden makinede
  seçilen klasöre yazılır. Klasör Ayarlar → Ekran Yakalama altından seçilir.
- Onay ekranında gösterilen rıza metninin **sürümü** karşı tarafa iletilir ve
  kayıtla birlikte tutulur; kaydın hangi metne dayandığı sonradan bellidir.

### Düzeltildi

- **Kimlik alınamadığında sessizce ulaşılamaz kalma.** Oturum açılamazsa
  uygulama yine geçerli görünen bir kimlik gösteriyordu; o kimliğe gelen
  hiçbir sinyal okunamadığı için kimse bağlanamıyor, iki taraf da sebebini
  öğrenemiyordu. Artık kimlik sunucuda kayıtlı değilse açıkça belirtiliyor.
- **Geçerli oturumun gereksiz kapatılması.** Oturum doğrulaması ağ hatası
  verdiğinde sağlam oturum kapatılıyordu (tarayıcı kalkanları bunu
  tetikleyebiliyor). Artık yalnızca sunucu kimliği açıkça reddederse kapatılır.
- **Bağlantı geç kopuyordu.** Kesme sinyali ulaşmadığında ekran 15–30 saniye
  donuk kalıyordu; artık 6 saniyede kapanıyor.
- **Hedef kimlik alanına UUID yazılması.** Gelen çağrıyı kabul eden taraf,
  kendi hedef kimlik kutusunda 9 haneli kimlik yerine uzun bir kimlik
  görüyordu.

### Güvenlik

- Kayıt klasörünü **arayüz belirleyemez**; yol yalnızca yerel klasör seçme
  penceresinden gelir ve ana süreçte saklanır. Dosya adı da ana süreçte
  üretilir.
- Talep edilmemiş bir "kayıt onayı" mesajı yok sayılır.

---

## [1.1.0] — 2026-09-08

Bağlantı kurulamama, yanlış yere tıklama ve bulanık görüntü şikâyetlerinin
kök nedenlerini kapatan büyük sürüm. Ayrıca oturum parolası, dosya transferi,
pano paylaşımı, çoklu monitör ve bağlantı doğrulama kodu eklendi.

### Eklendi

- **Oturum parolası.** Kimliğinizi bilen herkes artık size bağlanamaz. Her
  oturum için 6 karakterlik parola üretilir; yanlış parolayla arayan çağrı
  ekranda hiç görünmez. Zorunluluk kapatılabilir (varsayılan açık).
- **Bağlantı doğrulama kodu.** Bağlandığınızda iki ekranda 6 karakterlik bir
  kod görünür. Aynı değilse aranıza giren biri var demektir. Kod, iki tarafın
  DTLS sertifika parmak izinden türetilir.
- **Dosya transferi.** Karşı tarafa dosya gönderin (200 MB'a kadar). Alan
  taraf her zaman onay verir ve kaydedeceği yeri kendi seçer.
- **Pano paylaşımı.** Metni iki yönde aktarın. Uzak tarafın panonuza
  erişmesi, klavye/fare ile aynı izne bağlıdır.
- **Çoklu monitör.** Karşı tarafta birden fazla ekran varsa, oturumu kesmeden
  hangisinin paylaşıldığını değiştirin.
- **Bağlantı kalitesi göstergesi.** Bağlantının doğrudan mı (P2P) yoksa relay
  üzerinden mi gittiğini, gecikmeyi, bant genişliğini, çözünürlüğü ve paket
  kaybını canlı görün.
- **Çevrimiçi durumu.** Kayıtlı müşterilerinizin açık olup olmadığını listede
  görün.
- **TURN relay altyapısı.** Kısıtlı ağlardaki (kurumsal güvenlik duvarı,
  mobil operatör) cihazlara bağlantı artık mümkün.

### Düzeltildi

- **Kısıtlı ağlarda hiç bağlanılamıyordu.** Yayınlanan kurulumlar yalnızca
  STUN ile çıkıyordu; simetrik NAT, kurumsal güvenlik duvarı veya CGNAT
  arkasındaki cihazlara ulaşılamıyordu. TURN kimlik bilgisi artık sunucudan
  süreli olarak alınıyor.
- **Fare yanlış yere tıklıyordu.** Üç ayrı hata üst üste biniyordu:
  ekran ölçeklemesi (%125/%150 Windows dizüstülerinde tıklamalar hedefin
  üçte ikisine düşüyordu), çoklu monitörde her zaman birincil ekranın
  varsayılması, ve farklı en-boy oranlarında siyah bantların hesaba
  katılmaması.
- **Uzak ekran bulanıklaşıyordu.** Kodlayıcı ekran içeriğini hareketli video
  sanıp çözünürlüğü düşürüyordu; metin okunamıyordu. Artık çözünürlük
  korunuyor, gerekirse kare hızından veriliyor.
- **Klavye güvenilmezdi.** Odak yönetimi düzeltildi; sayısal tuş takımı
  operatörleri, NumLock, ScrollLock, Pause, PrintScreen ve menü tuşu eklendi.
  Alt+Tab sonrası uzak makinede tuş basılı kalması giderildi.
- **Uzaktan kontrol sessizce çalışmıyordu.** Girdi bileşeni yüklenemediğinde
  veya macOS Erişilebilirlik izni verilmediğinde arayüz "açık" görünüp
  hiçbir şey yapmıyordu. Artık sebep gösteriliyor.
- **Bazı bağlantılar sessizce kuruluyordu.** WebSocket engellenen ağlarda
  yedek yol, karşı tarafın farklı kimlikle verdiği yanıtı eliyordu.
- **Bağlantı geçmişi yanlıştı.** Her kayıt sonsuza kadar "aktif" ve 0 saniye
  kalıyordu. Artık bitiş zamanı ve süre yazılıyor.
- **Kimlik çakışması.** Bağlantı kimliği istemcide üretiliyordu ve
  çakışabiliyordu; çakışan kullanıcı kimliksiz, yani ulaşılamaz kalıyordu.
  Kimlik artık sunucuda üretiliyor. **Mevcut kimlikler değişmedi.**
- **Aynı imajla kurulmuş cihazlar aynı misafir kimliğini alıyordu.**
- Reddedilen veya yanlış parolalı çağrıdan 30 saniye sonra düşen yanıltıcı
  "yanıt vermedi" mesajı kaldırıldı.

### Güvenlik

- **QRtım entegrasyonu askıya alındı.** QRtım'in döndürdüğü e-posta
  doğrulanmadan kabul ediliyordu; aynı e-postaya sahip bir Arku hesabı
  devralınabilirdi. Hem arayüz hem sunucu tarafında kapatıldı.
- **Uygulama penceresi artık dışarıya gidemiyor.** Kötü niyetli bir
  yönlendirme, pencereyi ele geçirip pano okuma veya dosya yazma
  köprülerine erişebilirdi.
- Dış bağlantılar yalnızca `https` ile açılıyor.
- Alınan dosyanın adı `path.basename` ile temizleniyor (yol geçişi koruması).
- Uzaktan gelen girdi seline karşı sınırlama eklendi.
- Yeni veritabanı fonksiyonlarında oturumsuz (`anon`) erişim kapatıldı.

### Bilinen sınırlar

- Windows'ta yönetici (UAC) ekranı ve oturum açma ekranı görüntülenemez ve
  kontrol edilemez — bunun için Windows servisi gerekir.
- Uygulama kod imzalı değildir; ilk kurulumda SmartScreen uyarısı çıkar.
- Ses (mikrofon/sistem sesi) desteği yoktur.

---

## [1.0.16] — 2026-08-02

- Ana süreç çökmesi giderildi, oturum onayı geri getirildi.

## [1.0.15] — 2026-08-01

- Güvenlik sürümü: sinyalleşme kayıtları kimliğe bağlandı.

Daha eski sürümler: [GitHub Releases](https://github.com/boukalemoon/arku-remote/releases)

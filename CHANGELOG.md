# Değişiklik Günlüğü

Bu dosya sürüm notlarının **tek kaynağıdır**. GitHub Release açıklaması ve web
sitesindeki sürüm bölümü buradan beslenir.

Biçim: [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) ·
Sürümleme: [Semantic Versioning](https://semver.org/lang/tr/)

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

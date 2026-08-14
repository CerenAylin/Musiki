# 🎶 Musiki — YouTube Ses Ayrıştırıcı

YouTube videolarının sesini **vokal, davul, bas ve diğer enstrümanlara** ayırıp, video ile tam senkronize çalabilen ve Kandinsky Composition VIII tarzı görselleştirme sunan Chrome eklentisi & Python backend sistemi.

## ✨ Özellikler

- 🔬 **Demucs htdemucs** ile yüksek kaliteli 4 kanallı ses ayrıştırma
- 🎯 **CUDA/GPU** desteği — varsa otomatik kullanılır
- ⚡ **Önbellekleme** — aynı video tekrar işlenmez (SQLite)
- 🔄 **Tam senkronizasyon** — YouTube player ile birebir eşleşme
- 🎨 **Kandinsky** tarzı interaktif görselleştirme
- 🎚️ Kanal bazlı **volume/mute/solo** kontrolleri
- 📥 Her kanalı ayrı ayrı **WAV olarak indirme**
- 🎵 Davul pratikleri için ideal — davul kanalını kapatıp üzerine çalabilirsiniz!

---

## 📁 Proje Yapısı

```
musiki/
├── backend/
│   ├── main.py              # FastAPI sunucusu
│   ├── separator.py         # Demucs model yükleme & ayrıştırma
│   ├── downloader.py        # yt-dlp ile ses indirme
│   ├── database.py          # SQLite cache yönetimi
│   ├── requirements.txt     # Python bağımlılıkları
│   ├── stems/               # Ayrıştırılmış ses dosyaları (otomatik oluşur)
│   ├── downloads/           # Geçici indirme dosyaları (otomatik oluşur)
│   └── data/                # SQLite DB dosyası (otomatik oluşur)
├── extension/
│   ├── manifest.json        # Chrome Extension Manifest V3
│   ├── background.js        # Service Worker
│   ├── content.js           # Content Script (YouTube sayfası)
│   ├── inject.js            # Page context bridge (YT Player API)
│   ├── popup.html           # Kandinsky UI
│   ├── popup.css            # Stiller
│   ├── popup.js             # Popup mantığı & kontroller
│   ├── visualizer.js        # Canvas görselleştirme motoru
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
└── README.md
```

---

## 🚀 Kurulum

### 1. Python Backend

#### Tek Tıkla Kurulum & Çalıştırma (Önerilen)
Yazılım bilgisine ihtiyaç duymadan kullanabilmek için klasör içerisine otomatik başlatıcılar eklenmiştir:

1. İlk kullanımda ana dizindeki **`kurulum.bat`** dosyasına çift tıklayın. (Sanal ortamı oluşturup kütüphaneleri otomatik indirecektir, ekran kartı destekli PyTorch indirildiği için internet hızınıza göre 5-15 dk sürebilir).
2. Kurulum bittikten sonra müzik dinlemek istediğiniz her an **`baslat.bat`** dosyasına tıklamanız yeterlidir! (Siyah pencere arkada açık kalmalıdır).

#### Manuel Kurulum (Geliştiriciler İçin)
- Python 3.10+ ve FFmpeg kurulu olmalıdır.

```bash
cd musiki/backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

> **Not:** İlk çalıştırmada Demucs modeli indirilir (~300 MB). Bu sadece bir kez olur. Sunucu `http://localhost:8765` adresinde çalışacaktır.

### 2. Chrome Eklentisi

```
1. Chrome'da chrome://extensions adresine gidin
2. Sağ üst köşeden "Geliştirici modu"nu açın
3. "Paketlenmemiş öğe yükle" butonuna tıklayın
4. musiki/extension klasörünü seçin
5. Eklenti yüklendi! 🎉
```

---

## 🎮 Kullanım

1. **Backend'i başlatın**: Ana dizindeki `baslat.bat` dosyasına tıklayın.
2. **YouTube'da** bir müzik videosu açın.
3. Araç çubuğundaki **Musiki** ikonuna tıklayın.
4. **"Ayrıştır"** butonuna basın.
5. İşlem tamamlandığında:
   - Şarkı "Kütüphaneye kaydedildi" olarak gözükür (daha sonra kütüphane sekmesinden tekrar dinleyebilir veya silebilirsiniz).
   - Orijinal ses kapanır ve 4 kanal ayrı ayrı çalmaya başlar.
6. **Kontroller:**
   - 🔊 **Ana Ses & Çalma Kontrolleri:** Oynat/Duraklat (▶/⏸) ve İleri/Geri Sarma tuşları ile eklenti üzerinden YouTube'u direkt kontrol edin.
   - 🎚️ **Kanal Sesleri:** Volume slider'larla her kanalın sesini ayarlayın.
   - **M** butonu → kanalı sessize alır.
   - **S** butonu → sadece o kanalı solo çalar.
   - **↓** butonu → kanalın WAV dosyasını indirir.
   - **🗑️ Sil** butonu → veritabanından (kütüphaneden) gereksiz şarkıları temizler.
   - Canvas'taki animasyonlu şekillere tıklayarak kanalları pratikçe açıp kapatabilirsiniz.

---

## 🔌 API Endpoints

| Endpoint | Method | Açıklama |
|---|---|---|
| `/api/separate` | POST | Ses ayrıştırma başlat (body: `{"video_id": "..."}`) |
| `/api/status/{video_id}` | GET | İşlem durumu sorgula |
| `/api/download/{video_id}/{stem}` | GET | Stem dosyasını indir |
| `/api/cache` | GET | Tüm önbellek kayıtlarını listele |
| `/api/cache/{video_id}` | DELETE | Önbellek kaydını sil |
| `/api/health` | GET | Sunucu sağlık kontrolü |
| `/stems/{video_id}/{stem}.wav` | GET | Statik stem dosyası |

---

## ⚙️ Teknik Detaylar

### Ses Ayrıştırma
- **Model:** Demucs `htdemucs` (Meta/Facebook Research)
- **Çıktı:** 4 kanal — `vocals.wav`, `drums.wav`, `bass.wav`, `other.wav`
- **Format:** WAV (44.1kHz, stereo)
- **Optimizasyon:** `shifts=0`, `overlap=0.1` ile hız artışı

### Senkronizasyon
- `inject.js` YouTube Player API'ye doğrudan erişir
- 50ms aralıklarla `currentTime` ve `playerState` bilgisi okunur
- Drift > 150ms ise anında düzeltme yapılır
- Play/Pause/Seek olayları yakalanır

### Görselleştirme
- **Bas:** Konsantrik daireler (frekansa göre genişler)
- **Davul:** Dama tahtası + yarım daireler (kick'te titrer)
- **Vokal:** Atımlı noktalar (amplitude'a göre büyür)
- **Diğer:** Çizgi demetleri (harmoniye göre döner)

---

## ⚠️ Uyarılar

- Bu araç **yalnızca kişisel kullanım ve eğitim** amaçlıdır
- YouTube'dan ses indirmek YouTube Hizmet Şartlarına aykırı olabilir
- FFmpeg sisteminizde kurulu ve PATH'te olmalıdır
- GPU olmadan ayrıştırma 5+ dakika sürebilir

---

## 📜 Lisans

Bu proje eğitim amaçlı geliştirilmiştir.

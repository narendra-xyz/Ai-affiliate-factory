# AI Affiliate Factory

Sistem agentic AI untuk riset, produksi, pengujian, dan analisis konten
affiliate secara otomatis. Dirancang untuk berjalan stabil pada VPS
**8 GB RAM / 4 vCPU** dengan penggunaan resource efisien (target normal
2.5-4 GB RAM, peak maksimal ~6 GB RAM).

> Sistem ini membantu meningkatkan efisiensi riset, produksi, testing, dan
> analisis konten. Sistem **tidak menjamin** hasil finansial apa pun. Semua
> keputusan publikasi tetap harus mengikuti aturan platform affiliate dan
> platform sosial yang digunakan.

## Arsitektur

```
frontend/        Dashboard statis (HTML/CSS/JS, tanpa build step)
backend/
  server.js       Entry point Express
  config/         Koneksi DB + konfigurasi non-model per-agent
  db/             Schema SQLite + init/migrate script
  routes/         REST API endpoints
  middleware/     Auth (JWT), rate limiting, validasi input
  agents/         6 AI agent (modular, mudah menambah agent baru)
  services/       9Router client, video renderer, job queue, resource
                   monitor, finance calculator, command parser,
                   integration registry
  services/adapters/  Integration adapters: product data, trend data,
                   affiliate link, TTS, visual media, storage - setiap
                   adapter melapor "Not Configured" secara jujur jika
                   credential belum diisi, tidak pernah mengarang data
  utils/          Logger terpusat (agent_logs)
n8n/workflows/    Workflow orchestration siap import
storage/videos/   Video final tersimpan permanen di sini (local storage)
```

**Prinsip desain kunci:**
- **Tidak ada data yang dikarang.** Setiap agent yang butuh data eksternal
  (produk, trend, TTS, visual) memakai adapter di `services/adapters/`.
  Kalau integrasi belum dikonfigurasi, hasilnya adalah status
  `not_configured` yang jelas — bukan data palsu yang kelihatan asli.
- **Provider-agnostic**: semua panggilan AI lewat `backend/services/router.service.js`
  ke **9Router**. Model per-agent diatur lewat environment variable
  (lihat bagian "Manajemen model" di bawah), bisa dioverride runtime dari
  dashboard tanpa deploy ulang.
- **Video pipeline nyata**: `videoRenderer.service.js` mengorkestrasi
  TTS → visual → subtitle → FFmpeg → MP4 + thumbnail sungguhan, bukan
  cuma membuat record database. Lihat bagian "Video Pipeline" di bawah.
- **Job queue + concurrency limit** (`backend/services/queue.service.js`) agar
  VPS tidak overload; queue otomatis throttle jika RAM di atas soft limit.
- **Command Center aman**: perintah natural language hanya dipetakan ke daftar
  action yang sudah di-whitelist (`commandParser.service.js`) — sistem tidak
  pernah menjalankan shell command sembarangan dari input user.
- **n8n self-hosted** (Community Edition) sebagai orchestration layer opsional,
  berkomunikasi lewat HTTP API. Backend tetap jalan normal jika n8n mati.

## 6 AI Agent

| Agent | File | Fungsi |
|---|---|---|
| Product Hunter | `agents/productHunter.agent.js` | Ambil produk NYATA dari provider terkonfigurasi, AI hanya untuk scoring |
| Trend Hunter | `agents/trendHunter.agent.js` | Angle/hook, ditandai jujur apakah dari trend API nyata atau brainstorm AI |
| Script Writer | `agents/scriptWriter.agent.js` | Tulis variasi script faceless |
| Content Agent | `agents/contentAgent.js` | Render video NYATA (TTS+visual+subtitle+FFmpeg → MP4) |
| Critic Agent | `agents/criticAgent.js` | Evaluasi pakai frame video asli jika tersedia, fallback jujur ke metadata |
| Money Agent | `agents/moneyAgent.js` | Ranking berdasarkan profit/conversion, belajar dari data historis nyata |

## Menjalankan di VPS (8 GB RAM / 4 vCPU)

### 1. Prasyarat sistem
```bash
# Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

# FFmpeg (wajib - dipakai untuk render video)
sudo apt-get install -y ffmpeg

# espeak-ng (wajib jika TTS_PROVIDER=local_espeak, yaitu default/gratis)
sudo apt-get install -y espeak-ng
```
Tanpa `ffmpeg`, Content Agent tidak akan bisa render video sama sekali
(akan gagal dengan pesan jelas, bukan crash). Tanpa `espeak-ng` (dan tanpa
TTS eksternal dikonfigurasi), video juga tidak akan bisa dibuat — cek
`GET /api/system/integrations` untuk melihat status semua dependency ini.

### 2. Install dependencies Node
```bash
cd ai-affiliate-factory
npm install
```

### 3. Konfigurasi environment
```bash
cp .env.example .env
```
Edit `.env` — lihat komentar di setiap bagian file untuk penjelasan.
Minimal yang wajib diisi:
- `JWT_SECRET` — string acak panjang.
- `ADMIN_USERNAME` dan `ADMIN_PASSWORD_HASH` — generate hash dengan:
  ```bash
  node -e "console.log(require('bcryptjs').hashSync('password_anda',10))"
  ```
- `NINEROUTER_API_KEY`, `NINEROUTER_BASE_URL` — kredensial 9Router.
- `NINEROUTER_MODELS_<AGENT>` — model ID nyata untuk tiap agent (lihat
  bagian "Manajemen model" di bawah). Tanpa ini, agent terkait akan
  melapor "Not Configured", bukan crash.
- `PRODUCT_DATA_PROVIDER_URL` — **wajib** agar Product Hunter bisa jalan
  sama sekali. Tanpa ini, Product Hunter menolak mencari produk (sesuai
  desain — sistem tidak akan mengarang data produk).
- `N8N_WEBHOOK_TOKEN` — shared secret untuk komunikasi n8n → backend.

Integrasi lain (trend data, TTS eksternal, visual media, affiliate link
generator, publishing) semuanya opsional — sistem tetap jalan tanpanya,
dengan fallback yang jujur (lihat bagian "Integrasi & fallback" di bawah).

### 4. Inisialisasi database
```bash
npm run db:init
```
Ini membuat `backend/db/affiliate_factory.sqlite`, tabel-tabel sesuai
`backend/db/schema.sql`, menjalankan migrasi kolom tambahan (aman
dijalankan berulang), dan mengisi 6 baris agent default + pengaturan awal
(termasuk biaya server default Rp72.000/bulan).

Jika sebelumnya sudah pernah menjalankan versi lama sistem ini dan ingin
upgrade tanpa kehilangan data, cukup jalankan:
```bash
npm run db:migrate
```

### 5. Jalankan aplikasi
```bash
npm start
# atau untuk development dengan auto-restart:
npm run dev
```
Dashboard tersedia di `http://<ip-vps>:4000` (port sesuai `PORT` di `.env`).
Disarankan menjalankan di belakang reverse proxy (Nginx/Caddy) dengan HTTPS
untuk penggunaan production.

### 6. Jalankan sebagai service (disarankan: pm2)
```bash
npm install -g pm2
pm2 start backend/server.js --name ai-affiliate-factory
pm2 save
pm2 startup
```

### 7. (Opsional) n8n self-hosted
Install n8n secara terpisah (Docker atau npm) di VPS yang sama atau
terpisah, lalu ikuti panduan workflow di `n8n/workflows/README.md`. n8n
harus mengirim header `x-n8n-token` yang cocok dengan `N8N_WEBHOOK_TOKEN`
di `.env` saat memanggil endpoint `/api/n8n/*`.

## Video Pipeline (nyata, bukan simulasi)

`backend/services/videoRenderer.service.js` menjalankan langkah-langkah
berikut untuk setiap video, semuanya menghasilkan file nyata:

1. **TTS** (`adapters/tts.adapter.js`): teks script diubah jadi file WAV.
   Default pakai `espeak-ng` (gratis, offline, tanpa credential). Bisa
   diganti API eksternal via `TTS_PROVIDER=external`.
2. **Visual** (`adapters/visual.adapter.js`): kalau produk punya
   `image_url` nyata (dari Product Hunter), dipakai sebagai background.
   Kalau tidak, FFmpeg membuat kartu teks (warna solid + nama produk +
   hook) — real output FFmpeg, bukan gambar placeholder statis.
3. **Subtitle** (`adapters/subtitle.service.js`): file .srt nyata,
   waktunya proporsional terhadap durasi audio TTS asli.
4. **Render** (FFmpeg): video + audio + subtitle di-burn jadi satu MP4
   (`libx264` + `aac`), plus thumbnail JPEG diekstrak dari frame video.
5. **Storage** (`adapters/storage.adapter.js`): file final dipindah ke
   `storage/videos/` (permanen), file temporary dibersihkan otomatis.

Concurrency render dibatasi lewat `videoQueue` (`MAX_VIDEO_CONCURRENCY`
di `.env`) dan setiap render punya timeout keras (`RENDER_TIMEOUT_MS`,
default 3 menit) supaya satu render yang macet tidak mengunci VPS.

Video preview langsung bisa diputar dari halaman Video Detail di dashboard.

## Integrasi & fallback jujur

Halaman **Settings → Status Integrasi** (atau `GET /api/system/integrations`)
menampilkan status nyata setiap integrasi: `Configured` atau
`Not Configured`, beserta keterangan apa yang perlu diisi. Tidak ada
integrasi yang "kelihatan aktif" padahal belum dikonfigurasi.

| Integrasi | Wajib? | Fallback jika belum dikonfigurasi |
|---|---|---|
| 9Router (AI) | Ya | Agent terkait gagal dengan pesan jelas, tidak crash |
| Product data | Ya | Product Hunter menolak jalan (tidak mengarang produk) |
| Trend data | Tidak | Trend Hunter tetap jalan, hasil ditandai `ai_generated_heuristic` |
| TTS | Ya (default: espeak-ng lokal, gratis) | Video gagal dengan pesan jelas jika espeak-ng tidak terinstall |
| Visual media | Tidak | FFmpeg generate kartu teks otomatis |
| Affiliate link | Tidak | `affiliate_url` produk kosong sampai dikonfigurasi |
| Publishing | Tidak | Video berhenti di status `ready_to_publish`, publish manual |
| Object storage | Tidak (stub) | Video tersimpan permanen di disk lokal VPS |

## Manajemen model & biaya (prioritas: gratis dulu, tanpa biaya tambahan)

Setiap agent punya **pool model gratis berurutan**, diisi lewat
environment variable `NINEROUTER_MODELS_<NAMA_AGENT>` di `.env` (lihat
`.env.example`), bisa dioverride runtime dari dashboard Settings →
"Model per Agent". Tidak ada model ID yang di-hardcode di kode — kalau
env var kosong, agent tersebut jelas berstatus "Not Configured".

Alurnya:
1. Router selalu coba model gratis paling atas dalam daftar.
2. Jika model itu kena rate-limit/quota (terdeteksi dari response 429 atau
   pesan error terkait limit), model tersebut ditandai "limited" selama
   `MODEL_COOLDOWN_MINUTES` (default 30 menit) dan sistem **otomatis pindah
   ke model gratis berikutnya** dalam daftar — tanpa downtime, tanpa
   intervensi manual.
3. Sistem juga melacak jumlah pemakaian harian per model
   (`daily_limit`) dan melompat ke model berikutnya begitu limit
   harian tercapai, sebelum model itu benar-benar ditolak providernya.
4. Model berbayar **tidak pernah dipakai secara default**. Hanya aktif jika
   `allow_paid_fallback: true` diset untuk agent tersebut DAN semua model
   gratis di pool-nya sedang limit/exhausted.
5. Status tiap model (available/limited) terlihat langsung di dashboard
   Settings, dan bisa di-reset manual lewat endpoint
   `POST /api/agents/:name/model-config/:modelId/reset-limit` bila perlu.

## Atribusi biaya & profit per video/produk

`ai_usage` (biaya panggilan AI) ditandai dengan `script_id`/`video_id` saat
Critic Agent mengevaluasi script atau video tertentu. Dari situ:
- **Profit per video** = commission video tsb - biaya AI langsung yang
  terpakai untuk script & video itu (tidak termasuk porsi biaya server,
  karena itu biaya bersama yang tidak bisa dialokasikan per video).
- **Profit per produk** = total commission dari semua video produk itu -
  total biaya AI langsung dari semua script/video produk itu.
- **Ranking produk & video** (dashboard, halaman Products/Videos) diurutkan
  berdasarkan profit ini, bukan sekadar commission atau views mentah.

## Learning System

Money Agent menyimpan pola yang ditemukan (`winning_patterns` dan
`warnings`) ke tabel `learned_insights`, dan setiap kali menjalankan
analisis baru, insight-insight lama ikut dikirim ke model sebagai
konteks — supaya rekomendasi berikutnya membangun dari insight
sebelumnya, bukan mengulang analisis dari nol. Insight yang tersimpan
bisa dilihat di halaman Agents.

Money Agent juga membedakan dua jenis masalah:
- `analyze_failures` — video yang gagal secara teknis (render error, dll).
- `analyze_low_performers` — video yang berhasil publish tapi performanya
  buruk (traffic tinggi/konversi rendah) — masalah konten, bukan teknis.

Command "Buat variasi dari video terbaik" mengambil video dengan profit
tertinggi, lalu membuat video baru untuk produk yang sama dengan hook
yang terinspirasi dari video pemenang tersebut — menutup loop antara
data performa dan produksi konten berikutnya.

## Keamanan

- Semua API key disimpan di `.env` (tidak pernah dikirim ke frontend/dashboard).
- Dashboard dilindungi JWT auth (`/api/auth/login`).
- Rate limiting pada endpoint login, command center, dan API umum.
- Semua input divalidasi dengan `zod` sebelum masuk ke database atau agent.
- Command Center hanya menerjemahkan perintah ke action yang sudah
  di-whitelist — tidak pernah menjalankan shell command arbitrer.
- File video hanya bisa diakses lewat endpoint yang butuh JWT (baik lewat
  header maupun query token untuk elemen `<video>`/`<img>`), tidak ada
  folder video yang terbuka publik.

## TikTok Integration

Integrasi TikTok bersifat **modular dan opsional** - kalau tidak dikonfigurasi,
seluruh sistem (agent, n8n, 9Router, dashboard, video pipeline) tetap
berjalan normal seperti biasa. Menggunakan **API resmi TikTok saja**
(Login Kit untuk OAuth, Content Posting API untuk publish, Display API
untuk statistik) - tidak ada scraping, private endpoint, atau bypass
apapun.

### Setup
1. Daftar app di [developers.tiktok.com](https://developers.tiktok.com/),
   minta akses Login Kit + Content Posting API.
2. Isi di `.env`: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`,
   `TIKTOK_REDIRECT_URI` (harus persis sama dengan yang didaftarkan di
   TikTok), dan `TIKTOK_TOKEN_ENCRYPTION_KEY` (generate dengan
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
3. Buka **Settings > TikTok** di dashboard, klik "Connect TikTok
   Account", ikuti alur OAuth resmi TikTok.
4. Set salah satu akun sebagai "Autopilot" - itu yang dipakai Content
   Agent/Command Center saat publish tanpa akun spesifik disebut.

### Alur kerja
1. Video dengan status `approved` atau `ready_to_publish` bisa di-publish
   dari halaman Video Detail (tombol "Publish to TikTok" muncul otomatis
   kalau video sudah siap).
2. Publish berjalan via **Content Posting API** (metode FILE_UPLOAD -
   video di-upload langsung dari server, tidak perlu file publik
   diakses TikTok) melalui queue tersendiri (`MAX_TIKTOK_CONCURRENCY`,
   default 1) agar tidak bentrok dengan rendering video dan menghormati
   rate limit TikTok.
3. Setelah publish selesai, tersimpan: TikTok post ID, account ID, waktu
   publish, caption, product ID, video ID internal, dan status - semua di
   tabel `tiktok_publishes`, terlihat di halaman Video Detail.
4. Performance sync (otomatis tiap 30 menit, atau manual via tombol) ambil
   views/likes/comments/shares nyata dari TikTok dan masuk ke tabel
   `performance_metrics` yang sudah ada (ditandai `source='tiktok_api'`) -
   otomatis kebaca oleh Money Agent tanpa perubahan apapun di agent itu
   sendiri. Data klik/order/komisi affiliate tetap dari provider afiliasi
   terpisah (TikTok API tidak menyediakan data konversi affiliate).

### Keamanan token & permission
- Access/refresh token disimpan **terenkripsi** (AES-256-GCM) di database,
  tidak pernah dalam bentuk plaintext di mana pun.
- Token access di-refresh otomatis sebelum kedaluwarsa; kalau refresh
  token juga sudah expired, akun ditandai status `expired` dan minta
  disambungkan ulang manual.
- Setiap panggilan publish/analytics dicek dulu apakah akun punya scope
  yang dibutuhkan (`video.publish`, `video.list`) - kalau tidak ada,
  langsung dikasih pesan jelas ("permission belum tersedia"), bukan
  dicoba lalu gagal ambigu.

### Batasan yang jujur perlu diketahui
- **Publish ke publik** butuh app TikTok Anda sudah di-approve/audit oleh
  TikTok untuk scope `video.publish` dengan privasi publik. App yang
  belum diaudit hanya bisa publish dengan privasi `SELF_ONLY` (draft/
  private) - ini kebijakan TikTok, bukan batasan sistem ini.
- Adapter ini dibangun mengikuti dokumentasi resmi TikTok API v2 yang
  publik, tapi **belum pernah diuji terhadap app TikTok nyata** (sandbox
  pengembangan tidak punya akses jaringan). Endpoint/response API TikTok
  bisa berubah - verifikasi ke [dokumentasi TikTok](https://developers.tiktok.com/doc/)
  terkini sebelum production, dan uji alur OAuth/publish end-to-end
  dengan app TikTok Anda sendiri.

## TikTok Shop Integration (Shoppable Video)

Layer terpisah dari TikTok Integration biasa di atas - TikTok Shop
Partner Center adalah API/kredensial yang berbeda (app_key/app_secret
sendiri, endpoint di `open-api.tiktokglobalshop.com`, dan **wajib
request signing HMAC-SHA256** di setiap panggilan, tidak cukup Bearer
token saja). Modular sepenuhnya: kalau tidak dikonfigurasi, integrasi
TikTok biasa, agent, n8n, 9Router, dan video pipeline tetap berjalan
normal tanpa terpengaruh sama sekali.

### Setup
1. Daftar app di [TikTok Shop Partner Center](https://partner.tiktokshop.com/),
   minta akses API produk (`product.read`) dan video (`video.upload`).
2. Isi di `.env`: `TIKTOK_SHOP_APP_KEY`, `TIKTOK_SHOP_APP_SECRET`,
   `TIKTOK_SHOP_REDIRECT_URI` (harus persis sama dengan yang didaftarkan).
   `TIKTOK_TOKEN_ENCRYPTION_KEY` yang sudah ada dipakai ulang untuk
   enkripsi token Shop juga (tidak perlu key terpisah).
3. Buka **Settings > TikTok Shop**, klik "Connect TikTok Shop Creator",
   ikuti alur otorisasi resmi TikTok Shop.
4. Klik "Sync Produk" untuk ambil katalog produk TikTok Shop yang
   tersedia untuk creator/showcase Anda.
5. Di halaman **Product Detail** (produk internal), isi field "TikTok
   Shop Product ID" untuk menghubungkan produk affiliate dengan produk
   TikTok Shop yang sesuai.

### Alur kerja shoppable video
1. Video dengan status `approved`/`ready_to_publish` dan produk yang
   sudah di-mapping ke TikTok Shop product_id bisa di-publish sebagai
   shoppable video dari halaman Video Detail (section terpisah dari
   TikTok Publishing biasa).
2. Sebelum upload, sistem menjalankan **precheck shoppable content**
   (kalau endpoint-nya tersedia di app Anda) - kalau tidak tersedia,
   ditandai `not_available` dan proses tetap lanjut, bukan diblokir.
3. Video di-upload dengan `product_link_info` (product_id + tipe
   `PRODUCT_ANCHOR`) disertakan sejak awal request init, bukan sebagai
   langkah terpisah setelah upload selesai.
4. **Status video dan status attachment produk dilacak dan ditampilkan
   TERPISAH** (`video_status` vs `product_attachment_status`) - kalau
   video berhasil publish tapi produk gagal ter-attach, dashboard akan
   dengan jelas menunjukkan itu, bukan menampilkan "berhasil" begitu
   saja. Ini tersimpan di tabel `tiktok_shop_publishes` beserta TikTok
   video ID, request ID, dan alasan error untuk masing-masing status.
5. Webhook `POST /api/tiktok-shop/webhook/product-link-status` (dilindungi
   shared secret `TIKTOK_SHOP_WEBHOOK_SECRET`) menerima notifikasi async
   dari TikTok Shop kalau status attachment produk berubah setelah
   publish awal, dan meng-update `product_attachment_status` sesuai itu.

### Keamanan & permission
- Token TikTok Shop disimpan terenkripsi (reuse AES-256-GCM module yang
  sama dengan TikTok biasa), auto-refresh sebelum kedaluwarsa, akun
  ditandai `expired` kalau refresh token juga habis.
- Endpoint publish dan sync produk mengecek dulu apakah akun Shop
  terhubung dan produk sudah di-mapping sebelum mencoba - kalau belum,
  pesan errornya jelas ("belum di-mapping", "belum ada akun terhubung"),
  bukan dicoba lalu gagal ambigu.

### Batasan yang jujur perlu diketahui
- Produk akan muncul sebagai product anchor/keranjang produk **hanya
  jika akun, produk, permission, DAN API TikTok benar-benar mengizinkannya**
  - ini kebijakan/kondisi TikTok Shop, bukan sesuatu yang bisa dipaksakan
  dari sisi sistem ini.
- Skema request signing dan bentuk response API mengikuti dokumentasi
  publik TikTok Shop Partner Center yang tersedia saat integrasi ini
  ditulis, **belum pernah diuji ke app TikTok Shop nyata** (sandbox
  pengembangan tidak punya akses jaringan). TikTok Shop API punya variasi
  versi cukup sering - verifikasi endpoint, field response, dan algoritma
  signing terhadap [dokumentasi TikTok Shop](https://partner.tiktokshop.com/docv2)
  terkini sebelum production, dan uji alur precheck/upload/attach/webhook
  end-to-end dengan app Shop Anda sendiri sebelum mengandalkannya untuk
  publishing otomatis.

## n8n workflow siap import

Tiga workflow contoh sudah tersedia di `n8n/workflows/` dan bisa langsung
di-import ke n8n self-hosted:
- `daily-content-pipeline.json` — jalankan pipeline produksi video harian.
- `performance-sync.json` — sinkronisasi metrik performa dari platform.
- `resource-guard.json` — alert operator jika RAM di atas hard limit.

Backend tetap berjalan normal dan dashboard menampilkan badge
"n8n: disconnected" jika n8n mati — tidak ada dependensi keras ke n8n.

## Test end-to-end yang sudah diverifikasi

Video pipeline (TTS → visual → subtitle → FFmpeg → MP4 + thumbnail) sudah
diuji langsung dengan FFmpeg sungguhan selama pengembangan: menghasilkan
file MP4 valid (h264 + aac, 1080x1920) dan thumbnail JPEG valid, dengan
cleanup temporary file berjalan benar. Yang **belum** bisa diuji langsung
di lingkungan pengembangan (karena butuh credential/akses jaringan
sungguhan yang tidak tersedia saat pengembangan): panggilan nyata ke
9Router, provider data produk, dan provider TTS/trend eksternal — bagian-
bagian ini sudah diimplementasikan sesuai kontrak API standar (REST +
JSON, format OpenAI-compatible untuk 9Router) tapi disarankan diuji ulang
begitu credential asli tersedia.

## Status implementasi

Fungsional nyata (bukan placeholder): 6 agent, video render pipeline
lengkap, product data adapter, trend data adapter, TTS adapter (lokal +
eksternal), visual adapter, subtitle generator, storage lokal, integration
registry, command center dengan 11 action nyata, learning system
persisten, model fallback otomatis, dashboard lengkap dengan preview video.

Masih berupa stub yang jelas ditandai (bukan pura-pura selesai):
- Upload ke object storage S3-compatible (`storage.adapter.js`) — perlu
  ditambah SDK provider spesifik sebelum digunakan; sampai saat itu video
  final tetap tersimpan permanen di disk lokal VPS.
- Publishing otomatis ke platform (TikTok/YouTube/dll) — belum ada
  integrasi, video yang sudah `ready_to_publish` perlu dipublikasikan
  manual atau lewat workflow n8n tambahan yang Anda buat sendiri.
- Affiliate link generator otomatis — hanya jalan jika
  `AFFILIATE_LINK_GENERATOR_URL` dikonfigurasi; jika provider Anda sudah
  menyertakan `affiliate_url` langsung di data produknya, ini tidak
  diperlukan sama sekali.

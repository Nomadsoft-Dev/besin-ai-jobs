# besin-ai-jobs

Besin App için zamanlanmış yapay zekâ işleri. İlk iş: **Gemma ile günlük ürün veri denetimi.**

Her gün yeni ve verisi değişmiş ürünler Gemma 4 31B'ye gönderilir. Model; aynı maddenin iki kez
bağlanmasını (ör. iki ayrı "Ayçiçek Yağı" kaydı), içindekiler metniyle bağlı bileşenlerin
uyuşmamasını, fiziksel olarak imkânsız veya ürüne göre mantıksız besin değerlerini ve bozuk
içindekiler metnini bulur. Bulgular Supabase'e yazılır; **veritabanında hiçbir ürün otomatik
değiştirilmez.** Onaylanan düzeltmelerin SQL'i ayrıca üretilir ve elle çalıştırılır.

## Kurulum

1. Supabase SQL Editor'de sırayla [`sql/001-ai-jobs-product-audit.sql`](sql/001-ai-jobs-product-audit.sql)
   ve [`sql/002-ai-jobs-daily-start-and-exports.sql`](sql/002-ai-jobs-daily-start-and-exports.sql)
   dosyalarını çalıştır. `ai_jobs` şeması Data API'ye açık değildir; uygulama kullanıcıları erişemez.
2. `Nomadsoft-Dev/besin-ai-jobs` repo'sunu **public** oluştur ve bu klasörü `master` dalıyla push et.
   Public repo'da Actions dakikası sınırsızdır. Çalışma logları herkese açıktır; bu yüzden loglara
   yalnızca sayılar yazılır, bulgular ve düzeltme SQL'i yalnızca Supabase'e gider. Secret'lar
   public repo'da da gizli kalır.
3. Repo → Settings → Secrets and variables → Actions → **Secrets**:
   - `SUPABASE_DB_URL`: Supabase → Connect → **Session pooler** bağlantı dizesi (şifre dahil).
     GitHub makinelerinde IPv6 olmadığı için "Direct connection" çalışmaz.
   - `GEMINI_API_KEY` ve `GEMINI_API_KEY_2`: Google AI Studio → Get API key; iki ayrı projeden.
4. İsteğe bağlı **Variables** (aynı sayfada Variables sekmesi): `AUDIT_MODEL` (varsayılan
   `gemma-4-31b-it`), `AUDIT_DAILY_LIMIT` (`1000`), `AUDIT_MAX_MINUTES` (`90`),
   `AUDIT_KEY_CONCURRENCY` (`2`), `AUDIT_KEY_INTERVAL_MS` (`30000`).
5. İlk deneme: Actions → **Product audit** → Run workflow → `limit` = `20`. Bulgular
   `ai_jobs.product_audit_findings` tablosuna yazılır; ürünlere dokunulmaz.
6. Günlük başlatma için GitHub token'ını Supabase Vault'a koy (adımlar `002` dosyasının başında).

GitHub'da çalışan `dry_run` yalnızca bağlantıyı ve sayıları dener, bulguları göstermez. Bulguları
görmek için dry run'ı yerelde çalıştır (aşağıda Geliştirme).

Workflow'u GitHub'ın kendi zamanlayıcısı değil, Supabase (pg_cron) her gün 08:30 UTC'de (11:30
Türkiye) "bitene kadar devam et" seçeneğiyle başlatır. Önce hiç denetlenmemiş ürünler (yeniden
eskiye), sonra verisi değişmiş ürünler denetlenir. Verisi değişmeyen ürün tekrar denetlenmez.

## Elle çalıştırma

Actions → **Product audit** → Run workflow:

| Alan | Anlamı |
|---|---|
| Bitene kadar devam et | Her çalışma (`AUDIT_MAX_MINUTES`) bitince bir sonrakini başlatır. Denetlenecek ürün kalmayınca, Gemini art arda hata verince veya bir çalışma hiç ilerleyemeyince durur. İlk tam tarama için bunu işaretle. |
| İlk / son ürün ID'si | Yalnızca bu aralıktaki ürünler (ikisi de dahil). Boş = baştan / sona kadar. |
| Değişmemişleri de denetle | Aralıktaki daha önce denetlenmiş ve değişmemiş ürünleri de yeniden denetler. "Bitene kadar devam et" ile birlikte kullanılamaz. |
| limit | Tek çalışmada en fazla kaç ürün. Boş = `AUDIT_DAILY_LIMIT`; "bitene kadar" modunda sınır yok, süre belirler. |
| dry_run | Deneme: veritabanına yazmaz, public loga yalnızca sayılar yazılır. |

Çalışmalar üst üste binmez: biri sürerken başlatılan çalışma onun bitmesini bekler.

## Bulguları inceleme

Supabase → Table Editor → şema seçicide `ai_jobs` → `product_audit_findings`, filtre `status = open`.
Kolonlar soldan sağa karar vermek için gereken sırayla gelir; başka tabloya bakmak gerekmez.

| Alan | Anlamı |
|---|---|
| `status` | Kararını buraya yaz: `approved` veya `rejected`. İstersen `admin_note` ekle. |
| `product_name`, `brand_name` | Ürünün adı ve markası (denetim anındaki hâli) |
| `issue_type` | `duplicate_ingredient`, `missing_ingredient`, `extra_ingredient`, `nutrition_inconsistent`, `nutrition_implausible`, `bad_text`, `other` |
| `evidence`, `suggestion` | Modelin kısa kanıtı ve önerisi |
| `on_approve` | Onaylarsan ne olur. Ör. *SQL ile düzelir: "Kakao Kitlesi" (#55) bağlantısı silinir, "Kakao Kütlesi" (#56) kalır.* veya *Elle düzeltilir…* |
| `product_data` | Bulgunun ilgili olduğu veri: içindekiler metni ve bağlı bileşenler ya da 100 g besin değerleri |
| `ingredient_ids` | İlgili bileşen ID'leri. Tekrarda **ilk ID korunur**, diğerleri kaldırılır. |

Durumlar: `open` (inceleme bekliyor), `approved` (düzeltilecek), `rejected` (yanlış alarm),
`applied` (düzeltme SQL'i çalıştırıldı), `resolved` (ürün değişti ve sorun artık bulunmuyor).

Reddedilen bulgu, ilgili veri değişmediği sürece tekrar açılmaz. İlgili veri türe göre değişir:
besin bulgularında besin değerleri, metin ve eksik/fazla bileşen bulgularında içindekiler metni (ve
bağlı bileşenler), `other` için ad/marka/kategori. Bu veri değişip model yine sorun bulursa yeni bir
`open` satırı açılır. Tekrar bulgusu (`duplicate_ingredient`) aynı iki bileşen için hep reddedilmiş
kalır.

Günlük e-posta raporu (`besin-daily-digest`) bekleyen ve o gün açılan bulguları ürün adlarıyla
özetler.

## Onaylananları düzeltme

Actions → **Export approved fixes** → Run workflow. Sonuç Supabase → Table Editor → `ai_jobs` →
`product_audit_fix_exports` tablosuna yeni bir satır olarak yazılır (GitHub'da yalnızca sayılar
görünür):

- `fix_sql`: onaylı `duplicate_ingredient` ve `extra_ingredient` bulguları için tek transaction.
  Fazla bağlantıyı siler (tekrarda yüzde ve alerjen bağlantısını korunan kayda taşır), ürün
  puanını `calculate_product_score_new` ile yeniden hesaplar ve bulguyu `applied` yapar. Denetimden
  sonra bağlantıları değişmiş bulgular atlanır ve SQL'de yorum olarak belirtilir. Kopyala, gözden
  geçir ve SQL Editor'de çalıştır. SQL Editor'den almak için:
  `select fix_sql from ai_jobs.product_audit_fix_exports order by id desc limit 1;`
- `manual_list`: doğru değerin bir insan tarafından girilmesi gereken onaylı bulgular (besin değeri,
  metin, eksik bileşen). Düzelttikten sonra bulgunun `status` alanını `applied` yap.

Yerelde `npm run export-fixes` aynı satırı yazar ve ayrıca `output/fixes.sql` ile
`output/manual-findings.tsv` dosyalarını oluşturur.

## Limitler

- Gemma 4 31B ücretsiz kotası proje başına dakikada ~16K token; günlük istek limiti (14.400) sorun
  değildir. İki key ayrı projelerden olmalı. Her key aynı anda en fazla 2 istek taşır
  (`AUDIT_KEY_CONCURRENCY`) ve 30 saniyede bir yeni istek başlatır (`AUDIT_KEY_INTERVAL_MS`); bu,
  key başına dakikada ~8K token eder. Bir istek 10 ürün (~4K token) taşır ve Gemma'nın cevabı 1–4
  dakika sürebilir. 429 veya 500 hataları artarsa `AUDIT_KEY_CONCURRENCY=1` ve
  `AUDIT_KEY_INTERVAL_MS=65000` ile eski temkinli ayara dönülür. Google'ın geçici 500/503
  hatalarında istek artan bekleme süreleriyle tekrar denenir; art arda 3 grup başarısız olursa çalışma durur, kalan ürünler ertesi gün denenir.
  31B sürekli 500 döndürürse `AUDIT_MODEL=gemma-4-26b-a4b-it` ile daha küçük modele geçilebilir.
- `AUDIT_MAX_MINUTES` dolunca yeni grup başlamaz ve süre dolduktan sonra tekrar deneme yapılmaz;
  çalışma en geç ~6 dakika sonra kendiliğinden biter. Workflow adımı buna 20 dakika pay ekleyip
  takılan süreci durdurur. En fazla 330 dakika verilebilir (GitHub'ın 6 saatlik iş sınırı).
- Tüm katalogun (~8.300 ürün, ~830 istek) ilk taraması "bitene kadar devam et" ile art arda
  çalışmalarla tahminen 4–6 saat sürer. Public repo'da GitHub Actions dakikası harcanmaz.
  Sonrasında günde yalnızca yeni ve değişen ürünler denetlenir.

## Geliştirme

```bash
npm ci
npm test
```

Elle çalıştırmak için `.env.example` dosyasını `.env` olarak kopyala ve doldur:
`npm run audit -- --dry-run --limit 20` (bulguları ekrana ve `output/dry-run.json`'a yazar,
veritabanına yazmaz) veya `npm run export-fixes`.

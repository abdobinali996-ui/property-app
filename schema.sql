-- ============================================================
-- نظام إدارة الأملاك العقارية — مخطط قاعدة بيانات PostgreSQL
-- نفّذ هذا الملف مرة واحدة في Supabase: من SQL Editor الصق المحتوى واضغط Run
-- ============================================================

CREATE TABLE IF NOT EXISTS properties (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  address     TEXT DEFAULT '',
  owner_name  TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS units (
  id            SERIAL PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT DEFAULT 'شقة',
  floor         TEXT DEFAULT '',
  default_rent  NUMERIC(12,2) DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'شاغرة',  -- شاغرة / مؤجرة / صيانة
  notes         TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT DEFAULT '',
  id_number   TEXT DEFAULT '',
  email       TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contracts (
  id            SERIAL PRIMARY KEY,
  unit_id       INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  start_date    DATE NOT NULL,
  end_date      DATE,
  rent_amount   NUMERIC(12,2) NOT NULL,  -- إجمالي إيجار العقد لكامل مدته (لا قيمة القسط الواحد)
  cycle         TEXT NOT NULL DEFAULT 'monthly'
                CHECK (cycle IN ('monthly','quarterly','semiannual','annual')),
  installments_count INTEGER,  -- عدد الدفعات (اختياري: يُستنتج من المدة إن تُرك فارغاً)
  deposit       NUMERIC(12,2) DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',  -- active / ended
  notes         TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- للقواعد الموجودة مسبقاً: إضافة عمود عدد الدفعات
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS installments_count INTEGER;
-- الرصيد الافتتاحي: محصّل قبل استخدام البرنامج (يغطي أقدم الأقساط، ليس سند قبض)
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS opening_paid NUMERIC(14,2) NOT NULL DEFAULT 0;
-- زيادة مجدولة من خطاب زيادة: مبلغ سنوي جديد + تاريخ سريانه على الأقساط
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS increase_new_annual NUMERIC(14,2);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS increase_eff_date DATE;

-- تسلسل أرقام سندات القبض
CREATE SEQUENCE IF NOT EXISTS receipt_seq START 1;

CREATE TABLE IF NOT EXISTS payments (
  id            SERIAL PRIMARY KEY,
  contract_id   INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL,
  payment_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  method        TEXT NOT NULL DEFAULT 'تحويل',  -- نقداً / تحويل / شيك / شبكة
  purpose       TEXT DEFAULT 'إيجار',  -- مقابل السند: إيجار / خدمات / مياه / كهرباء / أخرى
  receipt_no    INTEGER NOT NULL DEFAULT nextval('receipt_seq'),
  notes         TEXT DEFAULT '',
  period_from   DATE,  -- بداية فترة السداد التي يغطيها السند (ميلادي دائماً)
  period_to     DATE,  -- نهاية فترة السداد التي يغطيها السند (ميلادي دائماً)
  created_by    TEXT DEFAULT '',  -- اسم مستخدم من أصدر السند
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_receipt_no_idx ON payments(receipt_no);
-- للقواعد الموجودة مسبقاً: إضافة عمودي فترة السداد
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_from DATE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_to DATE;
-- للقواعد الموجودة مسبقاً: من أصدر السند
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT '';
-- للقواعد الموجودة مسبقاً: غرض الدفعة (المقابل)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS purpose TEXT DEFAULT 'إيجار';
-- تحديث 59: سند «تصفية إيجار» بلا عقد — العقد اختياري، واسم الدافع والعقار على السند نفسه
ALTER TABLE payments ALTER COLUMN contract_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_name TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS property_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS unit_id INTEGER;

-- تسلسل أرقام سندات الصرف
CREATE SEQUENCE IF NOT EXISTS voucher_seq START 1;

CREATE TABLE IF NOT EXISTS expenses (
  id            SERIAL PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id       INTEGER REFERENCES units(id) ON DELETE SET NULL,
  category      TEXT NOT NULL DEFAULT 'صيانة',  -- صيانة / مرافق / عمولات / نظافة / أخرى
  amount        NUMERIC(12,2) NOT NULL,
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  description   TEXT DEFAULT '',
  payee         TEXT DEFAULT '',               -- اسم المستفيد (لسند الصرف)
  payment_method TEXT DEFAULT 'نقداً',          -- نقداً / تحويل بنكي / شبكة / شيك
  voucher_no    INTEGER DEFAULT nextval('voucher_seq'),  -- رقم سند الصرف
  created_by    TEXT DEFAULT '',               -- اسم مستخدم من أصدر السند
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS expenses_voucher_no_idx ON expenses(voucher_no);

-- للقواعد الموجودة مسبقاً: إضافة الأعمدة الجديدة وترقيم المصروفات القديمة بترتيب إنشائها
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voucher_no INTEGER;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payee TEXT DEFAULT '';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'نقداً';
WITH ranked AS (
  SELECT id, (SELECT COALESCE(MAX(voucher_no), 0) FROM expenses)
    + ROW_NUMBER() OVER (ORDER BY created_at, id) AS vn
  FROM expenses WHERE voucher_no IS NULL
)
UPDATE expenses e SET voucher_no = ranked.vn FROM ranked WHERE ranked.id = e.id;
SELECT setval('voucher_seq', COALESCE((SELECT MAX(voucher_no) FROM expenses), 1),
  (SELECT COUNT(*) FROM expenses WHERE voucher_no IS NOT NULL) > 0);
ALTER TABLE expenses ALTER COLUMN voucher_no SET DEFAULT nextval('voucher_seq');
-- للقواعد الموجودة مسبقاً: من أصدر سند الصرف
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT '';

-- حسابات دخول المستخدمين (تعدد المستخدمين والأدوار) — كلمات المرور مجزّأة بـ scrypt
-- بصيغة salt:hash ولا تُحفظ كنص صريح أبداً. المدير الرئيسي (ADMIN_USER/ADMIN_PASSWORD
-- من متغيرات البيئة) خارج هذا الجدول ويعمل دائماً كحساب إنقاذ.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL,             -- فريد دون حساسية لحالة الأحرف
  display_name  TEXT DEFAULT '',           -- الاسم الظاهر على السندات
  password_hash TEXT NOT NULL DEFAULT '',  -- salt:hash (scrypt)
  role          TEXT NOT NULL DEFAULT 'staff',  -- admin / staff
  active        BOOLEAN NOT NULL DEFAULT TRUE,  -- الإيقاف بدل الحذف حفاظاً على سجل التدقيق
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));

-- إعدادات المؤسسة/المكتب (تظهر في ترويسة السندات والكشوف)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,  -- company_name / company_address / company_phones / company_extra / company_logo (رابط بيانات Base64)
  value TEXT DEFAULT ''
);

-- قراءات عدادات الكهرباء والمياه للوحدات
CREATE TABLE IF NOT EXISTS meter_readings (
  id            SERIAL PRIMARY KEY,
  unit_id       INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  meter_type    TEXT NOT NULL DEFAULT 'electricity',  -- electricity / water
  reading_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  reading_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  notes         TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- المرفقات (صور ومستندات PDF) المرتبطة بمستأجر/عقد/سند قبض/سند صرف — المحتوى Base64
CREATE TABLE IF NOT EXISTS attachments (
  id          SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,  -- tenant / contract / payment / expense
  entity_id   INTEGER NOT NULL,
  filename    TEXT DEFAULT '',
  mime        TEXT DEFAULT '',  -- image/* أو application/pdf
  size        INTEGER NOT NULL DEFAULT 0,
  data_base64 TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_entity_idx ON attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS meter_readings_unit_idx ON meter_readings(unit_id);

-- سجل الحركات (التدقيق): إنشاء/تعديل/حذف الكيانات الأساسية مع ملخص عربي واسم المستخدم
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  actor       TEXT DEFAULT '',        -- اسم مستخدم المدير المنفّذ للحركة
  entity      TEXT NOT NULL DEFAULT '',  -- payments / expenses / contracts / tenants / properties / units / settings
  entity_id   INTEGER,
  action      TEXT NOT NULL DEFAULT '',  -- create / update / delete
  summary     TEXT DEFAULT '',        -- ملخص عربي مقروء يُبنى وقت الكتابة
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity);

-- النسخ الاحتياطية التلقائية: لقطة كاملة من البيانات بعد كل تغيير
-- (data = حمولة النسخة الاحتياطية JSON بنفس صيغة التصدير/الاستيراد)
CREATE TABLE IF NOT EXISTS backups (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger     TEXT NOT NULL DEFAULT 'auto',  -- auto / manual / pre-restore / pre-import
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL DEFAULT '{}',
  drive_status TEXT,  -- حالة رفع النسخة إلى Google Drive: synced / failed / NULL
  drive_error  TEXT,  -- سبب فشل الرفع (قصير) عند وجوده
  pinned      BOOLEAN NOT NULL DEFAULT FALSE  -- لقطة أمان مثبّتة (قبل استعادة/استيراد) تنجو مؤقتاً من الحذف
);
CREATE INDEX IF NOT EXISTS backups_created_idx ON backups(created_at);
ALTER TABLE backups ADD COLUMN IF NOT EXISTS drive_status TEXT;
ALTER TABLE backups ADD COLUMN IF NOT EXISTS drive_error TEXT;
ALTER TABLE backups ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS units_property_idx    ON units(property_id);
CREATE INDEX IF NOT EXISTS contracts_unit_idx    ON contracts(unit_id);
CREATE INDEX IF NOT EXISTS contracts_tenant_idx  ON contracts(tenant_id);
CREATE INDEX IF NOT EXISTS payments_contract_idx ON payments(contract_id);
CREATE INDEX IF NOT EXISTS expenses_property_idx ON expenses(property_id);

-- لوحة الإعلانات العامة (تحديث ٣٩)
CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY, title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'إيجار',
  price NUMERIC(14,2) NOT NULL DEFAULT 0, area_name TEXT DEFAULT '', size_m2 NUMERIC(10,2),
  rooms INTEGER, baths INTEGER, floor TEXT DEFAULT '', description TEXT DEFAULT '',
  owner_name TEXT DEFAULT '', phone TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', featured BOOLEAN NOT NULL DEFAULT FALSE,
  views INTEGER NOT NULL DEFAULT 0, wa_clicks INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS listings_status_idx ON listings(status);

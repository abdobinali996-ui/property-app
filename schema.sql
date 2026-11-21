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

-- تسلسل أرقام سندات القبض
CREATE SEQUENCE IF NOT EXISTS receipt_seq START 1;

CREATE TABLE IF NOT EXISTS payments (
  id            SERIAL PRIMARY KEY,
  contract_id   INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL,
  payment_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  method        TEXT NOT NULL DEFAULT 'تحويل',  -- نقداً / تحويل / شيك / شبكة
  receipt_no    INTEGER NOT NULL DEFAULT nextval('receipt_seq'),
  notes         TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_receipt_no_idx ON payments(receipt_no);

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

CREATE INDEX IF NOT EXISTS units_property_idx    ON units(property_id);
CREATE INDEX IF NOT EXISTS contracts_unit_idx    ON contracts(unit_id);
CREATE INDEX IF NOT EXISTS contracts_tenant_idx  ON contracts(tenant_id);
CREATE INDEX IF NOT EXISTS payments_contract_idx ON payments(contract_id);
CREATE INDEX IF NOT EXISTS expenses_property_idx ON expenses(property_id);

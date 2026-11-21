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
  rent_amount   NUMERIC(12,2) NOT NULL,
  cycle         TEXT NOT NULL DEFAULT 'monthly'
                CHECK (cycle IN ('monthly','quarterly','semiannual','annual')),
  deposit       NUMERIC(12,2) DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',  -- active / ended
  notes         TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS expenses (
  id            SERIAL PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id       INTEGER REFERENCES units(id) ON DELETE SET NULL,
  category      TEXT NOT NULL DEFAULT 'صيانة',  -- صيانة / مرافق / عمولات / نظافة / أخرى
  amount        NUMERIC(12,2) NOT NULL,
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  description   TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS units_property_idx    ON units(property_id);
CREATE INDEX IF NOT EXISTS contracts_unit_idx    ON contracts(unit_id);
CREATE INDEX IF NOT EXISTS contracts_tenant_idx  ON contracts(tenant_id);
CREATE INDEX IF NOT EXISTS payments_contract_idx ON payments(contract_id);
CREATE INDEX IF NOT EXISTS expenses_property_idx ON expenses(property_id);

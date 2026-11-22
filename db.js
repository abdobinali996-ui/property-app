'use strict';
// طبقة البيانات: PostgreSQL (Supabase) عند وجود DATABASE_URL،
// وإلا مخزن ملف JSON محلي للتجربة والتشغيل بدون قاعدة بيانات.
const fs = require('fs');
const path = require('path');

const TABLES = {
  properties: ['name', 'address', 'owner_name', 'notes'],
  units: ['property_id', 'name', 'type', 'floor', 'default_rent', 'status', 'notes'],
  tenants: ['name', 'phone', 'id_number', 'email', 'notes', 'contract_no'],
  contracts: ['unit_id', 'tenant_id', 'start_date', 'end_date', 'rent_amount', 'cycle', 'installments_count', 'deposit', 'status', 'notes'],
  payments: ['contract_id', 'amount', 'payment_date', 'method', 'purpose', 'notes', 'period_from', 'period_to', 'created_by', 'edited_at', 'edit_count', 'deleted_at'],
  expenses: ['property_id', 'unit_id', 'category', 'amount', 'expense_date', 'description', 'payee', 'payment_method', 'created_by'],
  meter_readings: ['unit_id', 'meter_type', 'reading_value', 'reading_date', 'notes'],
};

const ATTACHMENT_TYPES = ['tenant', 'contract', 'payment', 'expense'];
const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];
const ATTACHMENT_MAX = 3 * 1024 * 1024;

const SETTING_KEYS = ['company_name', 'company_address', 'company_phones', 'company_extra', 'company_logo'];

const usePg = !!process.env.DATABASE_URL;
let pool = null;

if (usePg) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// إنشاء الجداول تلقائياً عند أول تشغيل (نفس محتوى schema.sql)
const DDL = `
CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '',
  owner_name TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS units (
  id SERIAL PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT DEFAULT 'شقة', floor TEXT DEFAULT '', default_rent NUMERIC(12,2) DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'شاغرة', notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '', id_number TEXT DEFAULT '',
  email TEXT DEFAULT '', notes TEXT DEFAULT '', contract_no TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contract_no TEXT DEFAULT '';
CREATE TABLE IF NOT EXISTS contracts (
  id SERIAL PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  start_date DATE NOT NULL, end_date DATE, rent_amount NUMERIC(12,2) NOT NULL,
  cycle TEXT NOT NULL DEFAULT 'monthly', deposit NUMERIC(12,2) DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS installments_count INTEGER;
CREATE SEQUENCE IF NOT EXISTS receipt_seq START 1;
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL, payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  method TEXT NOT NULL DEFAULT 'تحويل', receipt_no INTEGER NOT NULL DEFAULT nextval('receipt_seq'),
  notes TEXT DEFAULT '', period_from DATE, period_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_from DATE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_to DATE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS purpose TEXT DEFAULT 'إيجار';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS edit_count INTEGER DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'صيانة', amount NUMERIC(12,2) NOT NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE, description TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE SEQUENCE IF NOT EXISTS voucher_seq START 1;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voucher_no INTEGER;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payee TEXT DEFAULT '';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'نقداً';
-- ترقيم المصروفات القديمة التي بلا رقم سند صرف، بترتيب إنشائها
WITH ranked AS (
  SELECT id, (SELECT COALESCE(MAX(voucher_no), 0) FROM expenses)
    + ROW_NUMBER() OVER (ORDER BY created_at, id) AS vn
  FROM expenses WHERE voucher_no IS NULL
)
UPDATE expenses e SET voucher_no = ranked.vn FROM ranked WHERE ranked.id = e.id;
SELECT setval('voucher_seq', COALESCE((SELECT MAX(voucher_no) FROM expenses), 1),
  (SELECT COUNT(*) FROM expenses WHERE voucher_no IS NOT NULL) > 0);
ALTER TABLE expenses ALTER COLUMN voucher_no SET DEFAULT nextval('voucher_seq');
CREATE UNIQUE INDEX IF NOT EXISTS expenses_voucher_no_idx ON expenses(voucher_no);
CREATE TABLE IF NOT EXISTS meter_readings (
  id SERIAL PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  meter_type TEXT NOT NULL DEFAULT 'electricity', reading_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  reading_date DATE NOT NULL DEFAULT CURRENT_DATE, notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
  filename TEXT DEFAULT '', mime TEXT DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
  data_base64 TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS attachments_entity_idx ON attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS meter_readings_unit_idx ON meter_readings(unit_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY, actor TEXT DEFAULT '', entity TEXT NOT NULL DEFAULT '',
  entity_id INTEGER, action TEXT NOT NULL DEFAULT '', summary TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity);
CREATE TABLE IF NOT EXISTS backups (
  id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger TEXT NOT NULL DEFAULT 'auto', size_bytes INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS backups_created_idx ON backups(created_at);
ALTER TABLE backups ADD COLUMN IF NOT EXISTS drive_status TEXT;
ALTER TABLE backups ADD COLUMN IF NOT EXISTS drive_error TEXT;
ALTER TABLE backups ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, username TEXT NOT NULL, display_name TEXT DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'staff',
  active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT '';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT '';
`;

// ---------------- مخزن JSON المحلي ----------------
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let mem = null;

function loadMem() {
  if (mem) return mem;
  try {
    mem = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    mem = { seq: {}, receipt_seq: 0, voucher_seq: 0, settings: {}, properties: [], units: [], tenants: [], contracts: [], payments: [], expenses: [], audit_log: [], users: [], backups: [] };
  }
  for (const t of Object.keys(TABLES)) {
    if (!Array.isArray(mem[t])) mem[t] = [];
    if (!mem.seq) mem.seq = {};
    if (!mem.seq[t]) mem.seq[t] = mem[t].reduce((m, r) => Math.max(m, r.id || 0), 0);
  }
  if (!mem.receipt_seq) mem.receipt_seq = (mem.payments || []).reduce((m, r) => Math.max(m, r.receipt_no || 0), 0);
  if (!mem.settings || typeof mem.settings !== 'object') mem.settings = {};
  if (!Array.isArray(mem.attachments)) mem.attachments = [];
  if (!mem.seq.attachments) mem.seq.attachments = mem.attachments.reduce((m, r) => Math.max(m, r.id || 0), 0);
  if (!Array.isArray(mem.audit_log)) mem.audit_log = [];
  if (!mem.seq.audit_log) mem.seq.audit_log = mem.audit_log.reduce((m, r) => Math.max(m, r.id || 0), 0);
  if (!Array.isArray(mem.users)) mem.users = [];
  if (!mem.seq.users) mem.seq.users = mem.users.reduce((m, r) => Math.max(m, r.id || 0), 0);
  if (!Array.isArray(mem.backups)) mem.backups = [];
  if (!mem.seq.backups) mem.seq.backups = mem.backups.reduce((m, r) => Math.max(m, r.id || 0), 0);
  for (const b of mem.backups) if (b.pinned === undefined) b.pinned = false; // لقطات قديمة بلا علم التثبيت
  // تسلسل سندات الصرف: ترقيم المصروفات القديمة التي بلا رقم، بترتيب إنشائها
  const maxVoucher = (mem.expenses || []).reduce((m, r) => Math.max(m, r.voucher_no || 0), 0);
  if (!mem.voucher_seq || mem.voucher_seq < maxVoucher) mem.voucher_seq = maxVoucher;
  for (const e of [...(mem.expenses || [])].sort((a, b) => (a.id || 0) - (b.id || 0))) {
    if (e.payee === undefined) e.payee = '';
    if (e.payment_method === undefined) e.payment_method = 'نقداً';
    if (!e.voucher_no) e.voucher_no = ++mem.voucher_seq;
  }
  // دفعات قديمة بلا غرض: تُعامل وتُخزَّن كإيجار (الافتراضي)
  for (const p of mem.payments || []) {
    if (!p.purpose) p.purpose = 'إيجار';
  }
  return mem;
}

function saveMem() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(mem, null, 1), 'utf8');
}

// ---------------- واجهة موحّدة ----------------
async function init() {
  if (usePg) {
    await pool.query(DDL);
  } else {
    loadMem(); saveMem();
  }
}

async function list(table) {
  // الدفعات المحذوفة (حذفاً غير نهائي) لا تظهر في القوائم ولا تدخل أي حساب
  if (usePg) {
    const sql = table === 'payments'
      ? `SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY id`
      : `SELECT * FROM ${table} ORDER BY id`;
    const { rows } = await pool.query(sql);
    return rows;
  }
  const rows = [...loadMem()[table]].sort((a, b) => a.id - b.id);
  return table === 'payments' ? rows.filter((r) => !r.deleted_at) : rows;
}

async function listRaw(table) {
  // كل الصفوف دون ترشيح — للنسخ الاحتياطي حتى تبقى السندات المحذوفة قابلة للاسترجاع بعد الاستعادة
  if (usePg) {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
    return rows;
  }
  return [...loadMem()[table]].sort((a, b) => a.id - b.id);
}

async function listTrash(table) {
  if (usePg) {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE deleted_at IS NOT NULL ORDER BY id`);
    return rows;
  }
  return [...loadMem()[table]].filter((r) => r.deleted_at).sort((a, b) => a.id - b.id);
}

async function get(table, id) {
  if (usePg) {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return rows[0] || null;
  }
  return loadMem()[table].find((r) => r.id === Number(id)) || null;
}

function pick(table, obj) {
  const out = {};
  for (const col of TABLES[table]) {
    if (obj[col] === undefined) continue;
    let v = obj[col];
    if (v === '' && (col === 'end_date' || col === 'unit_id' || col === 'installments_count' || col === 'period_from' || col === 'period_to')) v = null;
    if (col === 'installments_count' && v !== null) {
      v = Number(v);
      if (!Number.isFinite(v) || v <= 0) v = null;
      else v = Math.floor(v);
    }
    out[col] = v;
  }
  return out;
}

async function insert(table, obj) {
  const data = pick(table, obj);
  if (usePg) {
    const cols = Object.keys(data);
    const vals = cols.map((c) => data[c]);
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
    return rows[0];
  }
  const m = loadMem();
  if (table === 'expenses') {
    if (data.voucher_no === undefined || data.voucher_no === null) data.voucher_no = ++m.voucher_seq;
    if (data.payee === undefined) data.payee = '';
    if (data.payment_method === undefined) data.payment_method = 'نقداً';
  }
  const row = { id: ++m.seq[table], created_at: new Date().toISOString(), ...data };
  m[table].push(row);
  saveMem();
  return row;
}

async function insertPayment(obj) {
  const data = pick('payments', obj);
  if (!data.purpose) data.purpose = 'إيجار'; // الغرض الافتراضي: إيجار
  if (usePg) {
    const cols = Object.keys(data);
    const vals = cols.map((c) => data[c]);
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(
      `INSERT INTO payments (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
    return rows[0]; // receipt_no يأتي من التسلسل تلقائياً
  }
  const m = loadMem();
  const row = { id: ++m.seq.payments, receipt_no: ++m.receipt_seq, created_at: new Date().toISOString(), ...data };
  m.payments.push(row);
  saveMem();
  return row;
}

async function update(table, id, obj) {
  const data = pick(table, obj);
  const cols = Object.keys(data);
  if (!cols.length) return get(table, id);
  if (usePg) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(',');
    const { rows } = await pool.query(
      `UPDATE ${table} SET ${sets} WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map((c) => data[c]), id]);
    return rows[0] || null;
  }
  const m = loadMem();
  const row = m[table].find((r) => r.id === Number(id));
  if (!row) return null;
  Object.assign(row, data);
  saveMem();
  return row;
}

async function remove(table, id) {
  if (usePg) {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    return true;
  }
  const m = loadMem();
  const before = m[table].length;
  m[table] = m[table].filter((r) => r.id !== Number(id));
  // حذف متسلسل بسيط في الوضع المحلي
  if (table === 'properties') {
    const unitIds = m.units.filter((u) => u.property_id === Number(id)).map((u) => u.id);
    m.meter_readings = m.meter_readings.filter((r) => !unitIds.includes(r.unit_id));
    m.units = m.units.filter((u) => u.property_id !== Number(id));
    m.expenses = m.expenses.filter((e) => e.property_id !== Number(id));
    m.contracts = m.contracts.filter((c) => !unitIds.includes(c.unit_id));
    const contractIds = new Set(m.contracts.map((c) => c.id));
    m.payments = m.payments.filter((p) => contractIds.has(p.contract_id));
  }
  if (table === 'units') {
    m.meter_readings = m.meter_readings.filter((r) => r.unit_id !== Number(id));
  }
  if (table === 'units' || table === 'tenants') {
    const key = table === 'units' ? 'unit_id' : 'tenant_id';
    const removedContracts = m.contracts.filter((c) => c[key] === Number(id)).map((c) => c.id);
    m.contracts = m.contracts.filter((c) => c[key] !== Number(id));
    m.payments = m.payments.filter((p) => !removedContracts.includes(p.contract_id));
  }
  if (table === 'contracts') {
    m.payments = m.payments.filter((p) => p.contract_id !== Number(id));
  }
  saveMem();
  return m[table].length !== before;
}

// ---------------- إعدادات المؤسسة ----------------
async function getSettings() {
  const out = { company_name: '', company_address: '', company_phones: '', company_extra: '', company_logo: '' };
  if (usePg) {
    const { rows } = await pool.query('SELECT key, value FROM settings');
    for (const r of rows) if (SETTING_KEYS.includes(r.key)) out[r.key] = r.value || '';
    return out;
  }
  const s = loadMem().settings || {};
  for (const k of SETTING_KEYS) out[k] = s[k] || '';
  return out;
}

async function setSettings(obj) {
  const data = {};
  for (const k of SETTING_KEYS) {
    if (obj && obj[k] !== undefined) data[k] = obj[k] === null ? '' : String(obj[k]);
  }
  if (usePg) {
    for (const [k, v] of Object.entries(data)) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
    }
    return getSettings();
  }
  const m = loadMem();
  m.settings = { ...(m.settings || {}), ...data };
  saveMem();
  return getSettings();
}

// ---------------- المرفقات ----------------
async function listAttachments(entityType, entityId) {
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT id, entity_type, entity_id, filename, mime, size, created_at FROM attachments
       WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`, [entityType, Number(entityId)]);
    return rows;
  }
  return loadMem().attachments
    .filter((a) => a.entity_type === entityType && a.entity_id === Number(entityId))
    .map(({ data_base64, ...meta }) => meta)
    .sort((a, b) => a.id - b.id);
}

async function listAttachmentsMeta() {
  if (usePg) {
    const { rows } = await pool.query(
      'SELECT id, entity_type, entity_id, filename, mime, size, created_at FROM attachments ORDER BY id');
    return rows;
  }
  return [...loadMem().attachments]
    .map(({ data_base64, ...meta }) => meta)
    .sort((a, b) => a.id - b.id);
}

async function listAttachmentsFull() {
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM attachments ORDER BY id');
    return rows;
  }
  return [...loadMem().attachments].sort((a, b) => a.id - b.id);
}

async function getAttachment(id) {
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM attachments WHERE id = $1', [id]);
    return rows[0] || null;
  }
  return loadMem().attachments.find((a) => a.id === Number(id)) || null;
}

async function insertAttachment(obj) {
  if (usePg) {
    const { rows } = await pool.query(
      `INSERT INTO attachments (entity_type, entity_id, filename, mime, size, data_base64)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, entity_type, entity_id, filename, mime, size, created_at`,
      [obj.entity_type, Number(obj.entity_id), obj.filename || '', obj.mime, obj.size, obj.data_base64]);
    return rows[0];
  }
  const m = loadMem();
  const row = {
    id: ++m.seq.attachments, created_at: new Date().toISOString(),
    entity_type: obj.entity_type, entity_id: Number(obj.entity_id),
    filename: obj.filename || '', mime: obj.mime, size: obj.size, data_base64: obj.data_base64,
  };
  m.attachments.push(row);
  saveMem();
  const { data_base64, ...meta } = row;
  return meta;
}

async function removeAttachment(id) {
  if (usePg) {
    await pool.query('DELETE FROM attachments WHERE id = $1', [id]);
    return true;
  }
  const m = loadMem();
  m.attachments = m.attachments.filter((a) => a.id !== Number(id));
  saveMem();
  return true;
}

async function exportAll() {
  const out = {};
  for (const t of Object.keys(TABLES)) out[t] = await listRaw(t);
  out.settings = await getSettings();
  out.attachments = await listAttachmentsFull();
  return out;
}

async function importAll(data) {
  const order = ['properties', 'tenants', 'units', 'meter_readings', 'contracts', 'payments', 'expenses'];
  if (usePg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM attachments');
      for (const t of [...order].reverse()) await client.query(`DELETE FROM ${t}`);
      for (const t of order) {
        for (const row of data[t] || []) {
          const cols = ['id', ...TABLES[t], ...(t === 'payments' ? ['receipt_no'] : []), ...(t === 'expenses' ? ['voucher_no'] : []), 'created_at']
            .filter((c) => row[c] !== undefined);
          const vals = cols.map((c) => row[c]);
          const ph = cols.map((_, i) => `$${i + 1}`).join(',');
          await client.query(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${ph})`, vals);
        }
      }
      for (const t of order) {
        await client.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
      }
      const maxR = (data.payments || []).reduce((mx, r) => Math.max(mx, r.receipt_no || 0), 0);
      await client.query(`SELECT setval('receipt_seq', ${Math.max(maxR, 1)})`);
      const maxV = (data.expenses || []).reduce((mx, r) => Math.max(mx, r.voucher_no || 0), 0);
      await client.query(`SELECT setval('voucher_seq', ${Math.max(maxV, 1)})`);
      for (const row of data.attachments || []) {
        const cols = ['id', 'entity_type', 'entity_id', 'filename', 'mime', 'size', 'data_base64', 'created_at']
          .filter((c) => row[c] !== undefined);
        const vals = cols.map((c) => row[c]);
        const ph = cols.map((_, i) => `$${i + 1}`).join(',');
        await client.query(`INSERT INTO attachments (${cols.join(',')}) VALUES (${ph})`, vals);
      }
      await client.query(`SELECT setval(pg_get_serial_sequence('attachments','id'), COALESCE((SELECT MAX(id) FROM attachments), 1))`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    if (data.settings) await setSettings(data.settings);
    return true;
  }
  const m = loadMem();
  for (const t of order) {
    m[t] = Array.isArray(data[t]) ? data[t] : [];
    m.seq[t] = m[t].reduce((mx, r) => Math.max(mx, r.id || 0), 0);
  }
  m.receipt_seq = (m.payments || []).reduce((mx, r) => Math.max(mx, r.receipt_no || 0), 0);
  m.voucher_seq = (m.expenses || []).reduce((mx, r) => Math.max(mx, r.voucher_no || 0), 0);
  for (const e of [...m.expenses].sort((a, b) => (a.id || 0) - (b.id || 0))) {
    if (!e.voucher_no) e.voucher_no = ++m.voucher_seq;
  }
  if (data.settings) m.settings = data.settings;
  m.attachments = Array.isArray(data.attachments) ? data.attachments : [];
  m.seq.attachments = m.attachments.reduce((mx, r) => Math.max(mx, r.id || 0), 0);
  saveMem();
  return true;
}

// ---------------- سجل الحركات (التدقيق) ----------------
// سجل إضافي فقط (append-only): يُكتب عند إنشاء/تعديل/حذف الكيانات الأساسية،
// ولا يُحذف من الواجهة. الكتابة فيه يجب ألا تعطّل العملية الأساسية أبداً.
async function insertAudit(entry) {
  const row = {
    actor: entry.actor || '',
    entity: entry.entity || '',
    entity_id: entry.entity_id !== undefined && entry.entity_id !== null && entry.entity_id !== ''
      ? Number(entry.entity_id) : null,
    action: entry.action || '',
    summary: entry.summary || '',
  };
  if (usePg) {
    const { rows } = await pool.query(
      `INSERT INTO audit_log (actor, entity, entity_id, action, summary)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [row.actor, row.entity, row.entity_id, row.action, row.summary]);
    return rows[0];
  }
  const m = loadMem();
  const full = { id: ++m.seq.audit_log, created_at: new Date().toISOString(), ...row };
  m.audit_log.push(full);
  saveMem();
  return full;
}

async function listAudit({ entity = '', limit = 200 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  if (usePg) {
    const { rows } = entity
      ? await pool.query('SELECT * FROM audit_log WHERE entity = $1 ORDER BY id DESC LIMIT $2', [entity, lim])
      : await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [lim]);
    return rows;
  }
  return [...loadMem().audit_log]
    .filter((r) => !entity || r.entity === entity)
    .sort((a, b) => b.id - a.id)
    .slice(0, lim);
}

// ---------------- المستخدمون (حسابات الدخول) ----------------
// password_hash بصيغة salt:hash (scrypt) — لا يُعاد أبداً في أي استجابة API:
// كل القراءات العامة تمر عبر publicUser التي تحذفه نهائياً.
// ملاحظة: المستخدمون خارج النسخة الاحتياطية (exportAll/importAll) عمداً —
// لا تسرّب للتجزئات في ملفات النسخ، وحسابات الدخول تنجو من أي استرجاع.
function publicUser(r) {
  if (!r) return null;
  return {
    id: r.id, username: r.username, display_name: r.display_name || '',
    role: r.role === 'admin' ? 'admin' : 'staff',
    active: r.active === undefined || r.active === null ? true : !!r.active,
    created_at: r.created_at,
  };
}

async function listUsers() {
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
    return rows.map(publicUser);
  }
  return [...loadMem().users].sort((a, b) => a.id - b.id).map(publicUser);
}

// بحث باسم المستخدم دون حساسية لحالة الأحرف — يعيد الصف الكامل (للاستخدام الداخلي فقط)
async function getUserByUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = $1', [u]);
    return rows[0] || null;
  }
  return loadMem().users.find((r) => String(r.username || '').toLowerCase() === u) || null;
}

async function getUserById(id) {
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  }
  return loadMem().users.find((r) => r.id === Number(id)) || null;
}

async function insertUser(obj) {
  const data = {
    username: String(obj.username || '').trim(),
    display_name: String(obj.display_name || '').trim(),
    password_hash: String(obj.password_hash || ''),
    role: obj.role === 'admin' ? 'admin' : 'staff',
    active: true,
  };
  if (usePg) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, display_name, password_hash, role, active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [data.username, data.display_name, data.password_hash, data.role, data.active]);
    return rows[0];
  }
  const m = loadMem();
  const row = { id: ++m.seq.users, created_at: new Date().toISOString(), ...data };
  m.users.push(row);
  saveMem();
  return row;
}

async function updateUser(id, obj) {
  const data = {};
  if (obj.display_name !== undefined) data.display_name = String(obj.display_name || '').trim();
  if (obj.role !== undefined) data.role = obj.role === 'admin' ? 'admin' : 'staff';
  if (obj.active !== undefined) data.active = !!obj.active;
  if (obj.password_hash !== undefined) data.password_hash = String(obj.password_hash || '');
  const cols = Object.keys(data);
  if (!cols.length) return getUserById(id);
  if (usePg) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(',');
    const { rows } = await pool.query(
      `UPDATE users SET ${sets} WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map((c) => data[c]), id]);
    return rows[0] || null;
  }
  const m = loadMem();
  const row = m.users.find((r) => r.id === Number(id));
  if (!row) return null;
  Object.assign(row, data);
  saveMem();
  return row;
}

// عدد حسابات المديرين النشطة في جدول المستخدمين باستثناء حساب معيّن
// (لمنع إيقاف أو تخفيض دور آخر مدير نشط — المدير الرئيسي من البيئة لا يُحتسب هنا)
async function countActiveAdmins(excludeId) {
  const all = usePg
    ? (await pool.query('SELECT id, role, active FROM users')).rows
    : loadMem().users;
  return all.filter((r) => r.role === 'admin' && r.active !== false && Number(r.id) !== Number(excludeId)).length;
}

// ---------------- النسخ الاحتياطية التلقائية (لقطات كاملة) ----------------
// كل لقطة تحمل حمولة النسخة الاحتياطية الكاملة بنفس صيغة التصدير/الاستيراد،
// فالاستعادة تمر عبر importAll كما هي. قاعدة الاحتفاظ (pruneBackups):
// أحدث لقطة واحدة فقط، بالإضافة إلى لقطة أمان مثبّتة (pinned) — وهي نسخة
// «قبل الاستعادة»/«قبل الاستيراد» — ما دام لا يوجد أكثر من لقطة واحدة أحدث
// منها؛ أي أنها تنجو من لقطة ما بعد الاستعادة/الاستيراد ثم تُحذف عند أخذ
// اللقطة التالية. النتيجة: لقطة واحدة في الحالة العادية، واثنتان مؤقتاً
// حول الاستعادة/الاستيراد.
async function insertBackup({ trigger, data, pinned }) {
  const payload = data || {};
  const trig = ['auto', 'manual', 'pre-restore', 'pre-import'].includes(trigger) ? trigger : 'auto';
  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (usePg) {
    const { rows } = await pool.query(
      `INSERT INTO backups (trigger, size_bytes, data, pinned) VALUES ($1, $2, $3, $4)
       RETURNING id, created_at, trigger, size_bytes, drive_status, drive_error, pinned`,
      [trig, size, JSON.stringify(payload), !!pinned]);
    return rows[0];
  }
  const m = loadMem();
  const row = {
    id: ++m.seq.backups, created_at: new Date().toISOString(), trigger: trig,
    size_bytes: size, drive_status: null, drive_error: null, pinned: !!pinned, data: payload,
  };
  m.backups.push(row);
  saveMem();
  const { data: _omit, ...meta } = row;
  return meta;
}

async function listBackupsMeta() {
  if (usePg) {
    const { rows } = await pool.query(
      'SELECT id, created_at, trigger, size_bytes, drive_status, drive_error, pinned FROM backups ORDER BY id DESC');
    return rows;
  }
  return [...loadMem().backups].sort((a, b) => b.id - a.id)
    .map(({ data, ...meta }) => ({ drive_status: null, drive_error: null, pinned: false, ...meta }));
}

// تسجيل نتيجة رفع اللقطة إلى Google Drive بعد استقرار الرفع (ناجح/فاشل).
// تُستدعى بشكل غير متزامن بعد إنشاء اللقطة — وأي خطأ فيها يُبتلع بصمت.
async function updateBackupDrive(id, { drive_status, drive_error }) {
  const status = drive_status || null;
  const error = drive_error ? String(drive_error).slice(0, 500) : null;
  if (usePg) {
    await pool.query('UPDATE backups SET drive_status = $1, drive_error = $2 WHERE id = $3',
      [status, error, id]);
    return true;
  }
  const m = loadMem();
  const row = m.backups.find((b) => b.id === Number(id));
  if (!row) return false;
  row.drive_status = status;
  row.drive_error = error;
  saveMem();
  return true;
}

async function getBackup(id) {
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM backups WHERE id = $1', [id]);
    if (!rows[0]) return null;
    let data = rows[0].data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { data = {}; } }
    return { ...rows[0], data };
  }
  return loadMem().backups.find((b) => b.id === Number(id)) || null;
}

async function pruneBackups() {
  let metas;
  if (usePg) {
    metas = (await pool.query('SELECT id, pinned FROM backups ORDER BY id DESC')).rows;
  } else {
    metas = [...loadMem().backups].sort((a, b) => b.id - a.id)
      .map((b) => ({ id: b.id, pinned: !!b.pinned }));
  }
  if (metas.length <= 1) return 0;
  // القاعدة الجديدة: أحدث لقطة فقط + أي لقطة مثبّتة (أمان) لا يتجاوز عدد
  // اللقطات الأحدث منها واحدة — فتنجو الأمان من لقطة ما بعد عمليتها وتُحذف
  // عند اللقطة التالية. (metas مرتّبة تنازلياً، فموضع الصف = عدد الأحدث منه)
  const keep = new Set([metas[0].id]);
  metas.forEach((b, idx) => { if (b.pinned && idx <= 1) keep.add(b.id); });
  const doomed = metas.filter((b) => !keep.has(b.id)).map((b) => b.id);
  if (!doomed.length) return 0;
  if (usePg) {
    await pool.query('DELETE FROM backups WHERE id = ANY($1)', [doomed]);
  } else {
    const m = loadMem();
    m.backups = m.backups.filter((b) => !doomed.includes(b.id));
    saveMem();
  }
  return doomed.length;
}

module.exports = {
  init, list, listRaw, listTrash, get, insert, insertPayment, update, remove, exportAll, importAll,
  getSettings, setSettings,
  listAttachments, listAttachmentsMeta, listAttachmentsFull, getAttachment, insertAttachment, removeAttachment,
  insertAudit, listAudit,
  publicUser, listUsers, getUserByUsername, getUserById, insertUser, updateUser, countActiveAdmins,
  insertBackup, listBackupsMeta, getBackup, pruneBackups, updateBackupDrive,
  ATTACHMENT_TYPES, ATTACHMENT_MIMES, ATTACHMENT_MAX,
  TABLES, usePg,
};

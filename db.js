'use strict';
// طبقة البيانات: PostgreSQL (Supabase) عند وجود DATABASE_URL،
// وإلا مخزن ملف JSON محلي للتجربة والتشغيل بدون قاعدة بيانات.
const fs = require('fs');
const path = require('path');

const TABLES = {
  properties: ['name', 'address', 'owner_name', 'notes'],
  units: ['property_id', 'name', 'type', 'floor', 'default_rent', 'status', 'notes'],
  tenants: ['name', 'phone', 'id_number', 'email', 'notes'],
  contracts: ['unit_id', 'tenant_id', 'start_date', 'end_date', 'rent_amount', 'cycle', 'deposit', 'status', 'notes'],
  payments: ['contract_id', 'amount', 'payment_date', 'method', 'notes'],
  expenses: ['property_id', 'unit_id', 'category', 'amount', 'expense_date', 'description', 'payee', 'payment_method'],
  meter_readings: ['unit_id', 'meter_type', 'reading_value', 'reading_date', 'notes'],
};

const ATTACHMENT_TYPES = ['tenant', 'contract', 'payment', 'expense'];
const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];
const ATTACHMENT_MAX = 3 * 1024 * 1024;

const SETTING_KEYS = ['company_name', 'company_address', 'company_phones', 'company_extra'];

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
  email TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS contracts (
  id SERIAL PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  start_date DATE NOT NULL, end_date DATE, rent_amount NUMERIC(12,2) NOT NULL,
  cycle TEXT NOT NULL DEFAULT 'monthly', deposit NUMERIC(12,2) DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE SEQUENCE IF NOT EXISTS receipt_seq START 1;
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL, payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  method TEXT NOT NULL DEFAULT 'تحويل', receipt_no INTEGER NOT NULL DEFAULT nextval('receipt_seq'),
  notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
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
`;

// ---------------- مخزن JSON المحلي ----------------
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let mem = null;

function loadMem() {
  if (mem) return mem;
  try {
    mem = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    mem = { seq: {}, receipt_seq: 0, voucher_seq: 0, settings: {}, properties: [], units: [], tenants: [], contracts: [], payments: [], expenses: [] };
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
  // تسلسل سندات الصرف: ترقيم المصروفات القديمة التي بلا رقم، بترتيب إنشائها
  const maxVoucher = (mem.expenses || []).reduce((m, r) => Math.max(m, r.voucher_no || 0), 0);
  if (!mem.voucher_seq || mem.voucher_seq < maxVoucher) mem.voucher_seq = maxVoucher;
  for (const e of [...(mem.expenses || [])].sort((a, b) => (a.id || 0) - (b.id || 0))) {
    if (e.payee === undefined) e.payee = '';
    if (e.payment_method === undefined) e.payment_method = 'نقداً';
    if (!e.voucher_no) e.voucher_no = ++mem.voucher_seq;
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
  if (usePg) {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
    return rows;
  }
  return [...loadMem()[table]].sort((a, b) => a.id - b.id);
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
    if (obj[col] !== undefined) out[col] = obj[col] === '' && (col === 'end_date' || col === 'unit_id') ? null : obj[col];
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
  if (table === 'expenses' && (data.voucher_no === undefined || data.voucher_no === null)) {
    data.voucher_no = ++m.voucher_seq;
  }
  const row = { id: ++m.seq[table], created_at: new Date().toISOString(), ...data };
  m[table].push(row);
  saveMem();
  return row;
}

async function insertPayment(obj) {
  const data = pick('payments', obj);
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
  const out = { company_name: '', company_address: '', company_phones: '', company_extra: '' };
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
  for (const t of Object.keys(TABLES)) out[t] = await list(t);
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

module.exports = {
  init, list, get, insert, insertPayment, update, remove, exportAll, importAll,
  getSettings, setSettings,
  listAttachments, listAttachmentsMeta, listAttachmentsFull, getAttachment, insertAttachment, removeAttachment,
  ATTACHMENT_TYPES, ATTACHMENT_MIMES, ATTACHMENT_MAX,
  TABLES, usePg,
};

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
  expenses: ['property_id', 'unit_id', 'category', 'amount', 'expense_date', 'description'],
};

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
`;

// ---------------- مخزن JSON المحلي ----------------
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let mem = null;

function loadMem() {
  if (mem) return mem;
  try {
    mem = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    mem = { seq: {}, receipt_seq: 0, properties: [], units: [], tenants: [], contracts: [], payments: [], expenses: [] };
  }
  for (const t of Object.keys(TABLES)) {
    if (!Array.isArray(mem[t])) mem[t] = [];
    if (!mem.seq) mem.seq = {};
    if (!mem.seq[t]) mem.seq[t] = mem[t].reduce((m, r) => Math.max(m, r.id || 0), 0);
  }
  if (!mem.receipt_seq) mem.receipt_seq = (mem.payments || []).reduce((m, r) => Math.max(m, r.receipt_no || 0), 0);
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
    m.units = m.units.filter((u) => u.property_id !== Number(id));
    m.expenses = m.expenses.filter((e) => e.property_id !== Number(id));
    m.contracts = m.contracts.filter((c) => !unitIds.includes(c.unit_id));
    const contractIds = new Set(m.contracts.map((c) => c.id));
    m.payments = m.payments.filter((p) => contractIds.has(p.contract_id));
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

async function exportAll() {
  const out = {};
  for (const t of Object.keys(TABLES)) out[t] = await list(t);
  return out;
}

async function importAll(data) {
  const order = ['properties', 'tenants', 'units', 'contracts', 'payments', 'expenses'];
  if (usePg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const t of [...order].reverse()) await client.query(`DELETE FROM ${t}`);
      for (const t of order) {
        for (const row of data[t] || []) {
          const cols = ['id', ...TABLES[t], ...(t === 'payments' ? ['receipt_no'] : []), 'created_at']
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
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return true;
  }
  const m = loadMem();
  for (const t of order) {
    m[t] = Array.isArray(data[t]) ? data[t] : [];
    m.seq[t] = m[t].reduce((mx, r) => Math.max(mx, r.id || 0), 0);
  }
  m.receipt_seq = (m.payments || []).reduce((mx, r) => Math.max(mx, r.receipt_no || 0), 0);
  saveMem();
  return true;
}

module.exports = { init, list, get, insert, insertPayment, update, remove, exportAll, importAll, TABLES, usePg };

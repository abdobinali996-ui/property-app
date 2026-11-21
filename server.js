'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const calc = require('./calc');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-123';
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-secret-change-me';

// ---------- مصادقة بسيطة برمز موقّع ----------
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ u: ADMIN_USER, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function validToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  } catch (_) { return false; }
}
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '') || req.query.token || '';
  if (!validToken(token)) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    return res.json({ token: makeToken() });
  }
  res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
});
app.get('/api/health', (req, res) => res.json({ ok: true, database: db.usePg ? 'postgresql' : 'local-json' }));

// ---------- أدوات مساعدة ----------
async function enrichedContracts() {
  const [contracts, units, tenants, payments, properties] = await Promise.all([
    db.list('contracts'), db.list('units'), db.list('tenants'), db.list('payments'), db.list('properties'),
  ]);
  const unitById = Object.fromEntries(units.map((u) => [u.id, u]));
  const tenantById = Object.fromEntries(tenants.map((t) => [t.id, t]));
  const propById = Object.fromEntries(properties.map((p) => [p.id, p]));
  const paysByContract = {};
  for (const p of payments) (paysByContract[p.contract_id] = paysByContract[p.contract_id] || []).push(p);
  return contracts.map((c) => {
    const unit = unitById[c.unit_id] || {};
    const property = propById[unit.property_id] || {};
    const summary = calc.contractSummary(c, paysByContract[c.id] || []);
    return {
      ...c,
      unit_name: unit.name || '', property_id: unit.property_id || null, property_name: property.name || '',
      tenant_name: (tenantById[c.tenant_id] || {}).name || '',
      start_date: calc.fmtDate(c.start_date), end_date: calc.fmtDate(c.end_date) || null,
      ...summary,
    };
  });
}

// ---------- CRUD عام ----------
for (const table of Object.keys(db.TABLES)) {
  app.get(`/api/${table}`, auth, async (req, res) => {
    try { res.json(await db.list(table)); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get(`/api/${table}/:id`, auth, async (req, res) => {
    try {
      const row = await db.get(table, req.params.id);
      if (!row) return res.status(404).json({ error: 'غير موجود' });
      res.json(row);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  if (table !== 'payments') {
    app.post(`/api/${table}`, auth, async (req, res) => {
      try { res.status(201).json(await db.insert(table, req.body || {})); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
  }
  app.put(`/api/${table}/:id`, auth, async (req, res) => {
    try {
      const row = await db.update(table, req.params.id, req.body || {});
      if (!row) return res.status(404).json({ error: 'غير موجود' });
      res.json(row);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete(`/api/${table}/:id`, auth, async (req, res) => {
    try { await db.remove(table, req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}

// ---------- العقود مع الملخصات ----------
app.get('/api/contracts-full', auth, async (req, res) => {
  try { res.json(await enrichedContracts()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- الدفعات وسندات القبض ----------
app.post('/api/payments', auth, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.contract_id || !(Number(body.amount) > 0)) {
      return res.status(400).json({ error: 'اختر العقد وأدخل مبلغاً صحيحاً' });
    }
    const payment = await db.insertPayment({
      contract_id: Number(body.contract_id),
      amount: Number(body.amount),
      payment_date: body.payment_date || calc.fmtDate(new Date()),
      method: body.method || 'تحويل',
      notes: body.notes || '',
    });
    res.status(201).json(payment);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// بيانات سند قبض كاملة للطباعة
app.get('/api/payments/:id/receipt', auth, async (req, res) => {
  try {
    const payment = await db.get('payments', req.params.id);
    if (!payment) return res.status(404).json({ error: 'غير موجود' });
    const contract = await db.get('contracts', payment.contract_id);
    const tenant = contract ? await db.get('tenants', contract.tenant_id) : null;
    const unit = contract ? await db.get('units', contract.unit_id) : null;
    const property = unit ? await db.get('properties', unit.property_id) : null;
    const allPays = (await db.list('payments')).filter((p) => p.contract_id === payment.contract_id);
    const summary = contract ? calc.contractSummary(contract, allPays) : null;
    res.json({
      receipt_no: payment.receipt_no,
      payment: { ...payment, payment_date: calc.fmtDate(payment.payment_date) },
      tenant, unit, property,
      contract: contract ? { ...contract, start_date: calc.fmtDate(contract.start_date), end_date: calc.fmtDate(contract.end_date) || null } : null,
      summary,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- بحث المستأجرين وملف المستأجر ----------
app.get('/api/tenants-search', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const [tenants, contracts, units, payments] = await Promise.all([
      db.list('tenants'), db.list('contracts'), db.list('units'), db.list('payments'),
    ]);
    const unitById = Object.fromEntries(units.map((u) => [u.id, u]));
    const paysByContract = {};
    for (const p of payments) (paysByContract[p.contract_id] = paysByContract[p.contract_id] || []).push(p);

    const results = [];
    for (const t of tenants) {
      const tContracts = contracts.filter((c) => c.tenant_id === t.id);
      const unitNames = tContracts.map((c) => (unitById[c.unit_id] || {}).name || '').join(' ');
      const hay = `${t.name} ${t.phone} ${t.id_number} ${unitNames}`;
      if (q && !hay.includes(q)) continue;
      let totalPaid = 0, receipts = 0, arrears = 0;
      for (const c of tContracts) {
        const ps = paysByContract[c.id] || [];
        totalPaid += ps.reduce((s, p) => s + Number(p.amount || 0), 0);
        receipts += ps.length;
        arrears += calc.contractSummary(c, ps).arrears;
      }
      results.push({
        ...t, total_paid: totalPaid, receipts_count: receipts, arrears,
        units: tContracts.map((c) => (unitById[c.unit_id] || {}).name).filter(Boolean),
      });
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tenants/:id/profile', auth, async (req, res) => {
  try {
    const tenant = await db.get('tenants', req.params.id);
    if (!tenant) return res.status(404).json({ error: 'غير موجود' });
    const [contracts, units, payments, properties] = await Promise.all([
      db.list('contracts'), db.list('units'), db.list('payments'), db.list('properties'),
    ]);
    const unitById = Object.fromEntries(units.map((u) => [u.id, u]));
    const propById = Object.fromEntries(properties.map((p) => [p.id, p]));
    const tContracts = contracts.filter((c) => c.tenant_id === tenant.id);
    const contractIds = new Set(tContracts.map((c) => c.id));
    const history = payments
      .filter((p) => contractIds.has(p.contract_id))
      .sort((a, b) => (a.receipt_no || 0) - (b.receipt_no || 0))
      .map((p) => {
        const c = tContracts.find((x) => x.id === p.contract_id);
        const u = c ? unitById[c.unit_id] : null;
        return { ...p, payment_date: calc.fmtDate(p.payment_date), unit_name: u ? u.name : '', property_name: u ? (propById[u.property_id] || {}).name : '' };
      });
    const enriched = tContracts.map((c) => {
      const ps = payments.filter((p) => p.contract_id === c.id);
      const u = unitById[c.unit_id] || {};
      return {
        ...c, start_date: calc.fmtDate(c.start_date), end_date: calc.fmtDate(c.end_date) || null,
        unit_name: u.name || '', property_name: (propById[u.property_id] || {}).name || '',
        ...calc.contractSummary(c, ps),
      };
    });
    const totalPaid = history.reduce((s, p) => s + Number(p.amount || 0), 0);
    const arrears = enriched.reduce((s, c) => s + c.arrears, 0);
    res.json({ tenant, contracts: enriched, payments: history, total_paid: totalPaid, receipts_count: history.length, arrears });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- كشف حساب المالك ----------
app.get('/api/properties/:id/statement', auth, async (req, res) => {
  try {
    const property = await db.get('properties', req.params.id);
    if (!property) return res.status(404).json({ error: 'غير موجود' });
    const from = req.query.from || '0001-01-01';
    const to = req.query.to || '9999-12-31';
    const [units, contracts, payments, expenses, tenants] = await Promise.all([
      db.list('units'), db.list('contracts'), db.list('payments'), db.list('expenses'), db.list('tenants'),
    ]);
    const propUnits = units.filter((u) => u.property_id === property.id);
    const unitIds = new Set(propUnits.map((u) => u.id));
    const propContracts = contracts.filter((c) => unitIds.has(c.unit_id));
    const contractIds = new Set(propContracts.map((c) => c.id));
    const tenantById = Object.fromEntries(tenants.map((t) => [t.id, t]));
    const unitById = Object.fromEntries(units.map((u) => [u.id, u]));

    const incomeRows = payments
      .filter((p) => contractIds.has(p.contract_id) && calc.fmtDate(p.payment_date) >= from && calc.fmtDate(p.payment_date) <= to)
      .map((p) => {
        const c = propContracts.find((x) => x.id === p.contract_id);
        return {
          date: calc.fmtDate(p.payment_date), receipt_no: p.receipt_no,
          description: `إيجار ${(unitById[c.unit_id] || {}).name || ''} — ${(tenantById[c.tenant_id] || {}).name || ''}`,
          amount: Number(p.amount),
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    const expenseRows = expenses
      .filter((e) => e.property_id === property.id && calc.fmtDate(e.expense_date) >= from && calc.fmtDate(e.expense_date) <= to)
      .map((e) => ({
        date: calc.fmtDate(e.expense_date),
        description: `${e.category}${e.description ? ' — ' + e.description : ''}${e.unit_id ? ' (' + ((unitById[e.unit_id] || {}).name || '') + ')' : ''}`,
        amount: Number(e.amount),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const totalIncome = incomeRows.reduce((s, r) => s + r.amount, 0);
    const totalExpenses = expenseRows.reduce((s, r) => s + r.amount, 0);
    res.json({
      property, from, to,
      income: incomeRows, expenses: expenseRows,
      total_income: totalIncome, total_expenses: totalExpenses,
      net: Math.round((totalIncome - totalExpenses) * 100) / 100,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- لوحة المتابعة ----------
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const contracts = await enrichedContracts();
    const payments = await db.list('payments');
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const collectedThisMonth = payments
      .filter((p) => calc.fmtDate(p.payment_date).startsWith(ym))
      .reduce((s, p) => s + Number(p.amount || 0), 0);
    const [rawContracts] = await Promise.all([db.list('contracts')]);
    const dueThisMonth = rawContracts
      .filter((c) => c.status === 'active')
      .reduce((s, c) => s + calc.dueInMonth(c, now.getFullYear(), now.getMonth()), 0);
    const arrearsList = contracts
      .filter((c) => c.arrears > 0)
      .sort((a, b) => b.arrears - a.arrears)
      .map((c) => ({ contract_id: c.id, tenant_id: c.tenant_id, tenant_name: c.tenant_name, unit_name: c.unit_name, property_name: c.property_name, arrears: c.arrears, total_paid: c.total_paid, total_due: c.total_due }));
    const in60 = new Date(now.getTime() + 60 * 24 * 3600 * 1000);
    const expiring = contracts
      .filter((c) => c.end_date && c.status === 'active')
      .filter((c) => { const e = calc.toDate(c.end_date); return e >= calc.today() && e <= in60; })
      .sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)))
      .map((c) => ({ contract_id: c.id, tenant_name: c.tenant_name, unit_name: c.unit_name, property_name: c.property_name, end_date: c.end_date }));
    const recentPayments = [...payments]
      .sort((a, b) => (b.receipt_no || 0) - (a.receipt_no || 0))
      .slice(0, 8);
    res.json({
      collected_this_month: collectedThisMonth,
      due_this_month: dueThisMonth,
      total_arrears: arrearsList.reduce((s, r) => s + r.arrears, 0),
      arrears_list: arrearsList,
      expiring_soon: expiring,
      recent_payments: recentPayments,
      counts: {
        properties: (await db.list('properties')).length,
        units: (await db.list('units')).length,
        tenants: (await db.list('tenants')).length,
        active_contracts: contracts.filter((c) => c.status === 'active').length,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- تصدير واستيراد ----------
function toCsv(rows) {
  if (!rows.length) return '﻿';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

app.get('/api/export/:table.csv', auth, async (req, res) => {
  try {
    const table = req.params.table;
    if (!db.TABLES[table] && table !== 'contracts-full') return res.status(404).json({ error: 'جدول غير معروف' });
    const rows = table === 'contracts-full' ? await enrichedContracts() : await db.list(table);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
    res.send(toCsv(rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup', auth, async (req, res) => {
  try {
    const data = await db.exportAll();
    res.setHeader('Content-Disposition', 'attachment; filename="property-backup.json"');
    res.json({ app: 'property-management-app', version: 1, exported_at: new Date().toISOString(), data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/import', auth, async (req, res) => {
  try {
    const data = (req.body && req.body.data) || req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'ملف غير صالح' });
    await db.importAll(data);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// أي مسار آخر يعيد واجهة التطبيق
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Property management app running on port ${PORT} — database: ${db.usePg ? 'PostgreSQL' : 'local JSON (demo)'}`);
    });
  })
  .catch((e) => {
    console.error('Database init failed:', e.message);
    process.exit(1);
  });

'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const ExcelJS = require('exceljs');
const db = require('./db');
const calc = require('./calc');
const drive = require('./drive');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-123';
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-secret-change-me';

// ---------- كلمات المرور: تجزئة scrypt المدمجة في Node مع ملح عشوائي لكل مستخدم ----------
// الصيغة المخزنة: salt:hash (ست عشري) — لا تُحفظ كلمة مرور كنص صريح أبداً
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const calc = crypto.scryptSync(String(password), salt, 64);
    const orig = Buffer.from(hash, 'hex');
    return calc.length === orig.length && crypto.timingSafeEqual(calc, orig);
  } catch (_) { return false; }
}

// ---------- مصادقة برمز موقّع يحمل اسم المستخدم والدور ----------
// التوقيع بنفس AUTH_SECRET ومسار التحقق السابق. الدور المعتمد فعلياً يأتي من
// قاعدة البيانات وقت كل طلب (لا من الرمز)، فإيقاف الحساب أو تغيير دوره يسري فوراً.
function makeToken(username, role) {
  const payload = Buffer.from(JSON.stringify({ u: username, r: role || 'admin', t: Date.now() })).toString('base64url');
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
function tokenOf(req) {
  const header = req.headers.authorization || '';
  return header.replace('Bearer ', '') || req.query.token || '';
}
function tokenPayload(token) {
  if (!validToken(token)) return null;
  try {
    const [payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_) { return null; }
}
// يبني req.user من الرمز: المدير الرئيسي من متغيرات البيئة دائم الصلاحية
// (حساب إنقاذ لا يمكن قفله)، وغيره يجب أن يوجد في جدول المستخدمين وأن يكون نشطاً
async function auth(req, res, next) {
  try {
    const payload = tokenPayload(tokenOf(req));
    if (!payload || !payload.u) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    if (payload.u === ADMIN_USER) {
      req.user = { id: null, username: ADMIN_USER, display_name: 'المدير', role: 'admin', bootstrap: true };
      return next();
    }
    const user = await db.getUserByUsername(payload.u);
    if (!user || user.active === false) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    req.user = {
      id: user.id, username: user.username,
      display_name: user.display_name || user.username,
      role: user.role === 'admin' ? 'admin' : 'staff', bootstrap: false,
    };
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}
// صلاحية المدير فقط (إعدادات، إدارة مستخدمين، استيراد وتصدير…)
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'هذه العملية متاحة للمدير فقط' });
  }
  next();
}
// الحذف للمدير فقط — الموظف يضيف ويعدّل ويعرض، لكن لا يحذف شيئاً
function adminOnlyDelete(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'الحذف متاح للمدير فقط' });
  }
  next();
}
// اسم المستخدم المنفّذ للطلب — لسجل الحركات و«أصدره»
function actorOf(req) {
  if (req.user && req.user.username) return req.user.username;
  const payload = tokenPayload(tokenOf(req));
  return (payload && payload.u) || ADMIN_USER;
}
// الاسم المعروض لمن أصدر سنداً: الاسم الظاهر من جدول المستخدمين إن وُجد،
// وللمدير الرئيسي «المدير»، وإلا اسم المستخدم كما هو. فارغ = لا يُطبع السطر.
async function displayNameFor(username) {
  if (!username) return null;
  const u = await db.getUserByUsername(username);
  if (u && u.display_name) return u.display_name;
  if (username === ADMIN_USER) return 'المدير';
  return username;
}

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const uname = String(username || '').trim();
    // المدير الرئيسي (متغيرات البيئة) — يعمل دائماً حتى لو كان جدول المستخدمين فارغاً
    if (uname === ADMIN_USER && password === ADMIN_PASSWORD) {
      return res.json({
        token: makeToken(ADMIN_USER, 'admin'),
        user: { id: null, username: ADMIN_USER, display_name: 'المدير', role: 'admin', bootstrap: true },
      });
    }
    const user = await db.getUserByUsername(uname);
    if (!user || !verifyPassword(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }
    if (user.active === false) {
      return res.status(403).json({ error: 'هذا الحساب موقوف — لا يمكنك تسجيل الدخول حالياً، تواصل مع المدير' });
    }
    res.json({
      token: makeToken(user.username, user.role === 'admin' ? 'admin' : 'staff'),
      user: db.publicUser(user),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// بيانات المستخدم الحالي (للواجهة: الاسم والدور ونوع الحساب)
app.get('/api/me', auth, (req, res) => {
  res.json({
    id: req.user.id, username: req.user.username, display_name: req.user.display_name,
    role: req.user.role, bootstrap: !!req.user.bootstrap,
  });
});

// تغيير كلمة السر ذاتياً لحسابات جدول المستخدمين
app.post('/api/me/password', auth, async (req, res) => {
  try {
    if (req.user.bootstrap) {
      return res.status(400).json({ error: 'كلمة سر المدير الرئيسي تُغيَّر من إعدادات الخادم (متغير ADMIN_PASSWORD في Render) وليس من داخل التطبيق' });
    }
    const { current_password, new_password } = req.body || {};
    if (!new_password || String(new_password).length < 6) {
      return res.status(400).json({ error: 'كلمة المرور الجديدة قصيرة — 6 أحرف على الأقل' });
    }
    const user = await db.getUserById(req.user.id);
    if (!user || !verifyPassword(current_password || '', user.password_hash)) {
      return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
    }
    await db.updateUser(user.id, { password_hash: hashPassword(new_password) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- إدارة المستخدمين (للمدير فقط — لا حذف، إيقاف فقط) ----------
app.get('/api/users', auth, adminOnly, async (req, res) => {
  try {
    res.json({
      users: await db.listUsers(),
      bootstrap: { username: ADMIN_USER, display_name: 'المدير الرئيسي', role: 'admin' },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const username = String(b.username || '').trim();
    if (username.length < 3 || /\s/.test(username)) {
      return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل وبدون مسافات' });
    }
    if (username.toLowerCase() === String(ADMIN_USER).toLowerCase()) {
      return res.status(400).json({ error: 'اسم المستخدم محجوز للمدير الرئيسي — اختر اسماً آخر' });
    }
    if (!b.password || String(b.password).length < 6) {
      return res.status(400).json({ error: 'كلمة المرور قصيرة — 6 أحرف على الأقل' });
    }
    if (await db.getUserByUsername(username)) {
      return res.status(400).json({ error: 'اسم المستخدم مستخدم من قبل — اختر اسماً آخر' });
    }
    const row = await db.insertUser({
      username,
      display_name: String(b.display_name || '').trim() || username,
      password_hash: hashPassword(b.password),
      role: b.role === 'admin' ? 'admin' : 'staff',
    });
    await audit(req, 'users', row.id, 'create', row);
    await takeSnapshot('auto');
    res.status(201).json(db.publicUser(row));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const target = await db.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const b = req.body || {};
    const patch = {};
    if (b.display_name !== undefined) patch.display_name = String(b.display_name || '').trim() || target.display_name;
    if (b.role !== undefined) patch.role = b.role === 'admin' ? 'admin' : 'staff';
    if (b.active !== undefined) patch.active = !!b.active;
    if (b.password !== undefined && b.password !== '') {
      if (String(b.password).length < 6) {
        return res.status(400).json({ error: 'كلمة المرور قصيرة — 6 أحرف على الأقل' });
      }
      patch.password_hash = hashPassword(b.password);
    }
    // حماية آخر مدير نشط في الجدول: لا إيقاف ولا تخفيض دور يتركه بلا مدير
    const wasActiveAdmin = target.role === 'admin' && target.active !== false;
    const staysActiveAdmin = (patch.role !== undefined ? patch.role : target.role) === 'admin'
      && (patch.active !== undefined ? patch.active : target.active !== false);
    if (wasActiveAdmin && !staysActiveAdmin && (await db.countActiveAdmins(target.id)) === 0) {
      return res.status(400).json({ error: 'لا يمكن إيقاف أو تخفيض دور آخر مدير نشط — عيّن مديراً آخر أولاً' });
    }
    const row = await db.updateUser(target.id, patch);
    await audit(req, 'users', row.id, 'update', row);
    await takeSnapshot('auto');
    res.json(db.publicUser(row));
  } catch (e) { res.status(400).json({ error: e.message }); }
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
      // ملخص العقد يعيد rent_amount كمجموع الأقساط المخلوطة عند وجود زيادة
      // مجدولة (تحديث 48) — لكن العميل يحتاج مبلغ العقد الأصلي كما هو في
      // قاعدة البيانات (نموذج التعديل/التجديد/الخطابات)، والمجموع المخلوط
      // متاح أصلاً في contract_total (تحديث 53)
      rent_amount: Number(c.rent_amount) || 0,
    };
  });
}

// ---------- سجل الحركات (تدقيق) ----------
// كتابة السجل لا تعطّل العملية الأساسية أبداً: أي خطأ فيها يُبتلع بصمت.
// إعداد البلد: يضبط وسم العملة في النصوص والمنطقة الزمنية لحساب «اليوم»
const COUNTRY_PRESETS = { sa: { label: 'ر.س', tz: 'Asia/Riyadh' }, eg: { label: 'ج.م', tz: 'Africa/Cairo' } };
let CUR_LABEL = 'ر.س';
function applyCountry(settings) {
  const preset = COUNTRY_PRESETS[(settings && settings.country) || 'sa'] || COUNTRY_PRESETS.sa;
  CUR_LABEL = preset.label;
  calc.setTimezone(preset.tz);
}
const moneyShort = (n) => `${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${CUR_LABEL}`;
async function buildAuditSummary(entity, action, row) {
  const r = row || {};
  const verb = { create: 'إضافة', update: 'تعديل', delete: 'حذف' }[action] || action;
  try {
    if (entity === 'payments') {
      let tenantName = '';
      if (r.contract_id) {
        const c = await db.get('contracts', r.contract_id);
        if (c) { const t = await db.get('tenants', c.tenant_id); if (t) tenantName = t.name; }
      }
      const purpose = calc.paymentPurpose(r);
      const purposeNote = purpose !== 'إيجار' ? ` — مقابل: ${purpose}` : '';
      return `${verb} سند قبض رقم ${r.receipt_no ?? ''} بمبلغ ${moneyShort(r.amount)}${tenantName ? ` للمستأجر ${tenantName}` : ''}${purposeNote}`;
    }
    if (entity === 'expenses') {
      const label = `${r.category || ''}${r.description ? ' — ' + r.description : ''}`.trim();
      if (action === 'delete') return `حذف مصروف: ${label} بمبلغ ${moneyShort(r.amount)}`;
      return `${verb} سند صرف رقم ${r.voucher_no ?? ''}: ${label} بمبلغ ${moneyShort(r.amount)}`;
    }
    if (entity === 'contracts') {
      let tenantName = '', unitLabel = '';
      if (r.tenant_id) { const t = await db.get('tenants', r.tenant_id); if (t) tenantName = t.name; }
      if (r.unit_id) { const u = await db.get('units', r.unit_id); if (u) unitLabel = u.name; }
      return `${verb} عقد رقم ${r.id}${tenantName ? ` للمستأجر ${tenantName}` : ''}${unitLabel ? ` — ${unitLabel}` : ''}`;
    }
    if (entity === 'tenants') return `${verb} مستأجر: ${r.name || `رقم ${r.id}`}`;
    if (entity === 'properties') return `${verb} عقار: ${r.name || `رقم ${r.id}`}`;
    if (entity === 'units') return `${verb} وحدة: ${r.name || `رقم ${r.id}`}`;
    if (entity === 'meter_readings') return `${verb} قراءة عداد للوحدة رقم ${r.unit_id ?? ''}`;
    if (entity === 'settings') return 'تعديل إعدادات المؤسسة';
    if (entity === 'listings') return `${verb} إعلان: ${r.title || `رقم ${r.id}`}${r.status ? ` (${LISTING_STATUS_AR[r.status] || r.status})` : ''}`;
    if (entity === 'letters') {
      const typeLabel = { renewal: 'نهاية إيجار وزيادة', increase: 'زيادة إيجار', eviction: 'إخلاء' }[r.type] || r.type || '';
      let tenantName = '';
      if (r.tenant_id) { const t = await db.get('tenants', r.tenant_id); if (t) tenantName = t.name; }
      return `${verb} خطاب ${typeLabel}${tenantName ? ` للمستأجر ${tenantName}` : ''}`;
    }
    if (entity === 'users') return `${verb} حساب مستخدم: ${r.display_name || r.username || `رقم ${r.id}`}${r.role ? ` (${r.role === 'admin' ? 'مدير' : 'موظف'})` : ''}`;
    if (entity === 'backups') {
      if (action === 'restore') return `استعادة النسخة الاحتياطية رقم ${r.id ?? ''}`;
      return `${verb} نسخة احتياطية رقم ${r.id ?? ''}`;
    }
  } catch (_) { /* نكمل بالملخص العام */ }
  return `${verb} ${entity} رقم ${r.id ?? ''}`.trim();
}
async function audit(req, entity, entityId, action, row) {
  try {
    const summary = await buildAuditSummary(entity, action, row);
    await db.insertAudit({ actor: actorOf(req), entity, entity_id: entityId, action, summary });
  } catch (_) { /* التسجيل اختياري ولا يجب أن يفشل العملية */ }
}

// ---------- النسخ الاحتياطية التلقائية ----------
// حمولة النسخة الكاملة بنفس صيغة ملف التصدير — مصدر واحد للتنزيل واللقطات معاً
async function buildBackupPayload() {
  const data = await db.exportAll();
  return { app: 'property-management-app', version: 1, exported_at: new Date().toISOString(), data };
}
// أخذ لقطة كاملة + تطبيق قاعدة الاحتفاظ (أحدث لقطة فقط + أمان مثبّتة مؤقتاً).
// opts.pinned: لقطة أمان قبل استعادة/استيراد — تنجو من الحذف حتى اللقطة التالية
// لما بعد العملية. كالأudit تماماً: أي خطأ يُبتلع بصمت حتى لا تعطّل اللقطة
// العملية الأساسية أبداً.
async function takeSnapshot(trigger, opts = {}) {
  try {
    const payload = await buildBackupPayload();
    const row = await db.insertBackup({ trigger, data: payload, pinned: !!opts.pinned });
    await db.pruneBackups();
    if (row && row.id) queueDriveUpload(row.id, payload, row.created_at);
    return row;
  } catch (_) { return null; }
}

// رفع اللقطة إلى Google Drive في الخلفية (fire-and-forget): لا ينتظره أي طلب،
// وفشله لا يؤثر في اللقطة ولا في العملية الأساسية — تُسجَّل نتيجته فقط على
// صف اللقطة (drive_status / drive_error). الرفعات متسلسلة عبر سلسلة وعود
// حتى لا تتزاحم الطلبات على Drive عند تتابع تغييرات سريعة.
let driveChain = Promise.resolve();
function queueDriveUpload(backupId, payload, createdAt) {
  if (!drive.configured()) return;
  driveChain = driveChain.then(async () => {
    try {
      await drive.uploadSnapshot(payload, createdAt);
      await db.updateBackupDrive(backupId, { drive_status: 'synced', drive_error: null });
    } catch (e) {
      try {
        await db.updateBackupDrive(backupId, {
          drive_status: 'failed',
          drive_error: String((e && e.message) || e || 'خطأ غير معروف').slice(0, 200),
        });
      } catch (_) { /* حتى تسجيل الفشل لا يجب أن يرمي */ }
    }
  }).catch(() => {});
}

// ---------- منع تكرار الوحدة داخل نفس العقار (تحديث 57) ----------
// مفتاح مقارنة اسم الوحدة: مسافات زائدة مهملة، والأرقام العربية (٠-٩)
// والمشرقية (۰-۹) موحّدة مع الإنجليزية، والحروف اللاتينية بلا حساسية حالة
function unitNameKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .toLowerCase();
}
// يعيد رسالة خطأ إن وُجدت وحدة بنفس الاسم داخل نفس العقار (عدا excludeId)
async function duplicateUnitError(propertyId, name, excludeId) {
  if (propertyId == null || propertyId === '' || !String(name || '').trim()) return null;
  const key = unitNameKey(name);
  const units = await db.list('units');
  const dup = units.find((u) => Number(u.property_id) === Number(propertyId)
    && (excludeId == null || Number(u.id) !== Number(excludeId))
    && unitNameKey(u.name) === key);
  return dup ? 'هذه الوحدة موجودة بالفعل في نفس العقار' : null;
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
      try {
        const body = { ...(req.body || {}) };
        if (table === 'units') {
          const dupErr = await duplicateUnitError(body.property_id, body.name, null);
          if (dupErr) return res.status(400).json({ error: dupErr });
        }
        if (table === 'expenses') body.created_by = actorOf(req); // «أصدره» على سند الصرف
        if (table === 'letters') body.created_by = actorOf(req); // مُصدر الخطاب
        const row = await db.insert(table, body);
        await audit(req, table, row.id, 'create', row);
        await takeSnapshot('auto');
        res.status(201).json(row);
      }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
  }
  app.put(`/api/${table}/:id`, auth, async (req, res) => {
    try {
      const putBody = req.body || {};
      if (table === 'units') {
        // منع التكرار عند التعديل أيضاً: الاسم/العقار الفعّالان بعد التعديل
        const existingUnit = await db.get('units', req.params.id);
        if (!existingUnit) return res.status(404).json({ error: 'غير موجود' });
        const effPid = putBody.property_id !== undefined ? putBody.property_id : existingUnit.property_id;
        const effName = putBody.name !== undefined ? putBody.name : existingUnit.name;
        const dupErr = await duplicateUnitError(effPid, effName, req.params.id);
        if (dupErr) return res.status(400).json({ error: dupErr });
      }
      if (table === 'payments' && (putBody.period_from !== undefined || putBody.period_to !== undefined)) {
        const existing = await db.get('payments', req.params.id);
        if (!existing) return res.status(404).json({ error: 'غير موجود' });
        const b = putBody;
        const pf = b.period_from !== undefined ? (b.period_from ? String(b.period_from).slice(0, 10) : null) : (existing.period_from ? calc.fmtDate(existing.period_from) : null);
        const pt = b.period_to !== undefined ? (b.period_to ? String(b.period_to).slice(0, 10) : null) : (existing.period_to ? calc.fmtDate(existing.period_to) : null);
        const periodError = checkPeriod(pf, pt);
        if (periodError) return res.status(400).json({ error: periodError });
      }
      let bodyToSave = req.body || {};
      if (table === 'payments') {
        // أي تعديل على سند قبض يُختم عليه: وقت التعديل وعدّاد تعديلات (يُطبع «نسخة معدّلة»)
        const existingPay = await db.get('payments', req.params.id);
        if (!existingPay) return res.status(404).json({ error: 'غير موجود' });
        bodyToSave = { ...bodyToSave, edited_at: new Date().toISOString(), edit_count: (Number(existingPay.edit_count) || 0) + 1 };
        // تطبيع تاريخ العملية عند التعديل (تحديث 56): ISO صالح أو null
        if (bodyToSave.method_date !== undefined) {
          const md = bodyToSave.method_date ? String(bodyToSave.method_date).slice(0, 10) : null;
          if (md && !/^\d{4}-\d{2}-\d{2}$/.test(md)) return res.status(400).json({ error: 'تاريخ التحويل/الشيك/المنصة غير صالح' });
          bodyToSave = { ...bodyToSave, method_date: md };
        }
        // تطبيع رقم القسط: لدفعات الإيجار فقط وضمن عدد أقساط العقد، وإلا يُصفَّر (تلقائي)
        if (bodyToSave.installment_no !== undefined || bodyToSave.purpose !== undefined || bodyToSave.contract_id !== undefined) {
          const cid = bodyToSave.contract_id !== undefined ? Number(bodyToSave.contract_id) : existingPay.contract_id;
          const cForInst = await db.get('contracts', cid);
          const purposeNow = bodyToSave.purpose !== undefined ? bodyToSave.purpose : existingPay.purpose;
          let k = bodyToSave.installment_no !== undefined ? Number(bodyToSave.installment_no) : Number(existingPay.installment_no);
          if (purposeNow !== 'إيجار' || !cForInst || !Number.isFinite(k) || k < 1 || k > calc.installmentsCount(cForInst)) k = null;
          else k = Math.floor(k);
          bodyToSave = { ...bodyToSave, installment_no: k };
        }
      }
      const row = await db.update(table, req.params.id, bodyToSave);
      if (!row) return res.status(404).json({ error: 'غير موجود' });
      await audit(req, table, row.id, 'update', row);
      await takeSnapshot('auto');
      res.json(row);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete(`/api/${table}/:id`, auth, adminOnlyDelete, async (req, res) => {
    try {
      const before = await db.get(table, req.params.id);
      if (table === 'payments') {
        // حذف سند القبض غير نهائي: يُعلَّم محذوفاً فيختفي من القوائم والحسابات ويبقى قابلاً للاسترجاع
        await db.update('payments', req.params.id, { deleted_at: new Date().toISOString() });
      } else {
        await db.remove(table, req.params.id);
      }
      if (before) await audit(req, table, before.id, 'delete', before);
      await takeSnapshot('auto');
      res.json({ ok: true });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}

// ---------- العقود مع الملخصات ----------
app.get('/api/contracts-full', auth, async (req, res) => {
  try { res.json(await enrichedContracts()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- الدفعات وسندات القبض ----------
// التحقق من فترة سداد: تواريخ ميلادية بصيغة ISO ونهايتها ليست قبل بدايتها
function checkPeriod(period_from, period_to) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (period_from && !iso.test(String(period_from))) return 'تاريخ بداية فترة السداد غير صالح';
  if (period_to && !iso.test(String(period_to))) return 'تاريخ نهاية فترة السداد غير صالح';
  if (period_from && period_to && String(period_to) < String(period_from)) {
    return 'تاريخ نهاية فترة السداد يجب أن يكون بعد تاريخ بدايتها أو مساوياً له';
  }
  return null;
}

app.post('/api/payments', auth, async (req, res) => {
  try {
    const body = req.body || {};
    // سند «تصفية إيجار» بلا عقد (تحديث 59 — بطلب عبده): استلام مبلغ تصفية
    // لا عقد له في النظام — يُقبل بلا contract_id بشرط اسم الدافع، ويُحفظ
    // بغرض «تصفية إيجار» وعقار اختياري يربطه بكشف مالك ذلك العقار.
    const noContract = !body.contract_id;
    const payerName = String(body.payer_name || '').trim();
    if (!(Number(body.amount) > 0)) {
      return res.status(400).json({ error: 'أدخل مبلغاً صحيحاً' });
    }
    if (noContract && !payerName) {
      return res.status(400).json({ error: 'اختر العقد، أو اختر «بدون عقد — تصفية إيجار» واكتب اسم الدافع' });
    }
    let settlePropertyId = null;
    if (noContract && body.property_id) {
      const prop = await db.get('properties', Number(body.property_id));
      if (!prop) return res.status(400).json({ error: 'العقار المختار غير موجود' });
      settlePropertyId = prop.id;
    }
    // وحدة الحجز الاختيارية (تحديث 60 — للعربون غالباً): يجب أن توجد،
    // وعقارها يُستنتج منها إن لم يُختر، ويطابق العقار المختار إن اختير الاثنان
    const ncPurpose = body.purpose === 'عربون' ? 'عربون' : 'تصفية إيجار';
    let settleUnitId = null;
    if (noContract && body.unit_id) {
      const unit = await db.get('units', Number(body.unit_id));
      if (!unit) return res.status(400).json({ error: 'الوحدة المختارة غير موجودة' });
      settleUnitId = unit.id;
      if (settlePropertyId == null) settlePropertyId = unit.property_id;
      else if (settlePropertyId !== unit.property_id) {
        return res.status(400).json({ error: 'الوحدة المختارة لا تتبع العقار المختار' });
      }
    }
    const paymentDate = body.payment_date || calc.fmtDate(new Date());
    // تاريخ العملية (تحديث 56 — بطلب عبده): تاريخ التحويل/الشيك/المنصة إن
    // اختلف عن تاريخ السند، اختياري ويُخزَّن كما هو بصيغة ISO
    const methodDate = body.method_date ? String(body.method_date).slice(0, 10) : null;
    if (methodDate && !/^\d{4}-\d{2}-\d{2}$/.test(methodDate)) {
      return res.status(400).json({ error: 'تاريخ التحويل/الشيك/المنصة غير صالح' });
    }
    const purpose = noContract ? ncPurpose
      : (calc.PAYMENT_PURPOSES.includes(body.purpose) && body.purpose !== 'تصفية إيجار' && body.purpose !== 'عربون' ? body.purpose : 'إيجار');
    const contract = noContract ? null : await db.get('contracts', Number(body.contract_id));
    // رقم القسط الصريح: لدفعات الإيجار فقط وضمن عدد أقساط العقد، وإلا null (تلقائي)
    let installmentNo = null;
    if (purpose === 'إيجار' && contract) {
      const k = Number(body.installment_no);
      if (Number.isFinite(k) && k >= 1 && k <= calc.installmentsCount(contract)) installmentNo = Math.floor(k);
    }
    // فترة السداد: ما أرسله المستخدم، وما نقص منها يُستكمل من فترة القسط
    // المحدد إن وُجد، وإلا من فترة القسط الذي تقع فيه الدفعة (calc.paymentPeriod)
    let periodFrom = body.period_from ? String(body.period_from).slice(0, 10) : null;
    let periodTo = body.period_to ? String(body.period_to).slice(0, 10) : null;
    if (!periodFrom || !periodTo) {
      const def = contract ? (installmentNo ? calc.installmentPeriod(contract, installmentNo) : calc.paymentPeriod(contract, { payment_date: paymentDate })) : null;
      if (def) {
        periodFrom = periodFrom || def.period_from;
        periodTo = periodTo || def.period_to;
      }
    }
    const periodError = checkPeriod(periodFrom, periodTo);
    if (periodError) return res.status(400).json({ error: periodError });
    const payment = await db.insertPayment({
      contract_id: noContract ? null : Number(body.contract_id),
      payer_name: noContract ? payerName : null,
      property_id: noContract ? settlePropertyId : null,
      unit_id: noContract ? settleUnitId : null,
      amount: Number(body.amount),
      payment_date: paymentDate,
      method: body.method || 'تحويل',
      method_date: methodDate,
      purpose,
      notes: body.notes || '',
      period_from: periodFrom,
      period_to: periodTo,
      installment_no: installmentNo,
      created_by: actorOf(req),
    });
    await audit(req, 'payments', payment.id, 'create', payment);
    await takeSnapshot('auto');
    res.status(201).json(payment);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// رمز تحقق سند القبض: أول 8 خانات سداسية عشرية من SHA-256 لبصمة السند
// (رقم السند|المبلغ|التاريخ|العقد|سر المصادقة) — ثابت لنفس السند ويتغير بتغيّر أيٍّ من بياناته
function receiptVerifyCode(payment) {
  const raw = `${payment.receipt_no}|${Number(payment.amount)}|${calc.fmtDate(payment.payment_date)}|${payment.contract_id}|${AUTH_SECRET}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

// ملخص نصي للسند يُرمَّز في رمز QR على السند المطبوع، لمقارنته مع الورقة
function receiptQrText({ payment, receipt_no, tenant, settings, verify_code }) {
  const lines = [
    `سند قبض رقم ${String(receipt_no).padStart(4, '0')}`,
    settings && settings.company_name ? `المكتب: ${settings.company_name}` : null,
    `المستأجر: ${tenant ? tenant.name : ''}`,
    `المبلغ: ${Number(payment.amount)} ${CUR_LABEL}`,
    `التاريخ: ${calc.fmtDate(payment.payment_date)}`,
    `طريقة الدفع: ${payment.method || ''}`,
    payment.method_date ? `تاريخ العملية: ${calc.fmtDate(payment.method_date)}` : null,
    `رمز التحقق: ${verify_code}`,
  ];
  return lines.filter(Boolean).join('\n');
}

// بيانات سند قبض كاملة للطباعة
app.get('/api/payments/:id/receipt', auth, async (req, res) => {
  try {
    const payment = await db.get('payments', req.params.id);
    if (!payment) return res.status(404).json({ error: 'غير موجود' });
    const contract = payment.contract_id ? await db.get('contracts', payment.contract_id) : null;
    const tenant = contract ? await db.get('tenants', contract.tenant_id) : null;
    const unit = contract ? await db.get('units', contract.unit_id)
      : (payment.unit_id ? await db.get('units', payment.unit_id) : null);
    // سند تصفية بلا عقد (تحديث 59): العقار من حقل السند نفسه، واسم المستأجر
    // المعروض على السند ورمز QR هو اسم الدافع الحر
    const property = unit ? await db.get('properties', unit.property_id)
      : (payment.property_id ? await db.get('properties', payment.property_id) : null);
    const tenantOut = tenant || (!contract && payment.payer_name ? { name: payment.payer_name } : null);
    const allPays = payment.contract_id
      ? (await db.list('payments')).filter((p) => p.contract_id === payment.contract_id)
      : [];
    const summary = contract ? calc.contractSummary(contract, allPays) : null;
    // دفعة غير إيجارية لا قسط لها — تُخفى فقرة القسط من السند كلياً
    let installment = contract ? calc.installmentInfo(contract, allPays, payment.id) : null;
    if (installment && installment.installment_index == null) installment = null;
    // باقي القسط وتصنيفه (باقي/متأخر) — لدفعات الإيجار فقط، ويصح أيضاً مع
    // السداد المقدم قبل الاستحقاق؛ وإن كانت الدفعة محددةً لقسط بعينه وبقي
    // منه شيء فباقي ذلك القسط هو المعروض
    const installment_balance = (contract && installment) ? calc.installmentBalanceForPayment(contract, allPays, payment) : null;
    const settings = await db.getSettings();
    const verify_code = receiptVerifyCode(payment);
    const normPayment = {
      ...payment,
      payment_date: calc.fmtDate(payment.payment_date),
      period_from: payment.period_from ? calc.fmtDate(payment.period_from) : null,
      period_to: payment.period_to ? calc.fmtDate(payment.period_to) : null,
    };
    res.json({
      receipt_no: payment.receipt_no,
      payment: normPayment,
      issued_by: await displayNameFor(payment.created_by),
      tenant: tenantOut, unit, property,
      contract: contract ? { ...contract, start_date: calc.fmtDate(contract.start_date), end_date: calc.fmtDate(contract.end_date) || null } : null,
      summary,
      installment,
      installment_balance,
      settings,
      verify_code,
      qr_text: receiptQrText({ payment: normPayment, receipt_no: payment.receipt_no, tenant: tenantOut, settings, verify_code }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- سلة السندات المحذوفة (حذف غير نهائي) ----------
app.get('/api/payments-trash', auth, async (req, res) => {
  try { res.json(await db.listTrash('payments')); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/payments/:id/restore', auth, adminOnlyDelete, async (req, res) => {
  try {
    const row = await db.update('payments', req.params.id, { deleted_at: null });
    if (!row) return res.status(404).json({ error: 'غير موجود' });
    await audit(req, 'payments', row.id, 'update', row);
    await takeSnapshot('auto');
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// بيانات سند صرف كاملة للطباعة
app.get('/api/expenses/:id/voucher', auth, async (req, res) => {
  try {
    const expense = await db.get('expenses', req.params.id);
    if (!expense) return res.status(404).json({ error: 'غير موجود' });
    const property = expense.property_id ? await db.get('properties', expense.property_id) : null;
    const unit = expense.unit_id ? await db.get('units', expense.unit_id) : null;
    res.json({
      voucher_no: expense.voucher_no,
      expense: { ...expense, expense_date: calc.fmtDate(expense.expense_date) },
      issued_by: await displayNameFor(expense.created_by),
      property, unit,
      settings: await db.getSettings(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- إعدادات المؤسسة ----------
app.get('/api/settings', auth, async (req, res) => {
  try { res.json(await db.getSettings()); } catch (e) { res.status(500).json({ error: e.message }); }
});
const LOGO_MAX_BYTES = 700 * 1024;
app.put('/api/settings', auth, adminOnly, async (req, res) => {
  try {
    const body = req.body || {};
    // التحقق من الشعار: صورة PNG/JPG/WebP كرابط بيانات (data URL) بحد أقصى 700 كيلوبايت
    if (body.company_logo) {
      const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.company_logo).trim());
      if (!m) return res.status(400).json({ error: 'صيغة الشعار غير صالحة — يجب أن تكون صورة PNG أو JPG أو WebP' });
      const size = Buffer.from(m[2].replace(/\s/g, ''), 'base64').length;
      if (!size) return res.status(400).json({ error: 'ملف الشعار فارغ أو تالف' });
      if (size > LOGO_MAX_BYTES) return res.status(400).json({ error: 'حجم الشعار يتجاوز الحد الأقصى (700 كيلوبايت)' });
      body.company_logo = `data:${m[1]};base64,${m[2].replace(/\s/g, '')}`;
    }
    const saved = await db.setSettings(body);
    applyCountry(saved);
    await audit(req, 'settings', null, 'update', {});
    await takeSnapshot('auto');
    res.json(saved);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- المرفقات ----------
app.get('/api/attachments', auth, async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    if (!entity_type || !entity_id) return res.status(400).json({ error: 'حدد الكيان المطلوب' });
    res.json(await db.listAttachments(entity_type, Number(entity_id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/attachments', auth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!db.ATTACHMENT_TYPES.includes(b.entity_type)) return res.status(400).json({ error: 'نوع كيان غير صالح' });
    if (!db.ATTACHMENT_MIMES.includes(b.mime)) return res.status(400).json({ error: 'يسمح فقط بملفات الصور أو PDF' });
    if (!b.entity_id || !b.data_base64) return res.status(400).json({ error: 'بيانات الملف ناقصة' });
    const buf = Buffer.from(String(b.data_base64), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'ملف فارغ' });
    if (buf.length > db.ATTACHMENT_MAX) return res.status(400).json({ error: 'حجم الملف يتجاوز 3 ميجابايت' });
    const row = await db.insertAttachment({
      entity_type: b.entity_type, entity_id: Number(b.entity_id),
      filename: String(b.filename || 'ملف'), mime: b.mime,
      size: buf.length, data_base64: String(b.data_base64),
    });
    res.status(201).json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/attachments/:id/download', auth, async (req, res) => {
  try {
    const a = await db.getAttachment(req.params.id);
    if (!a) return res.status(404).json({ error: 'غير موجود' });
    const buf = Buffer.from(a.data_base64, 'base64');
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.filename || 'file')}`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/attachments/:id', auth, adminOnlyDelete, async (req, res) => {
  try { await db.removeAttachment(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- كشف حساب مستأجر (لعقد واحد) ----------
app.get('/api/contracts/:id/statement', auth, async (req, res) => {
  try {
    const contract = await db.get('contracts', req.params.id);
    if (!contract) return res.status(404).json({ error: 'غير موجود' });
    const [tenant, unit, payments] = await Promise.all([
      db.get('tenants', contract.tenant_id), db.get('units', contract.unit_id), db.list('payments'),
    ]);
    const property = unit ? await db.get('properties', unit.property_id) : null;
    const cps = payments.filter((p) => p.contract_id === contract.id);
    const summary = calc.contractSummary(contract, cps);
    // مبالغ الأقساط الفردية: إجمالي الإيجار مقسوماً على عدد الدفعات
    const amounts = calc.installmentAmounts(contract);
    // الأقساط المستحقة: حتى نهاية العقد إن وُجدت، وإلا حتى اليوم
    const limit = contract.end_date ? calc.toDate(contract.end_date) : calc.today();
    const starts = calc.periodStarts(contract, limit);
    const events = [];
    starts.forEach((s, i) => {
      if (i >= amounts.length) return;
      events.push({ date: calc.fmtDate(s), type: 'due', description: `قسط مستحق ${i + 1} من ${amounts.length}`, due: amounts[i], paid: 0 });
    });
    // الرصيد الافتتاحي: سطر مدفوع في أول الكشف (محصّل قبل البرنامج — ليس سنداً)
    const openingAmt = calc.openingAmount(contract);
    if (openingAmt > 0) {
      events.push({ date: calc.fmtDate(contract.start_date), type: 'opening', description: 'رصيد افتتاحي — محصّل قبل استخدام البرنامج', due: 0, paid: openingAmt });
    }
    for (const p of cps) {
      const purpose = calc.paymentPurpose(p);
      if (calc.isRentPayment(p)) {
        events.push({
          date: calc.fmtDate(p.payment_date), type: 'payment',
          description: `دفعة إيجار — سند قبض رقم ${String(p.receipt_no).padStart(4, '0')}`,
          due: 0, paid: Number(p.amount) || 0, receipt_no: p.receipt_no,
        });
      } else {
        // مدفوعات غير إيجارية: صفوف معلوماتية بمبلغها في حقل مستقل،
        // ولا تدخل في رصيد الإيجار الجاري إطلاقاً (paid = 0 في حركة الرصيد)
        events.push({
          date: calc.fmtDate(p.payment_date), type: 'other', purpose,
          description: `دفعة ${purpose} — سند قبض رقم ${String(p.receipt_no).padStart(4, '0')}`,
          due: 0, paid: 0, other_amount: Number(p.amount) || 0, receipt_no: p.receipt_no,
        });
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'due' ? -1 : 1));
    let bal = 0;
    const ledger = events.map((e) => {
      bal = Math.round((bal + e.due - e.paid) * 100) / 100;
      return { ...e, balance: bal };
    });
    const totalDue = calc.round2(events.reduce((s, e) => s + e.due, 0));
    const totalPaid = calc.round2(calc.rentPayments(cps).reduce((s, p) => s + (Number(p.amount) || 0), 0) + calc.openingAmount(contract));
    const totalOtherPaid = calc.round2(cps.filter((p) => !calc.isRentPayment(p)).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    res.json({
      tenant, unit, property,
      contract: { ...contract, start_date: calc.fmtDate(contract.start_date), end_date: calc.fmtDate(contract.end_date) || null },
      summary, ledger,
      total_due: totalDue, total_paid: totalPaid, total_other_paid: totalOtherPaid,
      remaining: Math.round((totalDue - totalPaid) * 100) / 100,
      settings: await db.getSettings(),
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
      const hay = `${t.name} ${t.phone} ${t.id_number} ${t.contract_no || ''} ${unitNames}`;
      if (q && !hay.includes(q)) continue;
      let totalPaid = 0, receipts = 0, arrears = 0;
      for (const c of tContracts) {
        const ps = paysByContract[c.id] || [];
        // «إجمالي ما سدده» في البحث = مدفوعات الإيجار فقط (موقف الإيجار)،
        // بينما عدد السندات يشمل كل السندات أياً كان مقابلها
        totalPaid += calc.rentPayments(ps).reduce((s, p) => s + Number(p.amount || 0), 0) + calc.openingAmount(c);
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
      // القسط التالي غير المسدد (من دفعات الإيجار فقط) — يستخدمه التذكير المسبق
      const nu = calc.nextUnpaidInstallment(c, ps);
      return {
        ...c, start_date: calc.fmtDate(c.start_date), end_date: calc.fmtDate(c.end_date) || null,
        unit_name: u.name || '', property_name: (propById[u.property_id] || {}).name || '',
        ...calc.contractSummary(c, ps),
        next_unpaid: nu ? { index: nu.index, due_date: nu.due_date, amount: nu.amount, remaining: nu.remaining } : null,
      };
    });
    // إجمالي ملف المستأجر = مدفوعات الإيجار فقط؛ سجل السندات نفسه يعرض الكل
    const totalPaid = history.filter((p) => calc.isRentPayment(p)).reduce((s, p) => s + Number(p.amount || 0), 0);
    const arrears = enriched.reduce((s, c) => s + c.arrears, 0);
    res.json({ tenant, contracts: enriched, payments: history, total_paid: totalPaid, receipts_count: history.length, arrears });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- كشف حساب المالك ----------
// تصنيف مصروفات خاص: دفعة مُسلَّمة للمالك من رصيده — تُفصل عن المصروفات
// العادية في الكشوف، وتدخل في رصيد المالك المستحق مطروحةً وحدها.
const OWNER_PAYOUT_CATEGORY = 'دفعة للمالك';

// حساب بيانات الكشف (مشترك بين العرض JSON وملف الإكسل)
async function ownerStatementData(property, from, to) {
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
    // دفعات «خدمات» مال المكتب نفسه (عمولته): لا تظهر في كشف المالك إطلاقاً —
    // لا صفوف ولا داخل الإجماليات والصافي (الإجماليات تُحسب من الصفوف)
    .filter((p) => !calc.isOfficePayment(p))
    .map((p) => {
      const c = propContracts.find((x) => x.id === p.contract_id);
      return {
        date: calc.fmtDate(p.payment_date), receipt_no: p.receipt_no,
        description: `${calc.paymentPurpose(p)} ${(unitById[c.unit_id] || {}).name || ''} — ${(tenantById[c.tenant_id] || {}).name || ''}`,
        amount: Number(p.amount),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  // سندات «تصفية إيجار» بلا عقد المرتبطة بهذا العقار مباشرة (تحديث 59):
  // إيراد إيجار للمالك بلا عقد — تظهر صفاً وإجمالاً كأي تحصيل على العقار
  for (const p of payments) {
    if (p.contract_id != null || p.property_id !== property.id) continue;
    if (calc.paymentPurpose(p) !== 'تصفية إيجار') continue; // العربون لا يدخل كشف المالك (تحديث 60)
    const d = calc.fmtDate(p.payment_date);
    if (d < from || d > to) continue;
    incomeRows.push({
      date: d, receipt_no: p.receipt_no,
      description: `تصفية إيجار — ${p.payer_name || ''} (بدون عقد)`,
      amount: Number(p.amount),
    });
  }
  incomeRows.sort((a, b) => a.date.localeCompare(b.date));
  const propExpenses = expenses
    .filter((e) => e.property_id === property.id && calc.fmtDate(e.expense_date) >= from && calc.fmtDate(e.expense_date) <= to)
    .map((e) => ({
      date: calc.fmtDate(e.expense_date), category: e.category, voucher_no: e.voucher_no,
      description: `${e.category}${e.description ? ' — ' + e.description : ''}${e.unit_id ? ' (' + ((unitById[e.unit_id] || {}).name || '') + ')' : ''}`,
      amount: Number(e.amount),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  // دفعات المالك نوع مستقل: لا تختلط بالمصروفات العادية، والصافي = إيراد − مصروفات − دفعات
  const expenseRows = propExpenses.filter((e) => e.category !== OWNER_PAYOUT_CATEGORY);
  const payoutRows = propExpenses.filter((e) => e.category === OWNER_PAYOUT_CATEGORY);

  const totalIncome = incomeRows.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenseRows.reduce((s, r) => s + r.amount, 0);
  const totalPayouts = payoutRows.reduce((s, r) => s + r.amount, 0);
  return {
    income: incomeRows, expenses: expenseRows, payouts: payoutRows,
    total_income: totalIncome, total_expenses: totalExpenses, total_payouts: totalPayouts,
    net: Math.round((totalIncome - totalExpenses - totalPayouts) * 100) / 100,
    settings: await db.getSettings(),
  };
}

// ---------- الملاك: القائمة والأرصدة المستحقة (لكل الفترات) ----------
// رصيد المالك المستحق = كل ما حُصّل على عقاراته (باستثناء دفعات «خدمات» —
// مال المكتب) − مصروفات عقاراته العادية − الدفعات المسلَّمة له.
async function ownersData() {
  const [properties, units, contracts, payments, expenses] = await Promise.all([
    db.list('properties'), db.list('units'), db.list('contracts'), db.list('payments'), db.list('expenses'),
  ]);
  const unitProp = new Map(units.map((u) => [u.id, u.property_id]));
  const contractById = new Map(contracts.map((c) => [c.id, c]));
  const propOfContract = (c) => {
    if (!c) return null;
    const pid = unitProp.get(c.unit_id);
    return pid != null ? pid : (c.property_id != null ? c.property_id : null);
  };
  const groups = new Map();
  for (const p of properties) {
    const key = calc.normalizeOwnerName(p.owner_name);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        key, name: String(p.owner_name).trim().replace(/\s+/g, ' '),
        property_ids: new Set(),
      });
    }
    groups.get(key).property_ids.add(p.id);
  }
  const owners = [];
  for (const g of groups.values()) {
    let collected = 0, expTotal = 0, payouts = 0;
    for (const pay of payments) {
      if (calc.isOfficePayment(pay)) continue;
      // سند تصفية بلا عقد (تحديث 59): عقاره مأخوذ من حقل السند نفسه —
      // والعربون مستثنى: مبلغ حجز معلّق لا يدخل رصيد المالك (تحديث 60)
      let pid = null;
      if (pay.contract_id != null) pid = propOfContract(contractById.get(pay.contract_id));
      else if (calc.paymentPurpose(pay) === 'تصفية إيجار' && pay.property_id != null) pid = pay.property_id;
      if (pid != null && g.property_ids.has(pid)) collected += Number(pay.amount) || 0;
    }
    for (const e of expenses) {
      if (e.property_id == null || !g.property_ids.has(e.property_id)) continue;
      if (e.category === OWNER_PAYOUT_CATEGORY) payouts += Number(e.amount) || 0;
      else expTotal += Number(e.amount) || 0;
    }
    owners.push({
      key: g.key, name: g.name,
      properties_count: g.property_ids.size,
      units_count: units.filter((u) => g.property_ids.has(u.property_id)).length,
      total_collected: calc.round2(collected),
      total_expenses: calc.round2(expTotal),
      total_payouts: calc.round2(payouts),
      balance: calc.round2(collected - expTotal - payouts),
    });
  }
  owners.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return owners;
}

// كشف حساب مجمّع لمالك واحد: قسم لكل عقار (بنفس حساب ownerStatementData —
// لا حسابات منفصلة) + إجماليات عامة + الرصيد المستحق الحالي لكل الفترات.
async function combinedOwnerStatementData(ownerKey, from, to) {
  const owners = await ownersData();
  const owner = owners.find((o) => o.key === ownerKey);
  if (!owner) return null;
  const properties = (await db.list('properties'))
    .filter((p) => calc.normalizeOwnerName(p.owner_name) === ownerKey)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));
  const sections = [];
  for (const p of properties) {
    const st = await ownerStatementData(p, from, to);
    sections.push({ property: { id: p.id, name: p.name, address: p.address || '' }, ...st });
  }
  const sum = (f) => calc.round2(sections.reduce((s, x) => s + (Number(f(x)) || 0), 0));
  return {
    owner: { key: owner.key, name: owner.name },
    from, to,
    sections,
    total_income: sum((x) => x.total_income),
    total_expenses: sum((x) => x.total_expenses),
    total_payouts: sum((x) => x.total_payouts),
    net: sum((x) => x.net),
    balance: owner.balance,
    settings: await db.getSettings(),
  };
}

app.get('/api/properties/:id/statement', auth, async (req, res) => {
  try {
    const property = await db.get('properties', req.params.id);
    if (!property) return res.status(404).json({ error: 'غير موجود' });
    const from = req.query.from || '0001-01-01';
    const to = req.query.to || '9999-12-31';
    const data = await ownerStatementData(property, from, to);
    res.json({ property, from, to, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// كشف حساب المالك كملف إكسل منسّق (xlsx حقيقي عبر exceljs) مع ترويسة المؤسسة وشعارها
app.get('/api/properties/:id/statement.xlsx', auth, async (req, res) => {
  try {
    const property = await db.get('properties', req.params.id);
    if (!property) return res.status(404).json({ error: 'غير موجود' });
    const from = req.query.from || '0001-01-01';
    const to = req.query.to || '9999-12-31';
    const data = await ownerStatementData(property, from, to);
    const s = data.settings || {};

    const wb = new ExcelJS.Workbook();
    wb.creator = s.company_name || 'نظام إدارة الأملاك العقارية';
    const ws = wb.addWorksheet('كشف حساب مالك', { views: [{ rightToLeft: true, showGridLines: false }] });
    ws.columns = [{ width: 14 }, { width: 12 }, { width: 48 }, { width: 16 }, { width: 16 }, { width: 16 }];
    const MONEY_FMT = '#,##0.00';
    const thin = { style: 'thin', color: { argb: 'FFB0B0B0' } };
    const borders = { top: thin, left: thin, bottom: thin, right: thin };
    const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE9EC' } };
    const sectionFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B5563' } };

    let row = 1;
    // الشعار (إن وُجد) — يُضمَّن كصورة أعلى الورقة
    if (s.company_logo && String(s.company_logo).startsWith('data:image/')) {
      const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(String(s.company_logo));
      if (m) {
        try {
          const imgId = wb.addImage({ base64: m[3], extension: m[2] === 'jpeg' ? 'jpeg' : m[2] });
          ws.addImage(imgId, { tl: { col: 2.35, row: 0 }, ext: { width: 110, height: 64 } });
          ws.getRow(1).height = 52;
          row = 2;
        } catch (_) { /* شعار تالف لا يمنع إنشاء الملف */ }
      }
    }
    const mergedCenter = (text, font, fill) => {
      ws.mergeCells(row, 1, row, 6);
      const cell = ws.getCell(row, 1);
      cell.value = text;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      if (font) cell.font = font;
      if (fill) cell.fill = fill;
      row++;
    };
    if (s.company_name) mergedCenter(s.company_name, { bold: true, size: 15, color: { argb: 'FF0B5563' } });
    if (s.company_address) mergedCenter(s.company_address, { size: 11, color: { argb: 'FF666666' } });
    if (s.company_phones) mergedCenter(`هاتف: ${s.company_phones}`, { size: 11, color: { argb: 'FF666666' } });
    if (s.company_extra) mergedCenter(s.company_extra, { size: 11, color: { argb: 'FF666666' } });
    mergedCenter('كشف حساب مالك', { bold: true, size: 16 });
    mergedCenter(`العقار: ${property.name} · المالك: ${property.owner_name || '—'} · الفترة: من ${from} إلى ${to}`, { size: 11, color: { argb: 'FF666666' } });
    row++; // سطر فارغ

    const tableHeader = () => {
      const vals = ['التاريخ', 'رقم السند', 'البيان', 'إيراد', 'مصروف', 'الرصيد'];
      vals.forEach((v, i) => {
        const cell = ws.getCell(row, i + 1);
        cell.value = v;
        cell.font = { bold: true };
        cell.fill = headFill;
        cell.border = borders;
        cell.alignment = { horizontal: 'center' };
      });
      row++;
    };
    const sectionTitle = (text) => {
      ws.mergeCells(row, 1, row, 6);
      const cell = ws.getCell(row, 1);
      cell.value = text;
      cell.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      cell.fill = sectionFill;
      row++;
    };
    const dataRow = (date, no, desc, income, expense, balance) => {
      const vals = [date, no, desc, income, expense, balance];
      vals.forEach((v, i) => {
        const cell = ws.getCell(row, i + 1);
        if (v !== null && v !== undefined && v !== '') cell.value = v;
        cell.border = borders;
        if (i >= 3) { cell.numFmt = MONEY_FMT; cell.alignment = { horizontal: 'left' }; }
      });
      row++;
    };
    const totalRow = (label, colIdx, value, balance) => {
      ws.mergeCells(row, 1, row, 3);
      const lc = ws.getCell(row, 1);
      lc.value = label;
      lc.font = { bold: true };
      lc.border = borders;
      for (let i = 2; i <= 3; i++) ws.getCell(row, i).border = borders;
      const vc = ws.getCell(row, colIdx);
      vc.value = value;
      vc.font = { bold: true };
      vc.numFmt = MONEY_FMT;
      vc.border = borders;
      if (balance !== null && balance !== undefined) {
        const bc = ws.getCell(row, 6);
        bc.value = balance;
        bc.font = { bold: true };
        bc.numFmt = MONEY_FMT;
        bc.border = borders;
      }
      row++;
    };

    let balance = 0;
    sectionTitle('الإيرادات (الإيجارات المحصلة)');
    tableHeader();
    for (const r of data.income) {
      balance = calc.round2(balance + r.amount);
      dataRow(r.date, String(r.receipt_no).padStart(4, '0'), r.description, r.amount, null, balance);
    }
    totalRow('إجمالي الإيرادات', 4, calc.round2(data.total_income), calc.round2(data.total_income));

    row++; // سطر فارغ
    sectionTitle('المصروفات');
    tableHeader();
    for (const r of data.expenses) {
      balance = calc.round2(balance - r.amount);
      dataRow(r.date, '', r.description, null, r.amount, balance);
    }
    totalRow('إجمالي المصروفات', 5, calc.round2(data.total_expenses), calc.round2(balance));

    if (data.payouts && data.payouts.length) {
      row++; // سطر فارغ
      sectionTitle('دفعات للمالك');
      tableHeader();
      for (const r of data.payouts) {
        balance = calc.round2(balance - r.amount);
        dataRow(r.date, r.voucher_no ? String(r.voucher_no).padStart(4, '0') : '', r.description, null, r.amount, balance);
      }
      totalRow('إجمالي دفعات المالك', 5, calc.round2(data.total_payouts), calc.round2(data.net));
    }

    row++; // سطر فارغ
    ws.mergeCells(row, 1, row, 5);
    const netLabel = ws.getCell(row, 1);
    netLabel.value = 'الصافي المستحق للمالك';
    netLabel.font = { bold: true, size: 14, color: { argb: 'FF0B5563' } };
    netLabel.alignment = { horizontal: 'left' };
    const netCell = ws.getCell(row, 6);
    netCell.value = calc.round2(data.net);
    netCell.font = { bold: true, size: 14, color: { argb: 'FF0B5563' } };
    netCell.numFmt = MONEY_FMT;

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="statement-${property.id}-${from}-${to}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- الملاك: قائمة + كشف حساب مجمّع ----------
app.get('/api/owners', auth, async (req, res) => {
  try { res.json(await ownersData()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/owners/statement', auth, async (req, res) => {
  try {
    const ownerKey = calc.normalizeOwnerName(req.query.owner || '');
    const from = req.query.from || '0001-01-01';
    const to = req.query.to || '9999-12-31';
    const data = await combinedOwnerStatementData(ownerKey, from, to);
    if (!data) return res.status(404).json({ error: 'المالك غير موجود' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// كشف حساب المالك المجمّع كملف إكسل: ملف واحد، قسم لكل عقار + إجماليات عامة
app.get('/api/owners/statement.xlsx', auth, async (req, res) => {
  try {
    const ownerKey = calc.normalizeOwnerName(req.query.owner || '');
    const from = req.query.from || '0001-01-01';
    const to = req.query.to || '9999-12-31';
    const data = await combinedOwnerStatementData(ownerKey, from, to);
    if (!data) return res.status(404).json({ error: 'المالك غير موجود' });
    const s = data.settings || {};

    const wb = new ExcelJS.Workbook();
    wb.creator = s.company_name || 'نظام إدارة الأملاك العقارية';
    const ws = wb.addWorksheet('كشف حساب مالك مجمع', { views: [{ rightToLeft: true, showGridLines: false }] });
    ws.columns = [{ width: 14 }, { width: 12 }, { width: 48 }, { width: 16 }, { width: 16 }, { width: 16 }];
    const MONEY_FMT = '#,##0.00';
    const thin = { style: 'thin', color: { argb: 'FFB0B0B0' } };
    const borders = { top: thin, left: thin, bottom: thin, right: thin };
    const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE9EC' } };
    const sectionFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B5563' } };
    const propFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7FA8B8' } };

    let row = 1;
    if (s.company_logo && String(s.company_logo).startsWith('data:image/')) {
      const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(String(s.company_logo));
      if (m) {
        try {
          const imgId = wb.addImage({ base64: m[3], extension: m[2] === 'jpeg' ? 'jpeg' : m[2] });
          ws.addImage(imgId, { tl: { col: 2.35, row: 0 }, ext: { width: 110, height: 64 } });
          ws.getRow(1).height = 52;
          row = 2;
        } catch (_) { /* شعار تالف لا يمنع إنشاء الملف */ }
      }
    }
    const mergedCenter = (text, font, fill) => {
      ws.mergeCells(row, 1, row, 6);
      const cell = ws.getCell(row, 1);
      cell.value = text;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      if (font) cell.font = font;
      if (fill) cell.fill = fill;
      row++;
    };
    if (s.company_name) mergedCenter(s.company_name, { bold: true, size: 15, color: { argb: 'FF0B5563' } });
    if (s.company_address) mergedCenter(s.company_address, { size: 11, color: { argb: 'FF666666' } });
    if (s.company_phones) mergedCenter(`هاتف: ${s.company_phones}`, { size: 11, color: { argb: 'FF666666' } });
    if (s.company_extra) mergedCenter(s.company_extra, { size: 11, color: { argb: 'FF666666' } });
    mergedCenter('كشف حساب مالك — مجمّع (كل العقارات)', { bold: true, size: 16 });
    mergedCenter(`المالك: ${data.owner.name} · الفترة: من ${from} إلى ${to}`, { size: 11, color: { argb: 'FF666666' } });
    mergedCenter(`الرصيد المستحق الحالي (لكل الفترات): ${calc.round2(data.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${CUR_LABEL}`, { bold: true, size: 12, color: { argb: 'FF0B5563' } });
    row++;

    const tableHeader = () => {
      ['التاريخ', 'رقم السند', 'البيان', 'إيراد', 'مصروف', 'الرصيد'].forEach((v, i) => {
        const cell = ws.getCell(row, i + 1);
        cell.value = v;
        cell.font = { bold: true };
        cell.fill = headFill;
        cell.border = borders;
        cell.alignment = { horizontal: 'center' };
      });
      row++;
    };
    const bandTitle = (text, fill) => {
      ws.mergeCells(row, 1, row, 6);
      const cell = ws.getCell(row, 1);
      cell.value = text;
      cell.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      cell.fill = fill || sectionFill;
      row++;
    };
    const dataRow = (date, no, desc, income, expense, balance) => {
      [date, no, desc, income, expense, balance].forEach((v, i) => {
        const cell = ws.getCell(row, i + 1);
        if (v !== null && v !== undefined && v !== '') cell.value = v;
        cell.border = borders;
        if (i >= 3) { cell.numFmt = MONEY_FMT; cell.alignment = { horizontal: 'left' }; }
      });
      row++;
    };
    const totalRow = (label, colIdx, value) => {
      ws.mergeCells(row, 1, row, 3);
      const lc = ws.getCell(row, 1);
      lc.value = label;
      lc.font = { bold: true };
      lc.border = borders;
      for (let i = 2; i <= 3; i++) ws.getCell(row, i).border = borders;
      const vc = ws.getCell(row, colIdx);
      vc.value = value;
      vc.font = { bold: true };
      vc.numFmt = MONEY_FMT;
      vc.border = borders;
      row++;
    };

    for (const sec of data.sections) {
      bandTitle(`العقار: ${sec.property.name}`, propFill);
      let bal = 0;
      bandTitle('الإيرادات (الإيجارات المحصلة)');
      tableHeader();
      for (const r of sec.income) {
        bal = calc.round2(bal + r.amount);
        dataRow(r.date, String(r.receipt_no).padStart(4, '0'), r.description, r.amount, null, bal);
      }
      totalRow('إجمالي إيرادات العقار', 4, sec.total_income);
      bandTitle('المصروفات');
      tableHeader();
      for (const r of sec.expenses) {
        bal = calc.round2(bal - r.amount);
        dataRow(r.date, '', r.description, null, r.amount, bal);
      }
      totalRow('إجمالي مصروفات العقار', 5, sec.total_expenses);
      if (sec.payouts.length) {
        bandTitle('دفعات للمالك');
        tableHeader();
        for (const r of sec.payouts) {
          bal = calc.round2(bal - r.amount);
          dataRow(r.date, r.voucher_no ? String(r.voucher_no).padStart(4, '0') : '', r.description, null, r.amount, bal);
        }
        totalRow('إجمالي دفعات المالك — العقار', 5, sec.total_payouts);
      }
      totalRow('صافي العقار للفترة', 6, sec.net);
      row++;
    }

    bandTitle('الإجماليات العامة للفترة');
    totalRow('إجمالي الإيرادات', 4, data.total_income);
    totalRow('إجمالي المصروفات', 5, data.total_expenses);
    totalRow('إجمالي دفعات المالك', 5, data.total_payouts);
    row++;
    ws.mergeCells(row, 1, row, 5);
    const netLabel = ws.getCell(row, 1);
    netLabel.value = 'صافي الفترة (إيرادات − مصروفات − دفعات للمالك)';
    netLabel.font = { bold: true, size: 14, color: { argb: 'FF0B5563' } };
    netLabel.alignment = { horizontal: 'left' };
    const netCell = ws.getCell(row, 6);
    netCell.value = calc.round2(data.net);
    netCell.font = { bold: true, size: 14, color: { argb: 'FF0B5563' } };
    netCell.numFmt = MONEY_FMT;
    row++;
    ws.mergeCells(row, 1, row, 5);
    const balLabel = ws.getCell(row, 1);
    balLabel.value = 'الرصيد المستحق الحالي (لكل الفترات)';
    balLabel.font = { bold: true, size: 14, color: { argb: 'FF0B5563' } };
    balLabel.alignment = { horizontal: 'left' };
    const balCell = ws.getCell(row, 6);
    balCell.value = calc.round2(data.balance);
    balCell.font = { bold: true, size: 14, color: { argb: 'FF0B5563' } };
    balCell.numFmt = MONEY_FMT;

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="owner-statement-${from}-${to}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- الملخص الشهري للمكتب (كل العقارات) ----------
// تقسيم صفوف التحصيل المجمعة حسب الطريقة إلى أقسام رئيسية:
// نقدي | بنك (تحويل + شبكة/مدى) | شيك | منصة إيجار (بفرعيها) | أخرى
function groupMethodRows(byMethod) {
  const methodGroupOf = (m) => {
    const s = String(m || '');
    if (s.includes('منصة')) return 'منصة إيجار';
    if (s.includes('نقد')) return 'نقدي';
    if (s.includes('فودافون') || s.includes('إنستاباي') || s.includes('محفظة')) return 'محافظ إلكترونية';
    if (s.includes('شيك')) return 'شيك';
    if (s.includes('بنك') || s.includes('تحويل') || s.includes('شبكة') || s.includes('مدى')) return 'بنك';
    return 'أخرى';
  };
  const groupOrder = ['نقدي', 'بنك', 'محافظ إلكترونية', 'شيك', 'منصة إيجار', 'أخرى'];
  const perGroup = new Map();
  for (const row of byMethod) {
    const g = methodGroupOf(row.method);
    if (!perGroup.has(g)) perGroup.set(g, { group: g, total: 0, count: 0, items: [] });
    const b = perGroup.get(g);
    b.total = calc.round2(b.total + row.total);
    b.count += row.count;
    b.items.push(row);
  }
  return groupOrder.filter((g) => perGroup.has(g)).map((g) => perGroup.get(g));
}

app.get('/api/reports/monthly', auth, async (req, res) => {
  try {
    const now = new Date();
    const defMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = String(req.query.month || defMonth);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'صيغة الشهر غير صحيحة — استخدم YYYY-MM' });
    }
    const [payments, expenses, contracts, units, properties] = await Promise.all([
      db.list('payments'), db.list('expenses'), db.list('contracts'), db.list('units'), db.list('properties'),
    ]);
    const unitById = Object.fromEntries(units.map((u) => [u.id, u]));
    const contractById = Object.fromEntries(contracts.map((c) => [c.id, c]));
    const inMonth = (d) => calc.fmtDate(d).startsWith(month);

    // العربون مستثنى من الملخص الشهري كله (تحديث 60): مبلغ حجز معلّق لا إيراد
    const monthPayments = payments.filter((p) => inMonth(p.payment_date) && !calc.isDepositPayment(p));
    const monthExpenses = expenses.filter((e) => inMonth(e.expense_date));

    // تجميع حسب العقار: التحصيل عبر عقد ← وحدة ← عقار، والمصروفات بعقارها المباشر
    const perProp = new Map();
    const bucket = (pid) => {
      if (!perProp.has(pid)) perProp.set(pid, { collected: 0, expenses: 0 });
      return perProp.get(pid);
    };
    for (const p of monthPayments) {
      const c = contractById[p.contract_id];
      const u = c ? unitById[c.unit_id] : null;
      if (u && u.property_id != null) bucket(u.property_id).collected += Number(p.amount || 0);
      // سند تصفية بلا عقد (تحديث 59): يُنسب لعقاره المباشر إن اختير له عقار
      else if (p.contract_id == null && p.property_id != null && calc.paymentPurpose(p) === 'تصفية إيجار') bucket(p.property_id).collected += Number(p.amount || 0);
    }
    for (const e of monthExpenses) {
      if (e.property_id != null) bucket(e.property_id).expenses += Number(e.amount || 0);
    }
    const byProperty = properties
      .map((pr) => {
        const b = perProp.get(pr.id) || { collected: 0, expenses: 0 };
        const collected = calc.round2(b.collected);
        const exps = calc.round2(b.expenses);
        return { property_id: pr.id, property_name: pr.name, collected, expenses: exps, net: calc.round2(collected - exps) };
      })
      .filter((r) => r.collected !== 0 || r.expenses !== 0);

    // تجميع التحصيل حسب طريقة الدفع (يشمل تقسيم منصة إيجار: مكتب/مالك)
    const perMethod = new Map();
    for (const p of monthPayments) {
      const key = p.method || 'تحويل';
      const b = perMethod.get(key) || { total: 0, count: 0 };
      b.total += Number(p.amount || 0);
      b.count += 1;
      perMethod.set(key, b);
    }
    const byMethod = [...perMethod.entries()]
      .map(([method, b]) => ({ method, total: calc.round2(b.total), count: b.count }))
      .sort((a, b) => b.total - a.total);
    const byMethodGrouped = groupMethodRows(byMethod);

    // تجميع التحصيل حسب المقابل (الغرض) — يشمل «خدمات» (مال المكتب) بنداً
    // ظاهراً لوحده، وكل الأغراض داخلة أصلاً في إجمالي التحصيل
    const perPurpose = new Map();
    for (const p of monthPayments) {
      const key = calc.paymentPurpose(p);
      const b = perPurpose.get(key) || { total: 0, count: 0 };
      b.total += Number(p.amount || 0);
      b.count += 1;
      perPurpose.set(key, b);
    }
    const byPurpose = calc.PAYMENT_PURPOSES
      .filter((k) => perPurpose.has(k))
      .map((k) => ({ purpose: k, total: calc.round2(perPurpose.get(k).total), count: perPurpose.get(k).count }));

    const totalCollected = calc.round2(monthPayments.reduce((s, p) => s + Number(p.amount || 0), 0));
    const totalExpenses = calc.round2(monthExpenses.reduce((s, e) => s + Number(e.amount || 0), 0));
    // رصيد المكتب: دخل المكتب هو سندات قبض «خدمات» (مال المكتب نفسه)،
    // ومصروفات المكتب هي المصروفات غير المرتبطة بعقار (property_id فارغ).
    // الرصيد تراكمي منذ البداية، مع حركة الشهر منفصلة.
    const office = {
      services_month: calc.round2(monthPayments.filter((p) => calc.isOfficePayment(p)).reduce((s, p) => s + Number(p.amount || 0), 0)),
      expenses_month: calc.round2(monthExpenses.filter((e) => e.property_id == null).reduce((s, e) => s + Number(e.amount || 0), 0)),
      services_total: calc.round2(payments.filter((p) => calc.isOfficePayment(p)).reduce((s, p) => s + Number(p.amount || 0), 0)),
      expenses_total: calc.round2(expenses.filter((e) => e.property_id == null).reduce((s, e) => s + Number(e.amount || 0), 0)),
    };
    office.month_net = calc.round2(office.services_month - office.expenses_month);
    office.balance = calc.round2(office.services_total - office.expenses_total);
    res.json({
      month,
      total_collected: totalCollected,
      total_expenses: totalExpenses,
      net: calc.round2(totalCollected - totalExpenses),
      office,
      payments_count: monthPayments.length,
      expenses_count: monthExpenses.length,
      by_property: byProperty,
      by_method: byMethod,
      by_method_grouped: byMethodGrouped,
      by_purpose: byPurpose,
      settings: await db.getSettings(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- تقارير السندات (قبض / صرف) ----------
// تقرير جدولي لكل عملية على حدة، بفلاتر: نوع التقرير + فترة تاريخية + عقار اختياري.
// الحساب مشترك بين العرض JSON وملف الإكسل حتى لا يختلفا أبداً.
async function vouchersReportData(type, from, to, propertyId) {
  const [payments, expenses, contracts, units, tenants, properties] = await Promise.all([
    db.list('payments'), db.list('expenses'), db.list('contracts'),
    db.list('units'), db.list('tenants'), db.list('properties'),
  ]);
  const unitById = Object.fromEntries(units.map((u) => [u.id, u]));
  const tenantById = Object.fromEntries(tenants.map((t) => [t.id, t]));
  const propById = Object.fromEntries(properties.map((p) => [p.id, p]));
  const contractById = Object.fromEntries(contracts.map((c) => [c.id, c]));
  const paysByContract = {};
  for (const p of payments) (paysByContract[p.contract_id] = paysByContract[p.contract_id] || []).push(p);
  const inRange = (d) => { const s = calc.fmtDate(d); return s >= from && s <= to; };
  const wantedProp = propertyId != null && propertyId !== '' ? Number(propertyId) : null;

  let rows = [];
  if (type === 'receipts') {
    rows = payments
      .filter((p) => inRange(p.payment_date))
      .map((p) => {
        const c = contractById[p.contract_id] || {};
        const u = c.unit_id != null ? (unitById[c.unit_id] || {}) : {};
        const pf = p.period_from ? calc.fmtDate(p.period_from) : null;
        const pt = p.period_to ? calc.fmtDate(p.period_to) : null;
        return {
          date: calc.fmtDate(p.payment_date),
          receipt_no: p.receipt_no,
          tenant_name: c.tenant_id != null ? ((tenantById[c.tenant_id] || {}).name || '') : '',
          property_id: u.property_id != null ? u.property_id : null,
          property_name: u.property_id != null ? ((propById[u.property_id] || {}).name || '') : '',
          unit_name: u.name || '',
          amount: calc.round2(Number(p.amount) || 0),
          period_from: pf, period_to: pt,
          period_label: pf && pt ? `${pf} – ${pt}` : '—',
          method: p.method || '',
          purpose: calc.paymentPurpose(p),
          remaining_on_contract: c.id != null
            ? calc.contractSummary(c, paysByContract[c.id] || []).remaining_on_contract
            : null,
        };
      })
      .filter((r) => wantedProp == null || Number(r.property_id) === wantedProp)
      .sort((a, b) => a.date.localeCompare(b.date) || (Number(a.receipt_no) || 0) - (Number(b.receipt_no) || 0));
  } else {
    rows = expenses
      .filter((e) => inRange(e.expense_date))
      .map((e) => {
        const u = e.unit_id != null ? (unitById[e.unit_id] || {}) : {};
        return {
          date: calc.fmtDate(e.expense_date),
          voucher_no: e.voucher_no,
          payee: e.payee || '',
          property_id: e.property_id != null ? e.property_id : null,
          property_name: e.property_id != null ? ((propById[e.property_id] || {}).name || '') : '',
          unit_name: u.name || '',
          category: e.category || '',
          amount: calc.round2(Number(e.amount) || 0),
          payment_method: e.payment_method || '',
        };
      })
      .filter((r) => wantedProp == null || Number(r.property_id) === wantedProp)
      .sort((a, b) => a.date.localeCompare(b.date) || (Number(a.voucher_no) || 0) - (Number(b.voucher_no) || 0));
  }
  const totalAmount = calc.round2(rows.reduce((s, r) => s + r.amount, 0));
  // تفصيل إجماليات تقرير القبض حسب المقابل (كل الأغراض داخلة في التقرير)
  let byPurpose = null;
  if (type === 'receipts') {
    const per = new Map();
    for (const r of rows) {
      const b = per.get(r.purpose) || { count: 0, total: 0 };
      b.count += 1;
      b.total += r.amount;
      per.set(r.purpose, b);
    }
    byPurpose = calc.PAYMENT_PURPOSES
      .filter((k) => per.has(k))
      .map((k) => ({ purpose: k, count: per.get(k).count, total: calc.round2(per.get(k).total) }));
  }
  return {
    type, from, to,
    property_id: wantedProp,
    property_name: wantedProp != null ? ((propById[wantedProp] || {}).name || '') : '',
    rows, count: rows.length, total_amount: totalAmount,
    by_purpose: byPurpose,
    settings: await db.getSettings(),
  };
}

function parseVouchersQuery(req) {
  const type = String(req.query.type || 'receipts');
  if (!['receipts', 'expenses'].includes(type)) return { error: 'نوع تقرير غير صالح' };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const from = req.query.from ? String(req.query.from) : '0001-01-01';
  const to = req.query.to ? String(req.query.to) : '9999-12-31';
  if (!iso.test(from) || !iso.test(to)) return { error: 'صيغة التاريخ غير صحيحة — استخدم YYYY-MM-DD' };
  return { type, from, to, propertyId: req.query.property_id || null };
}

app.get('/api/reports/vouchers', auth, async (req, res) => {
  try {
    const q = parseVouchersQuery(req);
    if (q.error) return res.status(400).json({ error: q.error });
    res.json(await vouchersReportData(q.type, q.from, q.to, q.propertyId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// تقرير السندات كملف إكسل منسّق (xlsx حقيقي عبر exceljs) بنفس أعمدة العرض وإجمالياته
app.get('/api/reports/vouchers.xlsx', auth, async (req, res) => {
  try {
    const q = parseVouchersQuery(req);
    if (q.error) return res.status(400).json({ error: q.error });
    const data = await vouchersReportData(q.type, q.from, q.to, q.propertyId);
    const s = data.settings || {};
    const isReceipts = q.type === 'receipts';
    const title = isReceipts ? 'تقرير سندات القبض' : 'تقرير سندات الصرف';
    const headers = isReceipts
      ? ['التاريخ', 'رقم السند', 'اسم المستأجر', 'العقار', 'الوحدة', 'المبلغ', 'فترة السداد', 'طريقة الدفع', 'المقابل', 'المتبقي على العقد (حالياً)']
      : ['التاريخ', 'رقم سند الصرف', 'المستفيد', 'العقار', 'الوحدة', 'التصنيف', 'المبلغ', 'طريقة الدفع'];
    const widths = isReceipts ? [13, 11, 22, 20, 14, 14, 24, 20, 12, 17] : [13, 13, 22, 20, 14, 16, 14, 20];
    const amountCol = isReceipts ? 6 : 7;
    const ncols = headers.length;

    const wb = new ExcelJS.Workbook();
    wb.creator = s.company_name || 'نظام إدارة الأملاك العقارية';
    const ws = wb.addWorksheet(title, { views: [{ rightToLeft: true, showGridLines: false }] });
    ws.columns = widths.map((width) => ({ width }));
    const MONEY_FMT = '#,##0.00';
    const thin = { style: 'thin', color: { argb: 'FFB0B0B0' } };
    const borders = { top: thin, left: thin, bottom: thin, right: thin };
    const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE9EC' } };

    let row = 1;
    if (s.company_logo && String(s.company_logo).startsWith('data:image/')) {
      const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(String(s.company_logo));
      if (m) {
        try {
          const imgId = wb.addImage({ base64: m[3], extension: m[2] === 'jpeg' ? 'jpeg' : m[2] });
          ws.addImage(imgId, { tl: { col: Math.max(0, (ncols - 1) / 2 - 0.3), row: 0 }, ext: { width: 110, height: 64 } });
          ws.getRow(1).height = 52;
          row = 2;
        } catch (_) { /* شعار تالف لا يمنع إنشاء الملف */ }
      }
    }
    const mergedCenter = (text, font) => {
      ws.mergeCells(row, 1, row, ncols);
      const cell = ws.getCell(row, 1);
      cell.value = text;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      if (font) cell.font = font;
      row++;
    };
    if (s.company_name) mergedCenter(s.company_name, { bold: true, size: 15, color: { argb: 'FF0B5563' } });
    if (s.company_address) mergedCenter(s.company_address, { size: 11, color: { argb: 'FF666666' } });
    if (s.company_phones) mergedCenter(`هاتف: ${s.company_phones}`, { size: 11, color: { argb: 'FF666666' } });
    if (s.company_extra) mergedCenter(s.company_extra, { size: 11, color: { argb: 'FF666666' } });
    mergedCenter(title, { bold: true, size: 16 });
    mergedCenter(`الفترة: من ${q.from} إلى ${q.to} · العقار: ${data.property_id != null ? data.property_name : 'كل العقارات'}`, { size: 11, color: { argb: 'FF666666' } });
    row++; // سطر فارغ

    headers.forEach((h, i) => {
      const cell = ws.getCell(row, i + 1);
      cell.value = h;
      cell.font = { bold: true };
      cell.fill = headFill;
      cell.border = borders;
      cell.alignment = { horizontal: 'center' };
    });
    row++;
    for (const r of data.rows) {
      const vals = isReceipts
        ? [r.date, String(r.receipt_no).padStart(4, '0'), r.tenant_name, r.property_name, r.unit_name, r.amount, r.period_label, r.method, r.purpose, r.remaining_on_contract]
        : [r.date, String(r.voucher_no).padStart(4, '0'), r.payee, r.property_name, r.unit_name, r.category, r.amount, r.payment_method];
      vals.forEach((v, i) => {
        const cell = ws.getCell(row, i + 1);
        if (v !== null && v !== undefined && v !== '') cell.value = v;
        cell.border = borders;
        if (i + 1 === amountCol || (isReceipts && i + 1 === 10)) {
          cell.numFmt = MONEY_FMT;
          cell.alignment = { horizontal: 'left' };
        }
      });
      row++;
    }
    // صف الإجماليات: العدد + إجمالي المبلغ
    ws.mergeCells(row, 1, row, amountCol - 1);
    const lc = ws.getCell(row, 1);
    lc.value = `الإجمالي — عدد ${isReceipts ? 'السندات' : 'سندات الصرف'}: ${data.count}`;
    lc.font = { bold: true };
    lc.border = borders;
    for (let i = 2; i < amountCol; i++) ws.getCell(row, i).border = borders;
    const tc = ws.getCell(row, amountCol);
    tc.value = data.total_amount;
    tc.font = { bold: true };
    tc.numFmt = MONEY_FMT;
    tc.border = borders;
    for (let i = amountCol + 1; i <= ncols; i++) ws.getCell(row, i).border = borders;
    // صفوف تفصيل الإجمالي حسب المقابل (تقارير القبض فقط)
    if (isReceipts && data.by_purpose && data.by_purpose.length) {
      for (const bp of data.by_purpose) {
        row++;
        ws.mergeCells(row, 1, row, amountCol - 1);
        const lc2 = ws.getCell(row, 1);
        lc2.value = `إجمالي مقابل ${bp.purpose} — عدد السندات: ${bp.count}`;
        lc2.border = borders;
        for (let i = 2; i < amountCol; i++) ws.getCell(row, i).border = borders;
        const tc2 = ws.getCell(row, amountCol);
        tc2.value = bp.total;
        tc2.numFmt = MONEY_FMT;
        tc2.border = borders;
        for (let i = amountCol + 1; i <= ncols; i++) ws.getCell(row, i).border = borders;
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="report-${q.type}-${q.from}-${q.to}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- البحث الشامل ----------
// بحث واحد يغطي: رقم سند القبض/الصرف، هوية المستأجر، جواله، اسمه، اسم الوحدة، رقم العقد
app.get('/api/search', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const empty = { tenants: [], contracts: [], payments: [], expenses: [], units: [] };
    if (!q) return res.json(empty);
    const [tenants, contracts, units, payments, expenses, properties] = await Promise.all([
      db.list('tenants'), db.list('contracts'), db.list('units'),
      db.list('payments'), db.list('expenses'), db.list('properties'),
    ]);
    const ql = q.toLowerCase();
    const has = (v) => String(v ?? '').toLowerCase().includes(ql);
    const isNum = /^\d+$/.test(q);
    const num = isNum ? parseInt(q, 10) : null;
    const unitById = Object.fromEntries(units.map((u) => [u.id, u]));
    const tenantById = Object.fromEntries(tenants.map((t) => [t.id, t]));
    const propById = Object.fromEntries(properties.map((p) => [p.id, p]));
    const propNameOfUnit = (u) => (u ? (propById[u.property_id] || {}).name || '' : '');

    const tenantHits = tenants.filter((t) => has(t.name) || has(t.phone) || has(t.id_number) || has(t.contract_no));
    const tenantIds = new Set(tenantHits.map((t) => t.id));
    const unitHits = units.filter((u) => has(u.name) || has(propNameOfUnit(u)));
    const unitIds = new Set(unitHits.map((u) => u.id));

    const contractHits = contracts.filter((c) =>
      (isNum && c.id === num) || tenantIds.has(c.tenant_id) || unitIds.has(c.unit_id));
    const relatedContractIds = new Set(
      contracts.filter((c) => tenantIds.has(c.tenant_id) || unitIds.has(c.unit_id)).map((c) => c.id));

    const paymentHits = payments.filter((p) =>
      (isNum && Number(p.receipt_no) === num) || relatedContractIds.has(p.contract_id));
    const expenseHits = expenses.filter((e) =>
      (isNum && Number(e.voucher_no) === num) || unitIds.has(Number(e.unit_id)) ||
      has(e.category) || has(e.description) || has(e.payee));

    const LIM = 25;
    res.json({
      tenants: tenantHits.slice(0, LIM).map((t) => ({
        id: t.id, name: t.name, phone: t.phone || '', id_number: t.id_number || '', contract_no: t.contract_no || '',
      })),
      contracts: contractHits.slice(0, LIM).map((c) => {
        const u = unitById[c.unit_id] || {};
        return {
          id: c.id, tenant_id: c.tenant_id, unit_id: c.unit_id,
          tenant_name: (tenantById[c.tenant_id] || {}).name || '',
          unit_name: u.name || '', property_name: propNameOfUnit(u),
          start_date: calc.fmtDate(c.start_date), end_date: calc.fmtDate(c.end_date) || null,
          rent_amount: Number(c.rent_amount) || 0, cycle: c.cycle, status: c.status,
        };
      }),
      payments: [...paymentHits].sort((a, b) => (b.receipt_no || 0) - (a.receipt_no || 0)).slice(0, LIM).map((p) => {
        const c = contracts.find((x) => x.id === p.contract_id) || {};
        const u = unitById[c.unit_id] || {};
        return {
          id: p.id, receipt_no: p.receipt_no, amount: Number(p.amount) || 0,
          payment_date: calc.fmtDate(p.payment_date), method: p.method || '', contract_id: p.contract_id,
          tenant_name: (tenantById[c.tenant_id] || {}).name || '', unit_name: u.name || '',
        };
      }),
      expenses: [...expenseHits].sort((a, b) => (b.voucher_no || 0) - (a.voucher_no || 0)).slice(0, LIM).map((e) => ({
        id: e.id, voucher_no: e.voucher_no, amount: Number(e.amount) || 0,
        expense_date: calc.fmtDate(e.expense_date), category: e.category || '', description: e.description || '',
        property_name: (propById[e.property_id] || {}).name || '',
        unit_name: e.unit_id ? (unitById[e.unit_id] || {}).name || '' : '',
      })),
      units: unitHits.slice(0, LIM).map((u) => ({
        id: u.id, name: u.name, property_id: u.property_id,
        property_name: propNameOfUnit(u), status: u.status || '', type: u.type || '',
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- سجل الحركات (عرض فقط — لا حذف من الواجهة) ----------
app.get('/api/audit', auth, async (req, res) => {
  try {
    const entity = String(req.query.entity || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    res.json(await db.listAudit({ entity, limit }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- لوحة المتابعة ----------
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const contracts = await enrichedContracts();
    const payments = await db.list('payments');
    const now = calc.today(); // يوم الرياض — لا يوم الخادم
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    // العربون مستثنى من المحصّلات (تحديث 60): خانته مستقلة بمبالغ حجز معلّقة
    const collectedThisMonth = payments
      .filter((p) => !calc.isDepositPayment(p) && calc.fmtDate(p.payment_date).startsWith(ym))
      .reduce((s, p) => s + Number(p.amount || 0), 0);
    // المحصّل هذا العام (تحديث 55 — بطلب عبده): كل سندات قبض السنة الحالية
    // (إيجار + خدمات) حسب تاريخ الدفع وبتوقيت البرنامج، بنفس منطق الشهر
    const yearPrefix = String(now.getFullYear());
    const collectedThisYear = payments
      .filter((p) => !calc.isDepositPayment(p) && calc.fmtDate(p.payment_date).startsWith(yearPrefix))
      .reduce((s, p) => s + Number(p.amount || 0), 0);
    const [rawContracts] = await Promise.all([db.list('contracts')]);
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
    // أقساط قادمة خلال 10 أيام: القسط التالي غير المسدد لكل عقد سارٍ، إن وقع
    // تاريخ استحقاقه بين اليوم وبعد 10 أيام (الدفعات تغطي الأقساط بالترتيب)
    const paysByContract = {};
    for (const p of payments) (paysByContract[p.contract_id] = paysByContract[p.contract_id] || []).push(p);
    const enrichedById = Object.fromEntries(contracts.map((c) => [c.id, c]));
    const todayIso = calc.fmtDate(calc.today());
    const in10Iso = calc.fmtDate(calc.addDays(calc.today(), 10));
    const upcomingInstallments = [];
    for (const c of rawContracts) {
      if (c.status !== 'active') continue;
      const next = calc.nextUnpaidInstallment(c, paysByContract[c.id] || []);
      if (!next || next.due_date < todayIso || next.due_date > in10Iso) continue;
      const ec = enrichedById[c.id] || {};
      upcomingInstallments.push({
        contract_id: c.id, tenant_id: c.tenant_id,
        tenant_name: ec.tenant_name || '', unit_name: ec.unit_name || '', property_name: ec.property_name || '',
        installment_index: next.index, installments_total: calc.installmentsCount(c),
        due_date: next.due_date, amount: next.amount, remaining: next.remaining,
      });
    }
    upcomingInstallments.sort((a, b) => a.due_date.localeCompare(b.due_date));
    // عدّادات عامة + عدد الملاك المختلفين: أسماء مالك العقارات بعد التطبيع
    // (قصّ الطرفين + دمج المسافات الداخلية + تجاهل حالة الأحرف اللاتينية)،
    // ولا تُحتسب الأسماء الفارغة.
    const propertiesList = await db.list('properties');
    const unitsCount = (await db.list('units')).length;
    const tenantsCount = (await db.list('tenants')).length;
    const ownersCount = new Set(
      propertiesList
        .map((p) => calc.normalizeOwnerName(p.owner_name))
        .filter(Boolean),
    ).size;
    // إجمالي الباقي من كل العقود السارية (المتبقي من كامل العقود)
    const totalRemaining = contracts
      .filter((c) => c.status === 'active')
      .reduce((s, c) => s + (Number(c.remaining_on_contract) || 0), 0);
    // تفصيل «مستحق عند مين ومتأخر عند مين» لكل عقد سارٍ: مستحق هذا الشهر
    // المتبقي (أقساط بدأت هذا الشهر − مدفوعات إيجار هذا الشهر) + المتأخرات
    const duesList = [];
    for (const c of contracts) {
      if (c.status !== 'active') continue;
      const dueMonth = calc.dueInMonth(c, now.getFullYear(), now.getMonth());
      const paidMonth = (paysByContract[c.id] || [])
        .filter((p) => calc.isRentPayment(p) && calc.fmtDate(p.payment_date).startsWith(ym))
        .reduce((s, p) => s + Number(p.amount || 0), 0);
      const dueRemaining = Math.max(0, calc.round2(dueMonth - paidMonth));
      // الإجمالي المستحق عليه فعلياً الآن: أقساط بدأت حتى اليوم − المدفوع،
      // ويشمل باقي قسط بدأ ولم يحن تأخيره بعد (لا يظهر في حساب الشهر وحده)
      const owedNow = calc.round2(Math.max(0, (Number(c.total_due) || 0) - (Number(c.total_paid) || 0)));
      // القائمة تشمل كل العقود السارية (عبده: «ادوس عالمستحق يطلع اسماء
      // المستأجرين») — مع أول قسط غير مسدد بالكامل وموعد استحقاقه لكل عقد
      const next = calc.nextUnpaidInstallment(c, paysByContract[c.id] || []);
      duesList.push({
        contract_id: c.id, tenant_id: c.tenant_id, tenant_name: c.tenant_name,
        unit_name: c.unit_name, property_name: c.property_name,
        due_this_month: dueMonth, due_remaining: dueRemaining, arrears: c.arrears || 0,
        owed_now: owedNow,
        next_due_date: next ? next.due_date : null,
        next_remaining: next ? next.remaining : 0,
      });
    }
    duesList.sort((a, b) => (b.owed_now - a.owed_now) || (b.arrears - a.arrears)
      || String(a.next_due_date || '9999').localeCompare(String(b.next_due_date || '9999')));
    // «المستحق هذا الشهر» (تحديث 40 — بطلب عبده): ما تبقّى تحصيله فعلياً =
    // المستحق الآن على أقساط بدأت + باقي أي قسط يبدأ خلال ١٠ أيام قادمة.
    // (قبل ذلك كان مجموع مبالغ أقساط الشهر كاملة ولو سُدّدت: أظهر ٧٬٣٧٥
    // بينما الباقي الفعلي ٨٬٧٥٠ + ٣٠٠ = ٩٬٠٥٠)
    const dueThisMonth = calc.round2(duesList.reduce((s, r) => s + (Number(r.owed_now) || 0)
      + (r.next_due_date && r.next_due_date > todayIso && r.next_due_date <= in10Iso
        ? (Number(r.next_remaining) || 0) : 0), 0));
    // تفصيل محصّل هذا الشهر حسب أقسام طريقة الدفع (نقدي/بنك/شيك/منصة بفرعيها/أخرى)
    const perMethodDash = new Map();
    for (const p of payments) {
      if (calc.isDepositPayment(p)) continue;
      if (!calc.fmtDate(p.payment_date).startsWith(ym)) continue;
      const key = p.method || 'تحويل';
      const b = perMethodDash.get(key) || { total: 0, count: 0 };
      b.total += Number(p.amount || 0);
      b.count += 1;
      perMethodDash.set(key, b);
    }
    const collectedByMethod = groupMethodRows(
      [...perMethodDash.entries()].map(([method, b]) => ({ method, total: calc.round2(b.total), count: b.count })),
    );
    // تفصيل «محصّل هذا العام» حسب أقسام طريقة الدفع — نفس أقسام الشهر
    const perMethodYear = new Map();
    for (const p of payments) {
      if (calc.isDepositPayment(p)) continue;
      if (!calc.fmtDate(p.payment_date).startsWith(yearPrefix)) continue;
      const key = p.method || 'تحويل';
      const b = perMethodYear.get(key) || { total: 0, count: 0 };
      b.total += Number(p.amount || 0);
      b.count += 1;
      perMethodYear.set(key, b);
    }
    const collectedYearByMethod = groupMethodRows(
      [...perMethodYear.entries()].map(([method, b]) => ({ method, total: calc.round2(b.total), count: b.count })),
    );
    res.json({
      collected_this_month: collectedThisMonth,
      collected_by_method: collectedByMethod,
      collected_this_year: calc.round2(collectedThisYear),
      collected_year_by_method: collectedYearByMethod,
      due_this_month: dueThisMonth,
      total_remaining: calc.round2(totalRemaining),
      dues_list: duesList,
      total_arrears: arrearsList.reduce((s, r) => s + r.arrears, 0),
      arrears_list: arrearsList,
      expiring_soon: expiring,
      upcoming_installments: upcomingInstallments,
      recent_payments: recentPayments,
      tenants_count: tenantsCount,
      owners_count: ownersCount,
      office_balance: calc.round2(
        payments.filter((p) => calc.isOfficePayment(p)).reduce((s, p) => s + Number(p.amount || 0), 0)
        - (await db.list('expenses')).filter((e) => e.property_id == null).reduce((s, e) => s + Number(e.amount || 0), 0)),
      properties_count: propertiesList.length,
      units_count: unitsCount,
      counts: {
        properties: propertiesList.length,
        units: unitsCount,
        tenants: tenantsCount,
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

app.get('/api/export/:table.csv', auth, adminOnly, async (req, res) => {
  try {
    const table = req.params.table;
    if (!db.TABLES[table] && table !== 'contracts-full' && table !== 'attachments') return res.status(404).json({ error: 'جدول غير معروف' });
    const rows = table === 'contracts-full' ? await enrichedContracts()
      : table === 'attachments' ? await db.listAttachmentsMeta()
      : await db.list(table);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
    res.send(toCsv(rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup', auth, adminOnly, async (req, res) => {
  try {
    res.setHeader('Content-Disposition', 'attachment; filename="property-backup.json"');
    res.json(await buildBackupPayload());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/import', auth, adminOnly, async (req, res) => {
  try {
    const data = (req.body && req.body.data) || req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'ملف غير صالح' });
    await takeSnapshot('pre-import', { pinned: true }); // أمان مثبّتة من الحالة الحالية قبل تطبيق الاستيراد
    await db.importAll(data);
    try { applyCountry(await db.getSettings()); } catch { /* تبقى الإعدادات الحالية */ }
    await takeSnapshot('auto'); // الاستيراد تغيير شامل — وثّقه بلقطة للحالة الجديدة
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- النسخ الاحتياطية التلقائية (للمدير فقط: قائمة وتنزيل وأخذ واستعادة) ----------
app.get('/api/backups', auth, adminOnly, async (req, res) => {
  try {
    res.json({ drive_configured: drive.configured(), backups: await db.listBackupsMeta() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backups/:id/download', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.getBackup(req.params.id);
    if (!snap) return res.status(404).json({ error: 'النسخة غير موجودة' });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="backup-${snap.id}.json"`);
    res.send(JSON.stringify(snap.data, null, 1));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backups', auth, adminOnly, async (req, res) => {
  try {
    const row = await takeSnapshot('manual');
    if (!row) return res.status(500).json({ error: 'تعذّر أخذ النسخة' });
    await audit(req, 'backups', row.id, 'create', row);
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// الاستعادة: لقطة أمان «قبل الاستعادة» مثبّتة من الحالة الحالية أولاً (تبقى
// مدرجة وقابلة للاستعادة حتى اللقطة التالية)، ثم تطبيق اللقطة المختارة عبر
// مسار الاستيراد نفسه، ثم لقطة تلقائية للحالة المستعادة
app.post('/api/backups/:id/restore', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.getBackup(req.params.id);
    if (!snap) return res.status(404).json({ error: 'النسخة غير موجودة' });
    await takeSnapshot('pre-restore', { pinned: true });
    const data = (snap.data && snap.data.data) || snap.data;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'محتوى النسخة غير صالح' });
    await db.importAll(data);
    try { applyCountry(await db.getSettings()); } catch { /* تبقى الإعدادات الحالية */ }
    await audit(req, 'backups', snap.id, 'restore', snap);
    await takeSnapshot('auto');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- لوحة الإعلانات العامة (تحديث ٣٩) ----------
// صفحة عامة لعرض الشقق (بيع/إيجار) يتصفحها أي زائر دون دخول، والمالك يرسل
// إعلانه من نموذج عام فيدخل «بانتظار المراجعة» ولا يظهر إلا باعتماد المدير.
// اللوحة مغلقة افتراضياً ولا تعمل إلا بتفعيل «listings_enabled» من الإعدادات.
const escH = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const boardOn = (s) => !!s && (s.listings_enabled === '1' || s.listings_enabled === 'true');
const boardCur = (s) => (s && s.country === 'eg' ? 'ج.م' : 'ر.س');
const fmtPrice = (n, cur) => `${Number(n || 0).toLocaleString('en-US')} ${cur}`;
function pubBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.headers.host}`;
}
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (/^01\d{9}$/.test(d)) d = '20' + d.slice(1); // رقم مصري محلي → دولي
  return d;
}
const LISTING_STATUS_AR = { pending: 'بانتظار المراجعة', approved: 'معتمد', rejected: 'مرفوض', hidden: 'مخفي' };

async function boardGate(req, res) {
  const s = await db.getSettings();
  if (!boardOn(s)) {
    res.status(404).send('<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>غير متاحة</title></head><body style="font-family:Tahoma;text-align:center;padding:60px 20px;color:#44585c"><h2>هذه الصفحة غير متاحة حالياً</h2><p>لوحة الإعلانات غير مفعّلة.</p></body></html>');
    return null;
  }
  return s;
}

function boardCss() {
  return `
  *{box-sizing:border-box} body{margin:0;font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#f2f6f6;color:#1c2b2e}
  a{text-decoration:none;color:inherit}
  .b-head{background:linear-gradient(135deg,#083f49,#0b5563 60%,#0e6b7a);color:#fff;padding:26px 16px 20px;text-align:center}
  .b-head h1{margin:0 0 6px;font-size:26px}
  .b-head p{margin:0;color:#ffd97a;font-weight:700}
  .b-wrap{max-width:1080px;margin:0 auto;padding:16px}
  .b-cta{display:inline-block;background:#ffd97a;color:#083f49;font-weight:800;padding:10px 22px;border-radius:999px;margin-top:14px}
  .b-filters{background:#fff;border-radius:12px;padding:12px;display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  .b-filters input,.b-filters select{padding:9px 10px;border:1px solid #cfdddf;border-radius:8px;font-size:14px;flex:1;min-width:120px}
  .b-filters button{background:#0b5563;color:#fff;border:0;border-radius:8px;padding:9px 20px;font-weight:700;cursor:pointer}
  .b-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
  .b-card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 5px rgba(0,0,0,.07);display:block;position:relative}
  .b-card img{width:100%;height:170px;object-fit:cover;background:#dce8ea;display:block}
  .b-noimg{height:170px;background:#dce8ea;display:flex;align-items:center;justify-content:center;font-size:44px}
  .b-body{padding:12px 14px}
  .b-title{font-weight:800;font-size:16px;margin:0 0 5px;line-height:1.5}
  .b-price{color:#0b5563;font-weight:800;font-size:18px}
  .b-meta{color:#5a6f73;font-size:13px;margin-top:4px;line-height:1.7}
  .b-kind{position:absolute;top:10px;right:10px;background:#0b5563;color:#fff;font-size:12px;font-weight:800;padding:3px 12px;border-radius:999px}
  .b-kind.sale{background:#c9a227;color:#083f49}
  .b-feat{position:absolute;top:10px;left:10px;background:#ffd97a;color:#083f49;font-size:12px;font-weight:800;padding:3px 12px;border-radius:999px}
  .b-empty{background:#fff;border-radius:12px;padding:36px;text-align:center;color:#5a6f73}
  .b-foot{text-align:center;color:#5a6f73;font-size:13px;padding:22px 10px 30px;line-height:1.9}
  .d-gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:14px}
  .d-gal img{width:100%;height:210px;object-fit:cover;border-radius:12px}
  .d-box{background:#fff;border-radius:14px;padding:18px;box-shadow:0 1px 5px rgba(0,0,0,.06)}
  .d-specs{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:14px 0}
  .d-spec{background:#f2f6f6;border-radius:10px;padding:9px 12px;font-size:14px}
  .d-spec b{display:block;color:#0b5563;font-size:12px;margin-bottom:2px}
  .d-desc{white-space:pre-wrap;line-height:1.9;font-size:15px}
  .d-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
  .d-wa{background:#1faa55;color:#fff;font-weight:800;padding:12px 26px;border-radius:999px;display:inline-block}
  .d-share{background:#eef3f3;color:#083f49;font-weight:700;padding:12px 20px;border-radius:999px;border:1px solid #cfdddf;cursor:pointer}
  form.f-box{background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 5px rgba(0,0,0,.06)}
  form.f-box label{display:block;font-weight:700;font-size:14px;margin:0 0 12px}
  form.f-box input,form.f-box select,form.f-box textarea{width:100%;padding:10px;border:1px solid #cfdddf;border-radius:8px;margin-top:5px;font-size:15px;font-family:inherit}
  form.f-box .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  form.f-box button{background:#0b5563;color:#fff;border:0;border-radius:10px;padding:13px 30px;font-weight:800;font-size:16px;cursor:pointer;width:100%}
  .f-ok{background:#e7f6ee;border:1px solid #1faa55;color:#0d6e3f;border-radius:12px;padding:22px;text-align:center;font-size:17px;line-height:1.9}
  .f-err{color:#c0392b;font-weight:700;min-height:20px}
  @media(max-width:560px){form.f-box .row{grid-template-columns:1fr}}`;
}

function boardHead(title, desc, extra = '') {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escH(title)}</title><meta name="description" content="${escH(desc)}">
  <style>${boardCss()}</style>${extra}</head><body>`;
}

async function listingPhotos(id) {
  try { return await db.listAttachments('listing', Number(id)); } catch (_) { return []; }
}

// نشر تلقائي على قناة تيليجرام (اختياري): يعمل فقط عند ضبط متغيري البيئة
// TELEGRAM_BOT_TOKEN و TELEGRAM_CHANNEL_ID على الخادم، وأي فشل يُبتلع بصمت.
async function telegramPostListing(req, listing) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHANNEL_ID;
    if (!token || !chat) return;
    const s = await db.getSettings();
    const cur = boardCur(s);
    const link = `${pubBase(req)}/board/${listing.id}`;
    const caption = `🏠 ${listing.title}\n💰 ${fmtPrice(listing.price, cur)} — ${escH(listing.kind)}\n📍 ${listing.area_name || ''}${listing.size_m2 ? `\n📐 ${listing.size_m2} م²` : ''}\n\nالتفاصيل والتواصل:\n${link}`;
    const photos = await listingPhotos(listing.id);
    if (photos.length) {
      const att = await db.getAttachment(photos[0].id);
      if (att && att.data_base64) {
        const fd = new FormData();
        fd.append('chat_id', chat);
        fd.append('caption', caption);
        fd.append('photo', new Blob([Buffer.from(att.data_base64, 'base64')], { type: att.mime || 'image/jpeg' }), 'photo.jpg');
        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: fd });
        return;
      }
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: caption }),
    });
  } catch (_) { /* النشر الخارجي لا يعطّل الاعتماد أبداً */ }
}

app.get('/robots.txt', async (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /board\nDisallow: /api/\nSitemap: ${pubBase(req)}/sitemap.xml\n`);
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    const s = await db.getSettings();
    const base = pubBase(req);
    let urls = '';
    if (boardOn(s)) {
      const rows = (await db.list('listings')).filter((l) => l.status === 'approved');
      urls = rows.map((l) => `<url><loc>${base}/board/${l.id}</loc></url>`).join('');
    }
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/board</loc></url>${urls}</urlset>`);
  } catch (e) { res.status(500).type('text/plain').send('error'); }
});

app.get('/board', async (req, res) => {
  try {
    const s = await boardGate(req, res);
    if (!s) return;
    const cur = boardCur(s);
    const company = s.company_name || 'لوحة الإعلانات العقارية';
    const { kind, q, min, max, sort } = req.query;
    let rows = (await db.list('listings')).filter((l) => l.status === 'approved');
    if (kind === 'بيع' || kind === 'إيجار') rows = rows.filter((l) => l.kind === kind);
    if (q) { const needle = String(q).trim(); rows = rows.filter((l) => `${l.title} ${l.area_name} ${l.description || ''}`.includes(needle)); }
    if (min !== undefined && min !== '' && Number.isFinite(Number(min))) rows = rows.filter((l) => Number(l.price) >= Number(min));
    if (max !== undefined && max !== '' && Number.isFinite(Number(max))) rows = rows.filter((l) => Number(l.price) <= Number(max));
    if (sort === 'price_asc') rows.sort((a, b) => Number(a.price) - Number(b.price));
    else if (sort === 'price_desc') rows.sort((a, b) => Number(b.price) - Number(a.price));
    else rows.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || b.id - a.id);
    const cards = [];
    for (const l of rows.slice(0, 200)) {
      const ph = await listingPhotos(l.id);
      cards.push(`<a class="b-card" href="/board/${l.id}">
        ${ph.length ? `<img src="/board/photo/${ph[0].id}" alt="${escH(l.title)}" loading="lazy">` : '<div class="b-noimg">🏠</div>'}
        <span class="b-kind ${l.kind === 'بيع' ? 'sale' : ''}">${escH(l.kind)}</span>
        ${l.featured ? '<span class="b-feat">⭐ مميز</span>' : ''}
        <div class="b-body"><p class="b-title">${escH(l.title)}</p>
        <div class="b-price">${fmtPrice(l.price, cur)}</div>
        <div class="b-meta">📍 ${escH(l.area_name || '')}${l.size_m2 ? ` • 📐 ${escH(l.size_m2)} م²` : ''}${l.rooms ? ` • 🛏️ ${escH(l.rooms)} غرف` : ''}</div></div></a>`);
    }
    res.send(`${boardHead(`${company} — شقق للبيع والإيجار`, `شقق معروضة للبيع والإيجار — ${company}`)}
    <div class="b-head"><h1>${escH(company)}</h1><p>شقق معروضة للبيع والإيجار</p>
    <a class="b-cta" href="/board/new">+ اعرض شقتك مجاناً</a></div>
    <div class="b-wrap">
      <form class="b-filters" method="get" action="/board">
        <input name="q" placeholder="ابحث بمنطقة أو كلمة…" value="${escH(q || '')}">
        <select name="kind"><option value="">بيع وإيجار</option><option value="بيع" ${kind === 'بيع' ? 'selected' : ''}>للبيع</option><option value="إيجار" ${kind === 'إيجار' ? 'selected' : ''}>للإيجار</option></select>
        <input name="min" type="number" min="0" placeholder="السعر من" value="${escH(min || '')}">
        <input name="max" type="number" min="0" placeholder="السعر إلى" value="${escH(max || '')}">
        <select name="sort"><option value="">الأحدث أولاً</option><option value="price_asc" ${sort === 'price_asc' ? 'selected' : ''}>السعر: الأقل</option><option value="price_desc" ${sort === 'price_desc' ? 'selected' : ''}>السعر: الأعلى</option></select>
        <button type="submit">بحث</button>
      </form>
      ${cards.length ? `<div class="b-grid">${cards.join('')}</div>` : '<div class="b-empty">لا توجد إعلانات مطابقة حالياً — جرّب تعديل البحث، أو اعرض شقتك أنت أول واحد 😊</div>'}
      <div class="b-foot">كل الإعلانات تمر بمراجعة الإدارة قبل النشر • ${escH(company)}</div>
    </div></body></html>`);
  } catch (e) { res.status(500).send('حدث خطأ — حاول مرة أخرى'); }
});

app.get('/board/new', async (req, res) => {
  try {
    const s = await boardGate(req, res);
    if (!s) return;
    const cur = boardCur(s);
    const company = s.company_name || 'لوحة الإعلانات العقارية';
    res.send(`${boardHead(`اعرض شقتك — ${company}`, 'انشر إعلان شقتك للبيع أو الإيجار مجاناً')}
    <div class="b-head"><h1>اعرض شقتك مجاناً</h1><p>بيع أو إيجار — إعلانك يظهر بعد مراجعة الإدارة</p></div>
    <div class="b-wrap"><div id="formZone">
      <form class="f-box" id="lstForm">
        <label>عنوان الإعلان<input name="title" required minlength="5" maxlength="120" placeholder="مثال: شقة ١٢٠ متر في فيصل — شارع العشرين"></label>
        <div class="row">
          <label>النوع<select name="kind"><option value="إيجار">للإيجار</option><option value="بيع">للبيع</option></select></label>
          <label>السعر (${cur})<input name="price" type="number" required min="1" step="any" placeholder="مثال: 8000"></label>
        </div>
        <div class="row">
          <label>المنطقة / الحي<input name="area_name" required maxlength="80" placeholder="مثال: فيصل — الطالبية"></label>
          <label>المساحة (م²)<input name="size_m2" type="number" min="0" step="any"></label>
        </div>
        <div class="row">
          <label>عدد الغرف<input name="rooms" type="number" min="0" max="30"></label>
          <label>عدد الحمامات<input name="baths" type="number" min="0" max="15"></label>
        </div>
        <div class="row">
          <label>الدور<input name="floor" maxlength="30" placeholder="مثال: الثالث"></label>
          <label>اسمك (المالك / المكتب)<input name="owner_name" maxlength="80"></label>
        </div>
        <label>رقم الموبايل (واتساب) — هيظهر للمهتمين<input name="phone" required maxlength="20" placeholder="01xxxxxxxxx"></label>
        <label>وصف الشقة<textarea name="description" rows="4" maxlength="1500" placeholder="التشطيب، الأثاث، القرب من المواصلات…"></textarea></label>
        <label>صور الشقة (حتى ٥ صور)<input type="file" id="lstPhotos" accept="image/*" multiple></label>
        <input type="text" name="website" style="display:none" tabindex="-1" autocomplete="off">
        <p class="f-err" id="lstMsg"></p>
        <button type="submit" id="lstSend">إرسال الإعلان للمراجعة</button>
        <p style="color:#5a6f73;font-size:13px;line-height:1.8">بإرسالك الإعلان أنت مسؤول عن صحة بياناته. الإدارة تراجع كل إعلان قبل نشره.</p>
      </form></div>
      <div class="b-foot"><a href="/board">← الرجوع لكل الإعلانات</a></div>
    </div>
    <script>
      document.getElementById('lstForm').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const msg = document.getElementById('lstMsg');
        const btn = document.getElementById('lstSend');
        const data = Object.fromEntries(new FormData(ev.target).entries());
        msg.textContent = '';
        try {
          btn.disabled = true; btn.textContent = 'جارٍ الإرسال…';
          const files = [...document.getElementById('lstPhotos').files].slice(0, 5);
          data.photos = [];
          for (const f of files) {
            const url = await new Promise((res, rej) => {
              const img = new Image();
              img.onload = () => {
                const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
                const c = document.createElement('canvas');
                c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                res(c.toDataURL('image/jpeg', 0.82));
              };
              img.onerror = rej;
              const r = new FileReader(); r.onload = () => { img.src = r.result; }; r.onerror = rej; r.readAsDataURL(f);
            });
            data.photos.push({ filename: f.name || 'photo.jpg', mime: 'image/jpeg', data_base64: String(url).split(',')[1] });
          }
          const r = await fetch('/board/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || 'تعذر إرسال الإعلان');
          document.getElementById('formZone').innerHTML = '<div class="f-ok">✅ تم استلام إعلانك بنجاح<br>سيظهر في اللوحة بعد مراجعة الإدارة — شكراً لك</div>';
        } catch (e) { msg.textContent = e.message; btn.disabled = false; btn.textContent = 'إرسال الإعلان للمراجعة'; }
      });
    </script></body></html>`);
  } catch (e) { res.status(500).send('حدث خطأ — حاول مرة أخرى'); }
});

app.post('/board/new', async (req, res) => {
  try {
    const s = await db.getSettings();
    if (!boardOn(s)) return res.status(404).json({ error: 'اللوحة غير مفعلة' });
    const b = req.body || {};
    if (b.website) return res.status(400).json({ error: 'طلب غير صالح' }); // مصيدة سبام
    const title = String(b.title || '').trim();
    const kind = b.kind === 'بيع' ? 'بيع' : 'إيجار';
    const price = Number(b.price);
    const area = String(b.area_name || '').trim();
    const phone = String(b.phone || '').trim();
    if (title.length < 5) return res.status(400).json({ error: 'اكتب عنواناً واضحاً للإعلان (٥ أحرف على الأقل)' });
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'اكتب سعراً صحيحاً' });
    if (!area) return res.status(400).json({ error: 'اكتب المنطقة' });
    if (phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'اكتب رقم موبايل صحيحاً للتواصل' });
    const photos = Array.isArray(b.photos) ? b.photos.slice(0, 5) : [];
    const IMG_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    for (const p of photos) {
      if (!IMG_MIMES.includes(p.mime)) return res.status(400).json({ error: 'صور الإعلان يجب أن تكون صوراً فقط' });
      if (!p.data_base64 || Buffer.from(String(p.data_base64), 'base64').length > db.ATTACHMENT_MAX) return res.status(400).json({ error: 'حجم صورة يتجاوز ٣ ميجابايت' });
    }
    const row = await db.insert('listings', {
      title: title.slice(0, 120), kind, price,
      area_name: area.slice(0, 80),
      size_m2: b.size_m2 === '' || b.size_m2 === undefined ? null : Number(b.size_m2),
      rooms: b.rooms === '' || b.rooms === undefined ? null : Math.floor(Number(b.rooms)),
      baths: b.baths === '' || b.baths === undefined ? null : Math.floor(Number(b.baths)),
      floor: String(b.floor || '').slice(0, 30),
      description: String(b.description || '').slice(0, 1500),
      owner_name: String(b.owner_name || '').slice(0, 80),
      phone: phone.slice(0, 20),
      status: 'pending', featured: false, views: 0, wa_clicks: 0,
    });
    for (const p of photos) {
      await db.insertAttachment({
        entity_type: 'listing', entity_id: row.id,
        filename: String(p.filename || 'photo.jpg').slice(0, 120), mime: p.mime,
        size: Buffer.from(String(p.data_base64), 'base64').length, data_base64: String(p.data_base64),
      });
    }
    res.status(201).json({ ok: true, id: row.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/board/photo/:id', async (req, res) => {
  try {
    const s = await db.getSettings();
    if (!boardOn(s)) return res.status(404).end();
    const a = await db.getAttachment(req.params.id);
    if (!a || a.entity_type !== 'listing') return res.status(404).end();
    const listing = await db.get('listings', a.entity_id);
    if (!listing || listing.status !== 'approved') return res.status(404).end();
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(a.data_base64, 'base64'));
  } catch (e) { res.status(500).end(); }
});

app.get('/board/:id/whatsapp', async (req, res) => {
  try {
    const s = await db.getSettings();
    if (!boardOn(s)) return res.status(404).end();
    const l = await db.get('listings', req.params.id);
    if (!l || l.status !== 'approved') return res.status(404).end();
    db.update('listings', l.id, { wa_clicks: (Number(l.wa_clicks) || 0) + 1 }).catch(() => {});
    const text = encodeURIComponent(`مرحباً، أنا مهتم بإعلانكم: ${l.title} — ${pubBase(req)}/board/${l.id}`);
    res.redirect(302, `https://wa.me/${waNumber(l.phone)}?text=${text}`);
  } catch (e) { res.status(500).end(); }
});

app.get('/board/:id', async (req, res) => {
  try {
    const s = await boardGate(req, res);
    if (!s) return;
    const l = await db.get('listings', req.params.id);
    if (!l || l.status !== 'approved') { res.status(404).send('<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>غير موجود</title></head><body style="font-family:Tahoma;text-align:center;padding:60px 20px;color:#44585c"><h2>الإعلان غير موجود أو غير منشور</h2><p><a href="/board">الرجوع للوحة الإعلانات</a></p></body></html>'); return; }
    db.update('listings', l.id, { views: (Number(l.views) || 0) + 1 }).catch(() => {});
    const cur = boardCur(s);
    const company = s.company_name || 'لوحة الإعلانات العقارية';
    const base = pubBase(req);
    const ph = await listingPhotos(l.id);
    const ld = {
      '@context': 'https://schema.org', '@type': 'RealEstateListing', name: l.title,
      description: (l.description || '').slice(0, 300), url: `${base}/board/${l.id}`,
      address: { '@type': 'PostalAddress', addressLocality: l.area_name || '' },
      offers: { '@type': 'Offer', price: Number(l.price) || 0, priceCurrency: s.country === 'eg' ? 'EGP' : 'SAR', availability: 'https://schema.org/InStock' },
    };
    const specs = [
      ['النوع', l.kind], ['السعر', fmtPrice(l.price, cur)], ['المنطقة', l.area_name],
      l.size_m2 ? ['المساحة', `${l.size_m2} م²`] : null,
      l.rooms ? ['الغرف', l.rooms] : null, l.baths ? ['الحمامات', l.baths] : null,
      l.floor ? ['الدور', l.floor] : null,
      l.owner_name ? ['المعلن', l.owner_name] : null,
    ].filter(Boolean);
    const adText = `${l.title}\n${l.kind} — ${fmtPrice(l.price, cur)}\nالمنطقة: ${l.area_name || ''}${l.size_m2 ? ` — ${l.size_m2} م²` : ''}${l.rooms ? ` — ${l.rooms} غرف` : ''}\nالتفاصيل: ${base}/board/${l.id}`;
    res.send(`${boardHead(`${l.title} — ${company}`, (l.description || `${l.kind} في ${l.area_name || ''} بسعر ${fmtPrice(l.price, cur)}`).slice(0, 160),
      `<meta property="og:title" content="${escH(l.title)}"><meta property="og:description" content="${escH((l.description || '').slice(0, 150))}">${ph.length ? `<meta property="og:image" content="${base}/board/photo/${ph[0].id}">` : ''}<script type="application/ld+json">${JSON.stringify(ld)}</script>`)}
    <div class="b-head"><h1 style="font-size:22px">${escH(company)}</h1><p><a href="/board" style="color:#ffd97a">← كل الإعلانات</a></p></div>
    <div class="b-wrap">
      ${ph.length ? `<div class="d-gal">${ph.map((p) => `<img src="/board/photo/${p.id}" alt="${escH(l.title)}">`).join('')}</div>` : ''}
      <div class="d-box">
        <h2 style="margin:0 0 4px;font-size:22px;line-height:1.6">${escH(l.title)} ${l.featured ? '⭐' : ''}</h2>
        <div class="b-price" style="font-size:24px">${fmtPrice(l.price, cur)} <span style="font-size:14px;color:#5a6f73">(${escH(l.kind)})</span></div>
        <div class="d-specs">${specs.map(([k, v]) => `<div class="d-spec"><b>${escH(k)}</b>${escH(v)}</div>`).join('')}</div>
        ${l.description ? `<div class="d-desc">${escH(l.description)}</div>` : ''}
        <div class="d-actions">
          <a class="d-wa" href="/board/${l.id}/whatsapp" target="_blank" rel="noopener">💬 تواصل واتساب مع المعلن</a>
          <a class="d-share" href="https://wa.me/?text=${encodeURIComponent(adText)}" target="_blank" rel="noopener">مشاركة واتساب</a>
          <a class="d-share" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(`${base}/board/${l.id}`)}" target="_blank" rel="noopener">مشاركة فيسبوك</a>
          <button class="d-share" id="copyAdBtn" type="button">📋 انسخ الإعلان</button>
        </div>
        <script>document.getElementById('copyAdBtn').addEventListener('click',function(){var t=${JSON.stringify(adText).replace(/</g, '\\u003c')};if(navigator.clipboard){navigator.clipboard.writeText(t).then(function(){document.getElementById('copyAdBtn').textContent='✅ تم نسخ الإعلان';});}});</script>
        <p style="color:#5a6f73;font-size:12.5px;margin:14px 0 0">إعلان رقم ${l.id} • 👁️ ${Number(l.views) || 0} مشاهدة • الإدارة غير مسؤولة عن صحة بيانات الإعلان — تحقق بنفسك قبل أي تعاقد</p>
      </div>
      <div class="b-foot"><a href="/board/new">+ اعرض شقتك أنت كمان — مجاناً</a></div>
    </div></body></html>`);
  } catch (e) { res.status(500).send('حدث خطأ — حاول مرة أخرى'); }
});

// اعتماد إعلان: يُنشر على اللوحة ويُبثّ على تيليجرام (إن كان مضبوطاً) مرة واحدة
app.post('/api/listings/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const before = await db.get('listings', req.params.id);
    if (!before) return res.status(404).json({ error: 'غير موجود' });
    const row = await db.update('listings', req.params.id, { status: 'approved' });
    await audit(req, 'listings', row.id, 'update', row);
    await takeSnapshot('auto');
    if (before.status !== 'approved') telegramPostListing(req, row);
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/listings/:id/reject', auth, adminOnly, async (req, res) => {
  try {
    const before = await db.get('listings', req.params.id);
    if (!before) return res.status(404).json({ error: 'غير موجود' });
    const row = await db.update('listings', req.params.id, { status: 'rejected' });
    await audit(req, 'listings', row.id, 'update', row);
    await takeSnapshot('auto');
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// أي مسار آخر يعيد واجهة التطبيق
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
db.init()
  .then(async () => {
    try { applyCountry(await db.getSettings()); } catch { /* الإعدادات الافتراضية تكفي */ }
    app.listen(PORT, () => {
      console.log(`Property management app running on port ${PORT} — database: ${db.usePg ? 'PostgreSQL' : 'local JSON (demo)'}`);
    });
  })
  .catch((e) => {
    console.error('Database init failed:', e.message);
    process.exit(1);
  });

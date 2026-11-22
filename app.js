'use strict';
/* نظام إدارة الأملاك العقارية — واجهة التطبيق */

// ---------------- أدوات عامة ----------------
const $ = (sel) => document.querySelector(sel);
const main = () => $('#main');
const token = () => sessionStorage.getItem('pm_token') || '';
const money = (n) => `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ر.س`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
// طرق الدفع/السداد المتاحة في سندات القبض والصرف (تُحفظ كنص وتُطبع كما هي في السند)
const PAY_METHODS = ['نقداً', 'تحويل بنكي', 'شبكة', 'شيك', 'منصة إيجار — لحساب المكتب', 'منصة إيجار — لحساب المالك'];
// أغراض الدفعات (مقابل السند): الإيجار فقط يؤثر في الأقساط والمتأخرات،
// و«خدمات» مال المكتب نفسه فلا يظهر في كشف حساب المالك
const PAY_PURPOSES = ['إيجار', 'خدمات', 'مياه', 'كهرباء', 'أخرى'];

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...(options.headers || {}) },
  });
  if (res.status === 401) { logout(); throw new Error('انتهت الجلسة'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}

// ---------------- التفقيط: المبلغ بالحروف العربية ----------------
function numberToArabicWords(num) {
  num = Math.floor(Math.abs(num));
  if (num === 0) return 'صفر';
  const ones = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
  const tens = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
  const hundreds = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
  function below1000(n) {
    const parts = [];
    const h = Math.floor(n / 100), r = n % 100;
    if (h) parts.push(hundreds[h]);
    if (r) {
      if (r < 20) parts.push(ones[r]);
      else { const t = Math.floor(r / 10), o = r % 10; parts.push(o ? `${ones[o]} و${tens[t]}` : tens[t]); }
    }
    return parts.join(' و');
  }
  const scales = [
    { v: 1e9, one: 'مليار', two: 'ملياران', few: 'مليارات' },
    { v: 1e6, one: 'مليون', two: 'مليونان', few: 'ملايين' },
    { v: 1e3, one: 'ألف', two: 'ألفان', few: 'آلاف' },
  ];
  const parts = [];
  let rem = num;
  for (const s of scales) {
    const c = Math.floor(rem / s.v);
    if (c) {
      rem %= s.v;
      if (c === 1) parts.push(s.one);
      else if (c === 2) parts.push(s.two);
      else if (c <= 10) parts.push(`${below1000(c)} ${s.few}`);
      else parts.push(`${below1000(c)} ${s.one}`);
    }
  }
  if (rem) parts.push(below1000(rem));
  return parts.join(' و');
}

function tafqeet(amount) {
  const total = Math.round(Number(amount || 0) * 100);
  const riyals = Math.floor(total / 100);
  const halalas = total % 100;
  let riyalText;
  if (riyals === 0) riyalText = '';
  else if (riyals === 1) riyalText = 'ريال سعودي واحد';
  else if (riyals === 2) riyalText = 'ريالان سعوديان';
  else if (riyals >= 3 && riyals <= 10) riyalText = `${numberToArabicWords(riyals)} ريالات سعودية`;
  else riyalText = `${numberToArabicWords(riyals)} ريال سعودي`;
  let text = riyalText;
  if (halalas > 0) text += `${text ? ' و' : ''}${numberToArabicWords(halalas)} هللة`;
  return `${text} فقط لا غير`;
}

// ==== تحويل هجري/ميلادي (دوال صافية — تقويم أم القرى عبر Intl) ====
const HIJRI_MONTHS = ['محرم', 'صفر', 'ربيع الأول', 'ربيع الآخر', 'جمادى الأولى', 'جمادى الآخرة', 'رجب', 'شعبان', 'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة'];
const HIJRI_MONTH_DAYS = [30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 30, 29];

// أجزاء التاريخ الهجري (أم القرى) المقابلة لتاريخ ميلادي (Date محلي)
function gregToHijriParts(date) {
  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(date);
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day };
}

// رقم ترتيبي حسابي تقريبي لليوم الهجري — يُستخدم كخطوة بحث فقط،
// والتحقق النهائي دائماً بمطابقة صياغة Intl الفعلية (أم القرى)
function hijriOrdinalOf(y, m, d) {
  let days = (y - 1) * 354 + Math.floor((11 * (y - 1) + 14) / 30);
  for (let i = 0; i < m - 1 && i < 11; i++) days += HIJRI_MONTH_DAYS[i];
  return days + d;
}

// تحويل تاريخ هجري (أم القرى) إلى Date ميلادية: تقدير حسابي ثم تصحيح
// متكرر بصياغة Intl حتى تطابق الأجزاء الفعلية تماماً
function hijriToGregorian(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 30) return null;
  const target = hijriOrdinalOf(y, m, d);
  let cand = new Date(2000, 0, 1);
  const ap = gregToHijriParts(cand);
  cand.setDate(cand.getDate() + (target - hijriOrdinalOf(ap.y, ap.m, ap.d)));
  for (let i = 0; i < 15; i++) {
    const cp = gregToHijriParts(cand);
    if (cp.y === y && cp.m === m && cp.d === d) return cand;
    const diff = target - hijriOrdinalOf(cp.y, cp.m, cp.d);
    if (diff === 0) break;
    cand.setDate(cand.getDate() + diff);
  }
  // مسح دقيق حول التقدير بمطابقة أجزاء Intl حرفياً (يحسم فروق السنوات الكبيسة)
  for (let off = -3; off <= 3; off++) {
    const t = new Date(cand.getFullYear(), cand.getMonth(), cand.getDate() + off);
    const cp = gregToHijriParts(t);
    if (cp.y === y && cp.m === m && cp.d === d) return t;
  }
  // لا يوجد تطابق حرفي: التاريخ الهجري غير موجود في أم القرى
  // (مثل 30 من شهرٍ طوله 29 يوماً) — نرفضه بدل تخزين تاريخ مختلف بصمت
  return null;
}

function isoToLocalDate(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function localDateToIso(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
// تاريخ هجري → ISO ميلادي (نص) — صيغة التخزين القياسية
function hijriToIso(y, m, d) {
  const g = hijriToGregorian(y, m, d);
  return g ? localDateToIso(g) : null;
}
// ISO ميلادي → أجزاء هجرية {y, m, d}
function isoToHijriParts(iso) {
  const dt = isoToLocalDate(iso);
  return dt ? gregToHijriParts(dt) : null;
}
// صياغة هجرية كاملة بأسماء الشهور العربية: «١١ جمادى الآخرة ١٤٤٨ هـ»
function fmtHijriFull(iso) {
  const dt = isoToLocalDate(iso);
  if (!dt) return '';
  return new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }).format(dt);
}
// صياغة ميلادية كاملة بأسماء الشهور العربية: «21 نوفمبر 2026»
function fmtGregFull(iso) {
  const dt = isoToLocalDate(iso);
  if (!dt) return '';
  return new Intl.DateTimeFormat('ar-u-ca-gregory', { day: 'numeric', month: 'long', year: 'numeric' }).format(dt);
}
// عرض تاريخ عقد حسب تقويمه: هجري كامل إن كان العقد هجرياً، وإلا ISO الميلادي كما هو
function contractDateDisp(c, iso) {
  if (!iso) return '';
  return c && c.calendar === 'hijri' ? fmtHijriFull(iso) : iso;
}
// ==== نهاية تحويل هجري/ميلادي ====

// ==== وقت الإصدار (من الطابع الزمني created_at) بتوقيت الرياض ====
const RIYADH_TZ = 'Asia/Riyadh';
const fmtRiyadhDate = new Intl.DateTimeFormat('ar-u-ca-gregory', { timeZone: RIYADH_TZ, day: 'numeric', month: 'long', year: 'numeric' });
const fmtRiyadhTime = new Intl.DateTimeFormat('ar-u-ca-gregory', { timeZone: RIYADH_TZ, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
const fmtRiyadhTimeHM = new Intl.DateTimeFormat('ar-u-ca-gregory', { timeZone: RIYADH_TZ, hour: 'numeric', minute: '2-digit', hour12: true });
// معلومات إصدار سجل: من created_at إن وُجد (تاريخ + وقت الرياض)، وإلا من تاريخ
// السند نفسه بلا وقت — لا يُختلق وقت أبداً لسجل قديم بلا طابع زمني.
// تُرجع null إن لم يوجد أي تاريخ صالح.
function issuedAtInfo(createdAt, fallbackDateIso) {
  if (createdAt) {
    const d = new Date(createdAt);
    if (!isNaN(d)) {
      return { hasTime: true, dateStr: fmtRiyadhDate.format(d), timeStr: fmtRiyadhTime.format(d), timeHM: fmtRiyadhTimeHM.format(d) };
    }
  }
  if (fallbackDateIso && isoToLocalDate(fallbackDateIso)) {
    return { hasTime: false, dateStr: fmtGregFull(fallbackDateIso), timeStr: '', timeHM: '' };
  }
  return null;
}
// وقت الإصدار المختصر (ساعة:دقيقة) لصفوف القوائم — '' إن لا يوجد طابع زمني
function issuedTimeHM(createdAt) {
  const info = issuedAtInfo(createdAt, null);
  return info && info.hasTime ? info.timeHM : '';
}
// سطر «وقت الإصدار» في مستندات السندات
function issuedAtLine(createdAt, fallbackDateIso) {
  const info = issuedAtInfo(createdAt, fallbackDateIso);
  if (!info) return '';
  return `<div class="r-no">وقت الإصدار: ${esc(info.dateStr)}${info.hasTime ? ` — الساعة ${esc(info.timeStr)}` : ''}</div>`;
}
// ==== نهاية وقت الإصدار ====

// ---------------- ترويسة المؤسسة في المستندات المطبوعة ----------------
function companyHeader(s) {
  if (!s) return '';
  const logo = s.company_logo && String(s.company_logo).startsWith('data:image/') ? String(s.company_logo) : '';
  if (!logo && !s.company_name && !s.company_address && !s.company_phones && !s.company_extra) return '';
  return `<div class="company-header">
    ${logo ? `<img class="company-logo" src="${logo}" alt="">` : ''}
    ${s.company_name ? `<div class="company-name">${esc(s.company_name)}</div>` : ''}
    ${s.company_address ? `<div>${esc(s.company_address)}</div>` : ''}
    ${s.company_phones ? `<div>هاتف: ${esc(s.company_phones)}</div>` : ''}
    ${s.company_extra ? `<div>${esc(s.company_extra)}</div>` : ''}
  </div>`;
}

// ---------------- النافذة المنبثقة ----------------
let modalDirtyCheck = null; // دالة تُرجع true إن وُجد إدخال غير محفوظ في نافذة نموذج مفتوحة
function openModal(title, bodyHtml) {
  modalDirtyCheck = null;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalBackdrop').classList.remove('hidden');
}
function closeModal() {
  if (modalDirtyCheck && modalDirtyCheck()) {
    if (!window.confirm('لديك بيانات غير محفوظة — إغلاق النافذة بدون حفظ؟')) return;
  }
  modalDirtyCheck = null;
  $('#modalBackdrop').classList.add('hidden'); $('#modalBody').innerHTML = '';
}
$('#modalClose').addEventListener('click', closeModal);
// لا إغلاق بالضغط خارج النافذة: ضغطة بالغلط لا تُضيّع ما يكتبه المستخدم أبداً — الإغلاق بزر ✕ أو إلغاء فقط

function formModal(title, fieldsHtml, onSubmit, submitLabel = 'حفظ') {
  openModal(title, `<form id="modalForm">${fieldsHtml}
    <div class="form-actions"><button type="submit" class="btn primary">${submitLabel}</button>
    <button type="button" class="btn" onclick="void(0)" id="modalCancel">إلغاء</button></div>
    <p class="error" id="formError"></p></form>`);
  $('#modalCancel').addEventListener('click', closeModal);
  const formEl = $('#modalForm');
  // لقطة الأساس بعد انتهاء تهيئة النموذج (بعض النماذج تملأ حقولاً تلقائياً فور فتحها)
  let initialData = null;
  setTimeout(() => { try { initialData = JSON.stringify(Object.fromEntries(new FormData(formEl).entries())); } catch (_) {} }, 0);
  modalDirtyCheck = () => initialData !== null && JSON.stringify(Object.fromEntries(new FormData(formEl).entries())) !== initialData;
  // قفل الحفظ أثناء التنفيذ: ضغطة ثانية على «حفظ» (أو إدخال مزدوج) لا تُنشئ نسخة مكررة
  let submitting = false;
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    const btn = formEl.querySelector('button[type="submit"]');
    const btnLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'جارٍ الحفظ…'; }
    const data = Object.fromEntries(new FormData(e.target).entries());
    try { await onSubmit(data); modalDirtyCheck = null; closeModal(); }
    catch (err) {
      $('#formError').textContent = err.message;
      submitting = false;
      if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
    }
  });
}

function confirmDelete(label, onYes) {
  openModal('تأكيد الحذف', `<p>هل أنت متأكد من حذف «${esc(label)}»؟ لا يمكن التراجع.</p>
    <div class="form-actions"><button class="btn danger" id="delYes">حذف نهائي</button>
    <button class="btn" id="delNo">إلغاء</button></div>`);
  $('#delNo').addEventListener('click', closeModal);
  let deleting = false;
  $('#delYes').addEventListener('click', async () => {
    if (deleting) return;
    deleting = true;
    $('#delYes').disabled = true;
    try { await onYes(); closeModal(); } catch (_) { deleting = false; $('#delYes').disabled = false; }
  });
}

// ---------------- الدخول والخروج ----------------
// المستخدم الحالي (الاسم الظاهر والدور ونوع الحساب) — يُحفظ في ذاكرة الجلسة فقط ويُحدَّث من الخادم
// بطلب صريح من صاحب البرنامج: تسجيل الدخول يُطلب عند كل فتح للتطبيق — لا يُحفظ أي دخول دائم على الجهاز
try { localStorage.removeItem('pm_token'); localStorage.removeItem('pm_user'); } catch (_) {}
let ME = null;
try { ME = JSON.parse(sessionStorage.getItem('pm_user') || 'null'); } catch (_) { ME = null; }
const IS_ADMIN = () => !!ME && ME.role === 'admin';
function setME(user) {
  ME = user || null;
  if (ME) sessionStorage.setItem('pm_user', JSON.stringify(ME));
  else sessionStorage.removeItem('pm_user');
}
// إظهار/إخفاء عناصر المدير فقط (تبويبات المستخدمين والإعدادات والتصدير) + شارة المستخدم
function applyRoleUI() {
  const chip = $('#userChip');
  if (chip) chip.textContent = ME ? `👤 ${ME.display_name || ME.username} · ${ME.role === 'admin' ? 'مدير' : 'موظف'}` : '';
  document.querySelectorAll('#tabs [data-admin-only]').forEach((b) => {
    b.classList.toggle('hidden', !IS_ADMIN());
  });
}
function logout() {
  dhikrStop();
  sessionStorage.removeItem('pm_token');
  setME(null);
  $('#app').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
}
$('#logoutBtn').addEventListener('click', logout);
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'خطأ');
    sessionStorage.setItem('pm_token', out.token);
    setME(out.user || null);
    startApp();
  } catch (err) { $('#loginError').textContent = err.message; }
});
// تغيير كلمة السر ذاتياً — المدير الرئيسي يُستثنى برسالة توضح أن كلمته من إعدادات الخادم
$('#changePwBtn').addEventListener('click', () => {
  if (ME && ME.bootstrap) {
    openModal('تغيير كلمة السر', '<p>أنت داخل بحساب <strong>المدير الرئيسي</strong>. كلمة سر هذا الحساب تُغيَّر من إعدادات الخادم (متغير <strong>ADMIN_PASSWORD</strong> في Render) وليس من داخل التطبيق.</p>');
    return;
  }
  formModal('تغيير كلمة السر', `
    <label>كلمة المرور الحالية *<input name="current_password" type="password" required autocomplete="current-password"></label>
    <label>كلمة المرور الجديدة *<input name="new_password" type="password" required autocomplete="new-password" placeholder="6 أحرف على الأقل"></label>`,
    async (data) => {
      await api('/api/me/password', { method: 'POST', body: JSON.stringify(data) });
      openModal('تم بنجاح', '<p>تم تغيير كلمة السر ✅ استخدم الكلمة الجديدة في تسجيل الدخول القادم.</p>');
    });
});

// ---------------- التنقل ----------------
let currentView = 'dashboard';
document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    currentView = b.dataset.view;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  });
});
function go(view) {
  currentView = view;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
  render();
}
// بحث شامل معلّق من شريط العنوان: يُنفَّذ فور فتح لوحة المتابعة
let PENDING_SEARCH = '';
$('#globalSearchTop').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  PENDING_SEARCH = e.target.value.trim();
  if (currentView === 'dashboard') render();
  else go('dashboard');
});
async function render() {
  const views = { dashboard: viewDashboard, properties: viewProperties, units: viewUnits, tenants: viewTenants, contracts: viewContracts, payments: viewPayments, expenses: viewExpenses, vouchers: viewVouchers, statement: viewStatement, owners: viewOwners, monthly: viewMonthly, reports: viewReports, audit: viewAudit, users: viewUsers, backup: viewBackup, settings: viewSettings };
  main().innerHTML = '<p class="muted">جارٍ التحميل…</p>';
  try { await views[currentView](); } catch (e) { main().innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

// بيانات مشتركة
let CACHE = { properties: [], units: [], tenants: [], contracts: [], settings: {} };
async function refreshCache() {
  const [properties, units, tenants, contracts, settings] = await Promise.all([
    api('/api/properties'), api('/api/units'), api('/api/tenants'), api('/api/contracts-full'),
    api('/api/settings').catch(() => ({})),
  ]);
  CACHE = { properties, units, tenants, contracts, settings };
}
const propName = (id) => (CACHE.properties.find((p) => p.id === Number(id)) || {}).name || '';
const unitName = (id) => (CACHE.units.find((u) => u.id === Number(id)) || {}).name || '';
const tenantName = (id) => (CACHE.tenants.find((t) => t.id === Number(id)) || {}).name || '';
const CYCLE_LABELS = { monthly: 'شهري', quarterly: 'ربع سنوي', semiannual: 'نصف سنوي', annual: 'سنوي' };
const CONTRACT_STATUS = { active: ['سارٍ', 'green'], renewed: ['مُجدَّد', ''], ended: ['منتهٍ', 'gray'], vacated: ['خرج وإخلاء', 'red'] };

// ---------------- لوحة المتابعة ----------------
async function viewDashboard() {
  await refreshCache();
  const d = await api('/api/dashboard');
  main().innerHTML = `
    <div class="cards">
      <div class="card good"><div class="lbl">المحصّل هذا الشهر</div><div class="num">${money(d.collected_this_month)}</div></div>
      <div class="card" style="cursor:pointer" onclick="showDuesDetails()" title="اضغط لعرض المستحق والمتأخر عند كل مستأجر"><div class="lbl">المستحق هذا الشهر <span class="muted">(اضغط للتفاصيل)</span></div><div class="num">${money(d.due_this_month)}</div></div>
      <div class="card warn"><div class="lbl">إجمالي المتأخرات</div><div class="num">${money(d.total_arrears)}</div></div>
      <div class="card"><div class="lbl">إجمالي الباقي (من كل العقود)</div><div class="num">${money(d.total_remaining ?? 0)}</div></div>
      <div class="card"><div class="lbl">عقارات / وحدات</div><div class="num">${d.counts.properties} / ${d.counts.units}</div></div>
      <div class="card"><div class="lbl">مستأجرون / عقود سارية</div><div class="num">${d.counts.tenants} / ${d.counts.active_contracts}</div></div>
      <div class="card"><div class="lbl">عدد المستأجرين</div><div class="num">${d.tenants_count ?? d.counts.tenants}</div></div>
      <div class="card"><div class="lbl">عدد الملاك</div><div class="num">${d.owners_count ?? 0}</div></div>
      <div class="card good"><div class="lbl">رصيد المكتب (خدمات − مصروفات المكتب)</div><div class="num">${money(d.office_balance ?? 0)}</div></div>
    </div>

    <div class="section">
      <div class="section-head"><h3>🔍 بحث شامل</h3></div>
      <div class="search-row"><input id="dashSearch" placeholder="ابحث برقم السند أو الهوية أو الجوال أو اسم المستأجر أو الوحدة أو رقم العقد…"><button class="btn primary" id="dashSearchBtn">بحث</button></div>
      <div id="dashSearchResults"></div>
    </div>

    <div class="section">
      <div class="section-head"><h3>⚠️ قائمة المتأخرين</h3><button class="btn primary" onclick="paymentForm()">+ إضافة سند قبض</button></div>
      ${d.arrears_list.length ? `<div class="table-wrap"><table><tr><th>المستأجر</th><th>الوحدة</th><th>العقار</th><th>المتأخرات</th><th></th></tr>
        ${d.arrears_list.map((r) => `<tr><td>${esc(r.tenant_name)}</td><td>${esc(r.unit_name)}</td><td>${esc(r.property_name)}</td><td class="arrears">${money(r.arrears)}</td>
        <td><button class="btn small primary" onclick="paymentForm(${r.contract_id}, ${r.arrears})">تسجيل دفعة</button> ${reminderBtn(r.tenant_id, r.arrears)}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد متأخرات — ممتاز 🎉</p>'}
    </div>

    <div class="section">
      <h3>⏰ أقساط قادمة خلال 10 أيام</h3>
      ${d.upcoming_installments && d.upcoming_installments.length ? `<div class="table-wrap"><table><tr><th>المستأجر</th><th>الوحدة</th><th>العقار</th><th>تاريخ الاستحقاق</th><th>قيمة القسط</th><th>المتبقي منه</th><th></th></tr>
        ${d.upcoming_installments.map((r) => `<tr><td>${esc(r.tenant_name)}</td><td>${esc(r.unit_name)}</td><td>${esc(r.property_name)}</td><td>${esc(r.due_date)}</td>
        <td class="money">${money(r.amount)}</td><td>${money(r.remaining)}</td>
        <td><button class="btn small primary" onclick="paymentForm(${r.contract_id}, ${r.remaining})">تسجيل دفعة</button> ${upcomingReminderBtn(r.tenant_id, r.contract_id)}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد أقساط قادمة خلال 10 أيام</p>'}
    </div>

    <div class="section">
      <h3>📅 عقود تنتهي خلال 60 يوماً</h3>
      ${d.expiring_soon.length ? `<div class="table-wrap"><table><tr><th>المستأجر</th><th>الوحدة</th><th>العقار</th><th>تاريخ الانتهاء</th></tr>
        ${d.expiring_soon.map((r) => `<tr><td>${esc(r.tenant_name)}</td><td>${esc(r.unit_name)}</td><td>${esc(r.property_name)}</td><td>${esc(r.end_date)}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد عقود قريبة الانتهاء.</p>'}
    </div>

    <div class="section">
      <h3>🧾 أحدث سندات القبض</h3>
      ${d.recent_payments.length ? `<div class="table-wrap"><table><tr><th>رقم السند</th><th>التاريخ</th><th>المبلغ</th><th></th></tr>
        ${d.recent_payments.map((p) => `<tr><td>${String(p.receipt_no).padStart(4, '0')}</td><td>${esc(String(p.payment_date).slice(0, 10))}</td><td class="money">${money(p.amount)}</td>
        <td><button class="btn small" onclick="showReceipt(${p.id})">عرض السند</button></td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد دفعات بعد.</p>'}
    </div>`;

  const runSearch = async () => {
    const q = $('#dashSearch').value.trim();
    if (!q) { $('#dashSearchResults').innerHTML = ''; return; }
    const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
    $('#dashSearchResults').innerHTML = globalSearchResults(results);
  };
  $('#dashSearchBtn').addEventListener('click', runSearch);
  $('#dashSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  if (PENDING_SEARCH) {
    $('#dashSearch').value = PENDING_SEARCH;
    PENDING_SEARCH = '';
    runSearch();
  }
}

// تفاصيل بطاقة «المستحق»: مستحق هذا الشهر المتبقي والمتأخرات عند كل مستأجر
async function showDuesDetails() {
  const d = await api('/api/dashboard');
  const rows = d.dues_list || [];
  const totDue = rows.reduce((s, r) => s + (Number(r.due_remaining) || 0), 0);
  const totArr = rows.reduce((s, r) => s + (Number(r.arrears) || 0), 0);
  openModal('المستحقات والمتأخرات — عند مين؟', rows.length ? `
    <div class="table-wrap"><table>
      <tr><th>المستأجر</th><th>الوحدة</th><th>العقار</th><th>مستحق هذا الشهر (المتبقي)</th><th>متأخرات</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.tenant_name)}</td><td>${esc(r.unit_name)}</td><td>${esc(r.property_name)}</td>
        <td class="money">${money(r.due_remaining)}</td>
        <td class="${r.arrears > 0 ? 'arrears' : ''}">${money(r.arrears)}</td>
        <td><button class="btn small primary" onclick="closeModal(); paymentForm(${r.contract_id}, ${r.arrears > 0 ? r.arrears : r.due_remaining})">تسجيل دفعة</button>${r.arrears > 0 ? ' ' + reminderBtn(r.tenant_id, r.arrears) : ''}</td></tr>`).join('')}
      <tr><td colspan="3"><strong>الإجمالي</strong></td><td class="money"><strong>${money(totDue)}</strong></td><td class="arrears"><strong>${money(totArr)}</strong></td><td></td></tr>
    </table></div>
    <p class="muted">«مستحق هذا الشهر» = أقساط بدأت هذا الشهر ولم تُدفع بعد. «متأخرات» = مبالغ حلّ موعدها من فترات سابقة ولم تُدفع.</p>`
    : '<p class="muted">لا توجد مستحقات أو متأخرات حالياً — ممتاز 🎉</p>');
}

// نتائج البحث الشامل مجمّعة حسب النوع، مع انتقال مباشر للملف/السند المعني
function globalSearchResults(r) {
  const total = r.tenants.length + r.contracts.length + r.payments.length + r.expenses.length + r.units.length;
  if (!total) return '<p class="muted">لا توجد نتائج مطابقة.</p>';
  let html = '';
  if (r.tenants.length) {
    html += `<h4 style="margin:12px 0 6px">المستأجرون</h4>` + r.tenants.map((t) => `
      <div class="card" style="margin-bottom:6px"><strong>${esc(t.name)}</strong>
      <span class="muted">${esc(t.phone || '')} · الهوية: ${esc(t.id_number || '—')}${t.contract_no ? ` · رقم العقد: ${esc(t.contract_no)}` : ''}</span>
      <button class="btn small primary" onclick="tenantProfile(${t.id})">فتح ملف المستأجر</button></div>`).join('');
  }
  if (r.units.length) {
    html += `<h4 style="margin:12px 0 6px">الوحدات</h4>` + r.units.map((u) => `
      <div class="card" style="margin-bottom:6px"><strong>${esc(u.name)}</strong>
      <span class="muted">${esc(u.property_name)} · ${esc(u.type || '')} · ${esc(u.status || '')}</span>
      <button class="btn small" onclick="go('units')">عرض الوحدات</button></div>`).join('');
  }
  if (r.contracts.length) {
    html += `<h4 style="margin:12px 0 6px">العقود</h4>` + r.contracts.map((c) => `
      <div class="card" style="margin-bottom:6px"><strong>عقد رقم ${c.id}</strong> — ${esc(c.tenant_name)} · ${esc(c.unit_name)} (${esc(c.property_name)})
      <span class="muted">من ${esc(c.start_date)} ${c.end_date ? 'إلى ' + esc(c.end_date) : ''} · إجمالي الإيجار: ${money(c.rent_amount)}</span>
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn small primary" onclick="paymentForm(${c.id})">+ سند قبض</button>
      <button class="btn small" onclick="showTenantStatement(${c.id})">كشف حساب</button></div></div>`).join('');
  }
  if (r.payments.length) {
    html += `<h4 style="margin:12px 0 6px">سندات القبض</h4>` + r.payments.map((p) => `
      <div class="card" style="margin-bottom:6px"><strong>سند ${String(p.receipt_no).padStart(4, '0')}</strong> — ${esc(p.tenant_name)} · ${esc(p.unit_name)}
      <span class="muted">${esc(p.payment_date)} · ${esc(p.method)}</span> <span class="money">${money(p.amount)}</span>
      <button class="btn small" onclick="showReceipt(${p.id})">عرض السند</button></div>`).join('');
  }
  if (r.expenses.length) {
    html += `<h4 style="margin:12px 0 6px">سندات الصرف / المصروفات</h4>` + r.expenses.map((e) => `
      <div class="card" style="margin-bottom:6px"><strong>سند صرف ${e.voucher_no ? String(e.voucher_no).padStart(4, '0') : '—'}</strong> — ${esc(e.category)}${e.description ? ' — ' + esc(e.description) : ''}
      <span class="muted">${esc(e.expense_date)} · ${esc(e.property_name)}</span> <span class="money">${money(e.amount)}</span>
      <button class="btn small" onclick="showExpenseVoucher(${e.id})">عرض السند</button></div>`).join('');
  }
  return html;
}

function tenantResultCards(results) {
  if (!results.length) return '<p class="muted">لا توجد نتائج.</p>';
  return results.map((t) => `
    <div class="card" style="margin-bottom:8px">
      <strong>${esc(t.name)}</strong> <span class="muted">${esc(t.phone || '')}</span>
      ${t.contract_no ? `<span class="badge">رقم العقد: ${esc(t.contract_no)}</span>` : ''}
      ${t.units && t.units.length ? `<span class="badge">${esc(t.units.join('، '))}</span>` : ''}
      <div style="margin-top:6px">إجمالي ما سدده: <span class="money">${money(t.total_paid)}</span> ·
      سندات: ${t.receipts_count} · المتأخرات: <span class="${t.arrears > 0 ? 'arrears' : ''}">${money(t.arrears)}</span></div>
      <div style="margin-top:8px"><button class="btn small primary" onclick="tenantProfile(${t.id})">فتح ملف المستأجر</button></div>
    </div>`).join('');
}

// ---------------- تذكير بالدفع عبر واتساب ----------------
// تحويل الرقم السعودي المحلي (05xxxxxxxx) إلى الصيغة الدولية (9665xxxxxxxx)
function normalizePhone(phone) {
  let p = String(phone || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (/^05\d{8}$/.test(p)) p = '966' + p.slice(1);
  return p.replace(/\D/g, '');
}
function reminderMessage({ company, tenantName, amount, unitName }) {
  return [
    `السلام عليكم ورحمة الله وبركاته، ${tenantName}`,
    company ? `معكم ${company}.` : 'معكم إدارة الأملاك.',
    `نذكّركم بوجود مبلغ متأخر مستحق قدره ${amount} ر.س${unitName ? ` عن الوحدة (${unitName})` : ''}.`,
    'نرجو التكرم بالسداد في أقرب وقت ممكن، وشاكرين لكم حسن تعاونكم.',
  ].join('\n');
}
function reminderMessageEn({ company, tenantName, amount, unitName, propertyName }) {
  const from = company ? `greetings from ${company}.` : 'greetings from the property management office.';
  const place = unitName
    ? ` for unit ${unitName}${propertyName ? ` (${propertyName})` : ''}`
    : (propertyName ? ` for ${propertyName}` : '');
  return `Dear ${tenantName}, ${from} This is a kind reminder that an amount of ${amount} SAR is overdue${place}. We would appreciate payment at your earliest convenience. Thank you.`;
}
function reminderMessageUr({ company, tenantName, amount, unitName, propertyName }) {
  const from = company ? `${company} کی جانب سے` : 'جائیداد انتظامیہ کی جانب سے';
  const place = unitName
    ? `یونٹ ${unitName}${propertyName ? ` (${propertyName})` : ''} کے کرایے کی مد میں`
    : 'آپ کے ذمے کرایے کی مد میں';
  return [
    `محترم ${tenantName} صاحب، السلام علیکم ورحمۃ اللہ وبرکاتہ۔`,
    `${from} اطلاع دی جاتی ہے کہ ${place} مبلغ ${amount} ریال واجب الادا ہے۔`,
    'براہ کرم جلد از جلد ادائیگی کی زحمت فرمائیں۔ آپ کے تعاون کے ہم شکر گزار ہیں۔',
  ].join('\n');
}
// رسائل التذكير المسبق (القسط لم يستحق بعد) — تنبيه ودي قبل الاستحقاق
function preDueMessage({ company, amount, unitName, dueDate }) {
  const office = company || 'إدارة الأملاك';
  return `تذكير ودي من ${office}: قسط الإيجار البالغ ${amount} ر.س${unitName ? ` للوحدة ${unitName}` : ''} يستحق بتاريخ ${dueDate}. شاكرين تعاونكم.`;
}
function preDueMessageEn({ company, amount, unitName, dueDate }) {
  const office = company || 'the property management office';
  return `Friendly reminder from ${office}: your rent installment of ${amount} SAR${unitName ? ` for unit ${unitName}` : ''} is due on ${dueDate}. Thank you for your cooperation.`;
}
function preDueMessageUr({ company, amount, unitName, dueDate }) {
  const office = company || 'جائیداد انتظامیہ';
  return `${office} کی جانب سے دوستانہ یاد دہانی: ${unitName ? `یونٹ ${unitName} کے ` : ''}کرایے کی قسط ${amount} ر.س بتاریخ ${dueDate} واجب الادا ہے۔ آپ کے تعاون کا شکریہ۔`;
}
// اختيار القالب حسب الوضع: slots.mode = 'predue' قبل الاستحقاق،
// وغير ذلك رسالة المتأخرات الحالية. الوضع يُحسم من تاريخ الاستحقاق.
function reminderMessageFor(lang, slots) {
  if (slots && slots.mode === 'predue') {
    if (lang === 'en') return preDueMessageEn(slots);
    if (lang === 'ur') return preDueMessageUr(slots);
    return preDueMessage(slots);
  }
  if (lang === 'en') return reminderMessageEn(slots);
  if (lang === 'ur') return reminderMessageUr(slots);
  return reminderMessage(slots);
}
function reminderLink(phone, message) {
  return `https://wa.me/${normalizePhone(phone)}?text=${encodeURIComponent(message)}`;
}
function reminderBtn(tenantId, arrears) {
  const t = CACHE.tenants.find((x) => x.id === Number(tenantId));
  if (!t || !t.phone) {
    return `<button class="btn small" disabled title="لا يوجد رقم جوال مسجل لهذا المستأجر — أضف الرقم من ملف المستأجر أولاً">💬 تذكير واتساب</button> <span class="muted" style="font-size:12px">لا يوجد جوال مسجل</span>`;
  }
  return `<button class="btn small" onclick="paymentReminder(${tenantId}, ${Number(arrears || 0)})">💬 تذكير واتساب</button>`;
}
function paymentReminder(tenantId, arrears) {
  const t = CACHE.tenants.find((x) => x.id === Number(tenantId));
  if (!t || !t.phone) return;
  const tContracts = CACHE.contracts.filter((c) => c.tenant_id === t.id);
  const unitNames = tContracts.map((c) => c.unit_name).filter(Boolean);
  const propNames = [...new Set(tContracts.map((c) => c.property_name).filter(Boolean))];
  const slots = {
    mode: 'arrears',
    company: (CACHE.settings || {}).company_name || '',
    tenantName: t.name,
    amount: Number(arrears || 0).toLocaleString('en-US'),
    unitName: unitNames.join('، '),
    propertyName: propNames.join('، '),
  };
  openReminderModal(t, slots);
}
// تذكير من صف «أقساط قادمة»: يجلب القسط التالي غير المسدد للعقد ويختار
// الوضع تلقائياً — اليوم قبل الاستحقاق = تذكير مسبق ودي، وإلا متأخرات.
async function upcomingReminder(tenantId, contractId) {
  const t = CACHE.tenants.find((x) => x.id === Number(tenantId));
  if (!t || !t.phone) return;
  const prof = await api(`/api/tenants/${t.id}/profile`);
  const cc = (prof.contracts || []).find((x) => x.id === Number(contractId));
  if (!cc) return;
  const c = CACHE.contracts.find((x) => x.id === Number(contractId)) || {};
  const nu = cc.next_unpaid;
  const today = todayStr();
  let slots;
  if (nu && nu.due_date && today < nu.due_date) {
    slots = {
      mode: 'predue',
      company: (CACHE.settings || {}).company_name || '',
      tenantName: t.name,
      amount: Number(nu.amount || 0).toLocaleString('en-US'),
      unitName: c.unit_name || '',
      propertyName: c.property_name || '',
      dueDate: nu.due_date,
    };
  } else {
    slots = {
      mode: 'arrears',
      company: (CACHE.settings || {}).company_name || '',
      tenantName: t.name,
      amount: Number(cc.arrears || 0).toLocaleString('en-US'),
      unitName: c.unit_name || '',
      propertyName: c.property_name || '',
    };
  }
  openReminderModal(t, slots);
}
function upcomingReminderBtn(tenantId, contractId) {
  const t = CACHE.tenants.find((x) => x.id === Number(tenantId));
  if (!t || !t.phone) {
    return `<button class="btn small" disabled title="لا يوجد رقم جوال مسجل لهذا المستأجر — أضف الرقم من ملف المستأجر أولاً">💬 تذكير واتساب</button> <span class="muted" style="font-size:12px">لا يوجد جوال مسجل</span>`;
  }
  return `<button class="btn small" onclick="upcomingReminder(${tenantId}, ${contractId})">💬 تذكير واتساب</button>`;
}
function openReminderModal(t, slots) {
  let currentMsg = reminderMessageFor('ar', slots);
  openModal('تذكير بالدفع عبر واتساب', `
    <p class="muted">راجع الرسالة ثم افتح واتساب لإرسالها إلى ${esc(t.name)} (${esc(t.phone)}):</p>
    <label>لغة الرسالة<select id="reminderLang">
      <option value="ar" selected>العربية</option>
      <option value="en">English</option>
      <option value="ur">اردو</option>
    </select></label>
    <div class="amount-words" id="reminderText" style="white-space:pre-wrap">${esc(currentMsg)}</div>
    <div class="form-actions">
      <a class="btn primary" id="reminderWa" style="text-align:center;text-decoration:none;line-height:2" href="${reminderLink(t.phone, currentMsg)}" target="_blank" rel="noopener">💬 فتح واتساب</a>
      <button class="btn" id="copyReminder" type="button">📋 نسخ الرسالة</button>
    </div>
    <p class="error" id="copyMsg"></p>`);
  $('#reminderLang').addEventListener('change', (e) => {
    const lang = e.target.value;
    currentMsg = reminderMessageFor(lang, slots);
    const box = $('#reminderText');
    box.textContent = currentMsg;
    box.dir = lang === 'en' ? 'ltr' : 'rtl';
    box.style.textAlign = lang === 'en' ? 'left' : '';
    $('#reminderWa').href = reminderLink(t.phone, currentMsg);
  });
  $('#copyReminder').addEventListener('click', async () => {
    const out = $('#copyMsg');
    try {
      await navigator.clipboard.writeText(currentMsg);
      out.style.color = 'var(--ok)';
      out.textContent = 'تم نسخ الرسالة ✅ الصقها في أي محادثة.';
    } catch (_) {
      out.textContent = 'تعذّر النسخ التلقائي — حدّد نص الرسالة أعلاه وانسخه يدوياً.';
    }
  });
}

// ---------------- العقارات ----------------
async function viewProperties() {
  await refreshCache();
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>العقارات</h3><button class="btn primary" onclick="propertyForm()">+ إضافة عقار</button></div>
      ${CACHE.properties.length ? `<div class="table-wrap"><table><tr><th>الاسم</th><th>العنوان</th><th>المالك</th><th>الوحدات</th><th></th></tr>
        ${CACHE.properties.map((p) => `<tr><td><strong>${esc(p.name)}</strong></td><td>${esc(p.address || '')}</td><td>${esc(p.owner_name || '')}</td>
          <td>${CACHE.units.filter((u) => u.property_id === p.id).length}</td>
          <td><button class="btn small" onclick="propertyForm(${p.id})">تعديل</button>
          <button class="btn small" onclick="statementFor(${p.id})">كشف حساب</button>
          ${delBtn('properties', p.id, esc(p.name))}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد عقارات بعد. ابدأ بإضافة أول عقار.</p>'}
    </div>`;
}
function propertyForm(id) {
  const p = id ? CACHE.properties.find((x) => x.id === id) : {};
  formModal(id ? 'تعديل عقار' : 'إضافة عقار', `
    <label>اسم العقار *<input name="name" required value="${esc(p.name || '')}"></label>
    <label>العنوان<input name="address" value="${esc(p.address || '')}"></label>
    <label>اسم المالك<input name="owner_name" value="${esc(p.owner_name || '')}"></label>
    <label>ملاحظات<textarea name="notes" rows="2">${esc(p.notes || '')}</textarea></label>`,
    async (data) => { id ? await api(`/api/properties/${id}`, { method: 'PUT', body: JSON.stringify(data) }) : await api('/api/properties', { method: 'POST', body: JSON.stringify(data) }); render(); });
}
function statementFor(propertyId) { go('statement'); setTimeout(() => { const s = $('#stmtProperty'); if (s) { s.value = propertyId; loadStatement(); } }, 60); }

// ---------------- الوحدات ----------------
async function viewUnits() {
  await refreshCache();
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>الوحدات</h3><button class="btn primary" onclick="unitForm()">+ إضافة وحدة</button></div>
      ${CACHE.units.length ? `<div class="table-wrap"><table><tr><th>الوحدة</th><th>العقار</th><th>النوع</th><th>الدور</th><th>الإيجار الافتراضي</th><th>الحالة</th><th></th></tr>
        ${CACHE.units.map((u) => `<tr><td><strong>${esc(u.name)}</strong></td><td>${esc(propName(u.property_id))}</td><td>${esc(u.type || '')}</td><td>${esc(u.floor || '')}</td>
          <td>${money(u.default_rent)}</td><td><span class="badge ${u.status === 'مؤجرة' ? 'green' : u.status === 'صيانة' ? 'red' : 'gray'}">${esc(u.status)}</span></td>
          <td><button class="btn small" onclick="meterModal(${u.id})">العدادات</button>
          <button class="btn small" onclick="unitForm(${u.id})">تعديل</button>
          ${delBtn('units', u.id, esc(u.name))}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد وحدات بعد.</p>'}
    </div>`;
}
function unitForm(id) {
  const u = id ? CACHE.units.find((x) => x.id === id) : {};
  formModal(id ? 'تعديل وحدة' : 'إضافة وحدة', `
    <label>العقار *<select name="property_id" required>${CACHE.properties.map((p) => `<option value="${p.id}" ${u.property_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label>اسم/رقم الوحدة *<input name="name" required value="${esc(u.name || '')}" placeholder="مثال: شقة 3"></label>
    <label>النوع<input name="type" value="${esc(u.type || 'شقة')}"></label>
    <label>الدور<input name="floor" value="${esc(u.floor || '')}"></label>
    <label>الإيجار الافتراضي (ر.س)<input name="default_rent" type="number" step="0.01" min="0" value="${u.default_rent ?? 0}"></label>
    <label>الحالة<select name="status">${['شاغرة', 'مؤجرة', 'صيانة'].map((s) => `<option ${u.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>ملاحظات<textarea name="notes" rows="2">${esc(u.notes || '')}</textarea></label>`,
    async (data) => { data.property_id = Number(data.property_id); data.default_rent = Number(data.default_rent || 0); id ? await api(`/api/units/${id}`, { method: 'PUT', body: JSON.stringify(data) }) : await api('/api/units', { method: 'POST', body: JSON.stringify(data) }); render(); });
}

// ---------------- المستأجرون ----------------
async function viewTenants() {
  await refreshCache();
  const all = await api('/api/tenants-search?q=');
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>المستأجرون</h3><button class="btn primary" onclick="tenantForm()">+ إضافة مستأجر</button></div>
      <div class="search-row"><input id="tenantSearch" placeholder="ابحث بالاسم أو رقم الجوال أو رقم العقد أو رقم الوحدة…"><button class="btn primary" id="tenantSearchBtn">بحث</button></div>
      <div id="tenantResults">${tenantResultCards(all)}</div>
      <div class="table-wrap"><table><tr><th>الاسم</th><th>الجوال</th><th>الهوية</th><th>رقم العقد</th><th></th></tr>
      ${CACHE.tenants.map((t) => `<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(t.phone || '')}</td><td>${esc(t.id_number || '')}</td><td>${esc(t.contract_no || '')}</td>
        <td><button class="btn small primary" onclick="tenantProfile(${t.id})">الملف</button>
        <button class="btn small" onclick="tenantForm(${t.id})">تعديل</button>
        ${delBtn('tenants', t.id, esc(t.name))}</td></tr>`).join('')}</table></div>
    </div>`;
  const run = async () => {
    const q = $('#tenantSearch').value.trim();
    $('#tenantResults').innerHTML = tenantResultCards(await api(`/api/tenants-search?q=${encodeURIComponent(q)}`));
  };
  $('#tenantSearchBtn').addEventListener('click', run);
  $('#tenantSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}
function tenantForm(id) {
  const t = id ? CACHE.tenants.find((x) => x.id === id) : {};
  formModal(id ? 'تعديل مستأجر' : 'إضافة مستأجر', `
    <label>الاسم *<input name="name" required value="${esc(t.name || '')}"></label>
    <label>رقم الجوال<input name="phone" value="${esc(t.phone || '')}"></label>
    <label>رقم الهوية<input name="id_number" value="${esc(t.id_number || '')}"></label>
    <label>رقم العقد<input name="contract_no" value="${esc(t.contract_no || '')}" placeholder="الرقم الذي تضيفه يظهر في كل سندات المستأجر"></label>
    <label>البريد الإلكتروني<input name="email" value="${esc(t.email || '')}"></label>
    <label>ملاحظات<textarea name="notes" rows="2">${esc(t.notes || '')}</textarea></label>`,
    async (data) => { id ? await api(`/api/tenants/${id}`, { method: 'PUT', body: JSON.stringify(data) }) : await api('/api/tenants', { method: 'POST', body: JSON.stringify(data) }); render(); });
}

async function tenantProfile(id) {
  const p = await api(`/api/tenants/${id}/profile`);
  openModal(`ملف المستأجر: ${p.tenant.name}`, `
    <div class="cards" style="grid-template-columns:repeat(3,1fr)">
      <div class="card good"><div class="lbl">إجمالي ما سدده</div><div class="num" style="font-size:18px">${money(p.total_paid)}</div></div>
      <div class="card"><div class="lbl">عدد السندات</div><div class="num" style="font-size:18px">${p.receipts_count}</div></div>
      <div class="card warn"><div class="lbl">المتأخرات</div><div class="num" style="font-size:18px">${money(p.arrears)}</div></div>
    </div>
    <p class="muted">الجوال: ${esc(p.tenant.phone || '—')} · الهوية: ${esc(p.tenant.id_number || '—')}${p.tenant.contract_no ? ` · رقم العقد: ${esc(p.tenant.contract_no)}` : ''}</p>
    <div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap">
      ${p.arrears > 0 ? reminderBtn(p.tenant.id, p.arrears) : ''}
      <button class="btn small" onclick="showAttachments('tenant', ${p.tenant.id}, 'المستأجر')">📎 مرفقات المستأجر</button>
    </div>
    <h4>العقود</h4>
    ${p.contracts.length ? p.contracts.map((c) => `<div class="card" style="margin-bottom:6px">
      <strong>${esc(c.unit_name)}</strong> — ${esc(c.property_name)} · إجمالي الإيجار: ${money(c.rent_amount)} · القسط: ${money(c.installment_amount)} × ${c.installments_total} (${esc(CYCLE_LABELS[c.cycle] || c.cycle)})<br>
      <span class="muted">من ${esc(c.start_date)} ${c.end_date ? 'إلى ' + esc(c.end_date) : ''}</span><br>
      المدفوع: ${money(c.total_paid)} · المستحق: ${money(c.total_due)} · المتأخرات: <span class="${c.arrears > 0 ? 'arrears' : ''}">${money(c.arrears)}</span>
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn small primary" onclick="closeModal();paymentForm(${c.id})">+ سند قبض لهذا العقد</button>
      <button class="btn small" onclick="showTenantStatement(${c.id})">كشف حساب</button>
      <button class="btn small" onclick="printLease(${c.id})">طباعة العقد</button>
      <button class="btn small" onclick="showAttachments('contract', ${c.id}, 'العقد')">📎 مرفقات العقد</button></div></div>`).join('') : '<p class="muted">لا توجد عقود.</p>'}
    <h4>سجل الدفعات الكامل</h4>
    ${p.payments.length ? `<div class="table-wrap"><table><tr><th>السند</th><th>التاريخ</th><th>الوحدة</th><th>المبلغ</th><th>الطريقة</th><th></th></tr>
      ${p.payments.map((pay) => `<tr><td>${String(pay.receipt_no).padStart(4, '0')}</td><td>${esc(pay.payment_date)}</td><td>${esc(pay.unit_name)}</td><td class="money">${money(pay.amount)}</td><td>${esc(pay.method)}</td>
      <td><button class="btn small" onclick="showReceipt(${pay.id})">عرض السند</button></td></tr>`).join('')}</table></div>` : '<p class="muted">لا توجد دفعات مسجلة.</p>'}
  `);
}

// زر حذف — يظهر للمدير فقط (الخادم يرفض حذف الموظف أصلاً برسالة واضحة)
function delBtn(table, id, label) {
  if (!IS_ADMIN()) return '';
  return `<button class="btn small danger" onclick="del('${table}', ${id}, '${label}')">حذف</button>`;
}

async function del(table, id, label) {
  confirmDelete(label, async () => { await api(`/api/${table}/${id}`, { method: 'DELETE' }); render(); });
}

// ---------------- العقود ----------------
async function viewContracts() {
  await refreshCache();
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>العقود</h3><button class="btn primary" onclick="contractForm()">+ إضافة عقد</button></div>
      ${CACHE.contracts.length ? `<div class="table-wrap"><table><tr><th>المستأجر</th><th>الوحدة</th><th>الإيجار</th><th>الفترة</th><th>المدفوع</th><th>المستحق</th><th>المتأخرات</th><th>الحالة</th><th></th></tr>
        ${CACHE.contracts.map((c) => `<tr><td><strong>${esc(c.tenant_name)}</strong></td><td>${esc(c.unit_name)} — ${esc(c.property_name)}</td>
          <td>${money(c.rent_amount)} <span class="muted">(إجمالي العقد)</span><br><span class="muted">القسط: ${money(c.installment_amount)} × ${c.installments_total} (${esc(CYCLE_LABELS[c.cycle] || c.cycle)})</span></td>
          <td>${esc(contractDateDisp(c, c.start_date))}<br><span class="muted">${c.end_date ? 'إلى ' + esc(contractDateDisp(c, c.end_date)) : 'مفتوح'}</span>${c.calendar === 'hijri' ? ' <span class="badge">هجري</span>' : ''}</td>
          <td class="money paid-green">${money(c.total_paid)}</td><td>${money(c.total_due)}</td>
          <td class="${c.arrears > 0 ? 'arrears due-red' : ''}">${money(c.arrears)}</td>
          <td><span class="badge ${(CONTRACT_STATUS[c.status] || CONTRACT_STATUS.ended)[1]}">${(CONTRACT_STATUS[c.status] || CONTRACT_STATUS.ended)[0]}</span></td>
          <td><button class="btn small primary" onclick="paymentForm(${c.id})">+ سند</button>
          <button class="btn small" onclick="renewContract(${c.id})">🔄 تجديد</button>
          <button class="btn small" onclick="showTenantStatement(${c.id})">كشف حساب</button>
          <button class="btn small" onclick="printLease(${c.id})">طباعة العقد</button>
          <button class="btn small" onclick="showAttachments('contract', ${c.id}, 'العقد')">📎</button>
          <button class="btn small" onclick="contractForm(${c.id})">تعديل</button>
          ${delBtn('contracts', c.id, `عقد ${esc(c.tenant_name)}`)}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد عقود بعد.</p>'}
    </div>`;
}
// حساب عدد الدفعات من التواريخ والدورة في نموذج العقد (نفس منطق الخادم)
const CYCLE_MONTHS_F = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const CYCLE_YEAR_COUNT_F = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 };
function addMonthsStr(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const target = new Date(y, (m || 1) - 1 + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d || 1, lastDay));
  const p = (x) => String(x).padStart(2, '0');
  return `${target.getFullYear()}-${p(target.getMonth() + 1)}-${p(target.getDate())}`;
}
function periodCountStr(startStr, endStr, cycle) {
  if (!startStr || !endStr || endStr < startStr) return 0;
  const step = CYCLE_MONTHS_F[cycle] || 1;
  let cur = startStr, count = 0;
  while (cur <= endStr && count < 1200) { count++; cur = addMonthsStr(cur, step); }
  return count;
}

function contractForm(id, prefill) {
  const c = id ? CACHE.contracts.find((x) => x.id === id) : (prefill || {});
  formModal(id ? 'تعديل عقد' : (prefill ? 'تجديد عقد — راجع البيانات ثم احفظ كعقد جديد' : 'إضافة عقد'), `
    <label>بحث الوحدة<input id="ctUnitSearch" type="text" placeholder="ابحث باسم الوحدة أو العقار…"></label>
    <label>الوحدة *<select name="unit_id" required>${CACHE.units.map((u) => `<option value="${u.id}" ${c.unit_id === u.id ? 'selected' : ''}>${esc(u.name)} — ${esc(propName(u.property_id))}</option>`).join('')}</select></label>
    <label>بحث المستأجر<input id="ctTenantSearch" type="text" placeholder="ابحث بالاسم أو رقم الجوال أو رقم العقد…"></label>
    <label>المستأجر *<select name="tenant_id" required>${CACHE.tenants.map((t) => `<option value="${t.id}" ${c.tenant_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <label>تقويم العقد<select name="calendar" id="ctCal"><option value="gregorian" ${c.calendar !== 'hijri' ? 'selected' : ''}>ميلادي</option><option value="hijri" ${c.calendar === 'hijri' ? 'selected' : ''}>هجري</option></select></label>
    <div id="ctGreg">
      <label>تاريخ البداية *<input name="start_date" type="date" required value="${esc(c.start_date || todayStr())}"></label>
      <label>تاريخ النهاية (اختياري)<input name="end_date" type="date" value="${esc(c.end_date || '')}"></label>
    </div>
    <div id="ctHijri" class="hidden">
      <label>تاريخ البداية (هجري) *<span style="display:flex;gap:6px">
        <input id="csHd" name="cs_h_d" type="number" min="1" max="30" placeholder="اليوم">
        <select id="csHm" name="cs_h_m">${HIJRI_MONTHS.map((mn, i) => `<option value="${i + 1}">${mn}</option>`).join('')}</select>
        <input id="csHy" name="cs_h_y" type="number" min="1300" max="1600" placeholder="السنة">
      </span></label>
      <label>تاريخ النهاية (هجري — اختياري)<span style="display:flex;gap:6px">
        <input id="ceHd" name="ce_h_d" type="number" min="1" max="30" placeholder="اليوم">
        <select id="ceHm" name="ce_h_m">${HIJRI_MONTHS.map((mn, i) => `<option value="${i + 1}">${mn}</option>`).join('')}</select>
        <input id="ceHy" name="ce_h_y" type="number" min="1300" max="1600" placeholder="السنة">
      </span></label>
    </div>
    <label>إجمالي إيجار العقد (لكامل المدة) (ر.س) *<input name="rent_amount" type="number" step="0.01" min="0" required value="${c.rent_amount ?? ''}"></label>
    <label>دورة السداد<select name="cycle">${Object.entries(CYCLE_LABELS).map(([v, l]) => `<option value="${v}" ${c.cycle === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>عدد الدفعات (الأقساط)<input name="installments_count" type="number" step="1" min="1" value="${c.installments_count ?? ''}" placeholder="يُحسب تلقائياً من المدة"></label>
    <p class="muted" id="ctHint" style="margin:-4px 0 10px"></p>
    <label>التأمين (ر.س)<input name="deposit" type="number" step="0.01" min="0" value="${c.deposit ?? 0}"></label>
    <label>الحالة<select name="status"><option value="active" ${c.status === 'active' ? 'selected' : ''}>سارٍ</option><option value="renewed" ${c.status === 'renewed' ? 'selected' : ''}>مُجدَّد</option><option value="ended" ${c.status === 'ended' ? 'selected' : ''}>منتهٍ</option><option value="vacated" ${c.status === 'vacated' ? 'selected' : ''}>خرج وإخلاء</option></select></label>
    <label>ملاحظات<textarea name="notes" rows="2">${esc(c.notes || '')}</textarea></label>`,
    async (data) => {
      // تقويم العقد: في وضع الهجري تُحوَّل المدخلات إلى ميلادي ISO (صيغة التخزين القياسية)
      if (data.calendar !== 'hijri') data.calendar = 'gregorian';
      if (data.calendar === 'hijri') {
        const sIso = hijriToIso(data.cs_h_y, data.cs_h_m, data.cs_h_d);
        if (!sIso) throw new Error('تاريخ بداية العقد الهجري غير مكتمل أو غير صالح');
        data.start_date = sIso;
        if (data.ce_h_y || data.ce_h_d) {
          const eIso = hijriToIso(data.ce_h_y, data.ce_h_m, data.ce_h_d);
          if (!eIso) throw new Error('تاريخ نهاية العقد الهجري غير مكتمل أو غير صالح');
          data.end_date = eIso;
        } else data.end_date = null;
      }
      delete data.cs_h_d; delete data.cs_h_m; delete data.cs_h_y;
      delete data.ce_h_d; delete data.ce_h_m; delete data.ce_h_y;
      data.unit_id = Number(data.unit_id); data.tenant_id = Number(data.tenant_id);
      data.rent_amount = Number(data.rent_amount); data.deposit = Number(data.deposit || 0);
      data.installments_count = data.installments_count ? Number(data.installments_count) : null;
      if (!data.end_date) data.end_date = null;
      if (id) {
        await api(`/api/contracts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
      } else {
        await api('/api/contracts', { method: 'POST', body: JSON.stringify(data) });
        // عند حفظ تجديد: يُعلَّم العقد الأصلي تلقائياً بحالة «مُجدَّد»
        if (c && c.renewed_from) {
          try { await api(`/api/contracts/${c.renewed_from}`, { method: 'PUT', body: JSON.stringify({ status: 'renewed' }) }); } catch (_) {}
        }
      }
      render();
    });
  // تعبئة عدد الدفعات تلقائياً من التواريخ والدورة (قابلة للتجاوز اليدوي) + تلميح حي لقيمة الدفعة
  const form = document.getElementById('modalForm');
  if (form) {
    const startEl = form.elements.start_date, endEl = form.elements.end_date,
      cycleEl = form.elements.cycle, rentEl = form.elements.rent_amount,
      countEl = form.elements.installments_count, hintEl = document.getElementById('ctHint');
    // بحث حي عند الوحدة وعند المستأجر: تصفية القائمتين أثناء الكتابة مع الحفاظ على الاختيار الحالي
    const unitSel = form.elements.unit_id, tenantSel = form.elements.tenant_id;
    const unitSearchEl = document.getElementById('ctUnitSearch');
    const tenantSearchEl = document.getElementById('ctTenantSearch');
    const refillUnits = () => {
      const q = (unitSearchEl.value || '').trim();
      const cur = unitSel.value;
      unitSel.innerHTML = CACHE.units.filter((u) => !q || String(u.name || '').includes(q) || String(propName(u.property_id) || '').includes(q))
        .map((u) => `<option value="${u.id}">${esc(u.name)} — ${esc(propName(u.property_id))}</option>`).join('');
      if ([...unitSel.options].some((o) => o.value === cur)) unitSel.value = cur;
    };
    const refillTenants = () => {
      const q = (tenantSearchEl.value || '').trim();
      const cur = tenantSel.value;
      tenantSel.innerHTML = CACHE.tenants.filter((t) => !q || String(t.name || '').includes(q) || String(t.phone || '').includes(q) || String(t.contract_no || '').includes(q))
        .map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
      if ([...tenantSel.options].some((o) => o.value === cur)) tenantSel.value = cur;
    };
    unitSearchEl.addEventListener('input', refillUnits);
    tenantSearchEl.addEventListener('input', refillTenants);
    // تقويم العقد (ميلادي/هجري): مزامنة الاتجاهين بين حقول التاريخ الميلادية
    // والهجرية حتى تعمل حسابات المدة وعدد الدفعات من القيم الميلادية دائماً
    const calSel = document.getElementById('ctCal');
    const ctGregBox = document.getElementById('ctGreg');
    const ctHijriBox = document.getElementById('ctHijri');
    const fillHijriFromGreg = () => {
      const s = startEl.value ? isoToHijriParts(startEl.value) : null;
      const e = endEl.value ? isoToHijriParts(endEl.value) : null;
      if (s) { $('#csHd').value = s.d; $('#csHm').value = s.m; $('#csHy').value = s.y; }
      if (e) { $('#ceHd').value = e.d; $('#ceHm').value = e.m; $('#ceHy').value = e.y; }
    };
    const fillGregFromHijri = () => {
      const s = hijriToIso($('#csHy').value, $('#csHm').value, $('#csHd').value);
      const e = hijriToIso($('#ceHy').value, $('#ceHm').value, $('#ceHd').value);
      if (s) startEl.value = s;
      if (e) endEl.value = e;
    };
    const applyCal = () => {
      if (calSel.value === 'hijri') { fillHijriFromGreg(); ctGregBox.classList.add('hidden'); ctHijriBox.classList.remove('hidden'); }
      else { fillGregFromHijri(); ctHijriBox.classList.add('hidden'); ctGregBox.classList.remove('hidden'); }
    };
    calSel.addEventListener('change', applyCal);
    ['csHd', 'csHm', 'csHy', 'ceHd', 'ceHm', 'ceHy'].forEach((hid) => {
      const el = document.getElementById(hid);
      if (el) el.addEventListener('change', () => { fillGregFromHijri(); onDates(); });
    });
    if (calSel.value === 'hijri') applyCal();
    const autoCount = () => {
      const n = periodCountStr(startEl.value, endEl.value, cycleEl.value);
      return n > 0 ? n : (CYCLE_YEAR_COUNT_F[cycleEl.value] || 12);
    };
    let countTouched = c.installments_count != null && Number(c.installments_count) !== autoCount();
    if (!countEl.value) countEl.value = autoCount();
    const refreshHint = () => {
      const total = Number(rentEl.value) || 0;
      let n = parseInt(countEl.value, 10);
      if (!n || n < 1) n = autoCount();
      const base = Math.round((total / n) * 100) / 100;
      const last = Math.round((total - base * (n - 1)) * 100) / 100;
      hintEl.textContent = total > 0
        ? `قيمة الدفعة الواحدة: ${money(base)}${last !== base ? ` (الدفعة الأخيرة: ${money(last)})` : ''} — على ${n} دفعة`
        : 'أدخل إجمالي الإيجار لعرض قيمة الدفعة الواحدة.';
    };
    const onDates = () => { if (!countTouched) countEl.value = autoCount(); refreshHint(); };
    [startEl, endEl, cycleEl].forEach((el) => el.addEventListener('change', onDates));
    rentEl.addEventListener('input', refreshHint);
    countEl.addEventListener('input', () => { countTouched = true; refreshHint(); });
    refreshHint();
  }
}

// ---------------- إرسال السند واتساب + رمز QR ----------------
// نص رسالة واتساب لملخص سند قبض (دالة صافية تُستخدم في كل أماكن عرض السند)
function receiptWhatsAppText(r) {
  const p = r.payment || {};
  const s = r.summary || {};
  const company = (r.settings || {}).company_name || '';
  const lines = [
    `السلام عليكم ورحمة الله وبركاته، ${r.tenant ? r.tenant.name : ''}`,
    company ? `معكم ${company}.` : 'معكم إدارة الأملاك.',
    `تم استلام مبلغ ${money(p.amount)} — سند قبض رقم ${String(r.receipt_no).padStart(4, '0')} بتاريخ ${p.payment_date || ''}.`,
    `المبلغ بالحروف: ${tafqeet(p.amount)}`,
  ];
  if (p.period_from && p.period_to) lines.push(`فترة السداد: من ${p.period_from} إلى ${p.period_to}.`);
  lines.push(`طريقة الدفع: ${p.method || ''}.`);
  // المتبقي من العقد تفصيلة إيجارية: تظهر في رسالة سندات الإيجار فقط
  if ((p.purpose || 'إيجار') === 'إيجار' && s.remaining_on_contract !== null && s.remaining_on_contract !== undefined) {
    lines.push(`المتبقي من كامل العقد: ${money(s.remaining_on_contract)}.`);
  }
  lines.push('شاكرين لكم حسن تعاونكم.');
  return lines.join('\n');
}
function receiptWaLink(r) {
  const phone = r.tenant ? r.tenant.phone : '';
  return `https://wa.me/${normalizePhone(phone)}?text=${encodeURIComponent(receiptWhatsAppText(r))}`;
}
// زر إرسال السند واتساب من بيانات سند محمّلة — معطّل مع شرح إن لم يوجد جوال للمستأجر
function receiptWaBtn(r) {
  const phone = r.tenant ? r.tenant.phone : '';
  if (!phone) {
    return `<button class="btn" disabled title="لا يوجد رقم جوال مسجل لهذا المستأجر — أضف الرقم من ملف المستأجر أولاً">📤 إرسال السند واتساب</button> <span class="muted" style="font-size:12px">لا يوجد جوال مسجل</span>`;
  }
  return `<a class="btn" style="text-align:center;text-decoration:none;line-height:2" href="${receiptWaLink(r)}" target="_blank" rel="noopener">📤 إرسال السند واتساب</a>`;
}
// زر إرسال من قائمة السندات: يجلب بيانات السند كاملة ثم يفتح واتساب
async function sendReceiptWhatsApp(paymentId) {
  const r = await api(`/api/payments/${paymentId}/receipt`);
  if (!r.tenant || !r.tenant.phone) return;
  window.open(receiptWaLink(r), '_blank', 'noopener');
}
// توليد رمز QR (SVG) محلياً بالكامل عبر مكتبة qrcode.js المضمّنة — بلا أي شبكة
let qrUtf8Ready = false;
function makeQrSvg(text) {
  try {
    if (typeof qrcode === 'undefined') return '';
    if (!qrUtf8Ready && qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      qrUtf8Ready = true;
    }
    const qr = qrcode(0, 'M');
    qr.addData(String(text || ''), 'Byte');
    qr.make();
    return qr.createSvgTag({ cellSize: 3, margin: 4, scalable: true });
  } catch (_) { return ''; }
}

// ---------------- تجديد العقود ----------------
// بيانات تعبئة نموذج التجديد: نفس شروط العقد القديم (المستأجر والوحدة وإجمالي
// الإيجار والدورة وعدد الدفعات والتأمين والملاحظات)، مع إزاحة التواريخ بمدة
// العقد الأصلي بحيث يبدأ الجديد بعد يوم واحد من نهاية القديم.
// دالة صافية — لا يُحفظ شيء حتى يؤكد المستخدم النموذج عبر إنشاء عقد جديد.
function renewalPrefill(c) {
  const out = {
    renewed_from: c.id,
    tenant_id: c.tenant_id, unit_id: c.unit_id,
    rent_amount: c.rent_amount, cycle: c.cycle,
    installments_count: c.installments_count ?? null,
    deposit: c.deposit ?? 0, notes: c.notes || '', status: 'active',
    start_date: '', end_date: '',
  };
  if (c.start_date && c.end_date) {
    const durDays = Math.round((isoToLocalDate(c.end_date) - isoToLocalDate(c.start_date)) / 86400000);
    out.start_date = addDaysStr(c.end_date, 1);
    out.end_date = addDaysStr(out.start_date, durDays);
  } else {
    out.start_date = todayStr();
    out.end_date = '';
  }
  return out;
}
function renewContract(id) {
  const c = CACHE.contracts.find((x) => x.id === Number(id));
  if (!c) return;
  contractForm(null, renewalPrefill(c));
}

// ---------------- سندات القبض والدفعات ----------------
async function viewPayments() {
  await refreshCache();
  const payments = await api('/api/payments');
  const sorted = [...payments].sort((a, b) => (b.receipt_no || 0) - (a.receipt_no || 0));
  const contractById = Object.fromEntries(CACHE.contracts.map((c) => [c.id, c]));
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>سندات القبض</h3><button class="btn primary" onclick="paymentForm()">+ إضافة سند قبض</button></div>
      <div class="search-row"><input id="payFilter" placeholder="تصفية بالاسم أو الوحدة أو رقم السند…"></div>
      <div id="payTable"></div>
      <div style="margin-top:10px"><button class="btn" onclick="toggleTrash()">🗑️ السندات المحذوفة (قابلة للاسترجاع)</button></div>
      <div id="payTrash" style="margin-top:8px"></div>
    </div>`;
  const draw = (list) => {
    $('#payTable').innerHTML = list.length ? `<div class="table-wrap"><table><tr><th>رقم السند</th><th>التاريخ</th><th>الفترة</th><th>المستأجر</th><th>الوحدة</th><th>المبلغ</th><th>الطريقة</th><th></th></tr>
      ${list.map((p) => { const c = contractById[p.contract_id] || {}; const t = CACHE.tenants.find((x) => x.id === c.tenant_id) || {}; const waBtn = t.phone
        ? `<button class="btn small" onclick="sendReceiptWhatsApp(${p.id})">📤 واتساب</button>`
        : `<button class="btn small" disabled title="لا يوجد رقم جوال مسجل لهذا المستأجر — أضف الرقم من ملف المستأجر أولاً">📤 واتساب</button>`; return `<tr><td><strong>${String(p.receipt_no).padStart(4, '0')}</strong>${p.edit_count ? ' <span class="badge">معدّل</span>' : ''}</td><td>${esc(String(p.payment_date).slice(0, 10))}${issuedTimeHM(p.created_at) ? `<div class="muted" style="font-size:11px">🕐 ${esc(issuedTimeHM(p.created_at))}</div>` : ''}</td>
        <td class="muted" style="white-space:nowrap;font-size:12px">${p.period_from ? `${esc(String(p.period_from).slice(0, 10))} – ${esc(String(p.period_to || '').slice(0, 10))}` : '—'}</td>
        <td>${esc(c.tenant_name || '')}</td><td>${esc(c.unit_name || '')}</td><td class="money">${money(p.amount)}</td><td>${esc(p.method)}</td>
        <td><button class="btn small" onclick="showReceipt(${p.id})">عرض/طباعة</button>
        <button class="btn small" onclick="editPayment(${p.id})">تعديل</button>
        ${waBtn}
        <button class="btn small" onclick="showAttachments('payment', ${p.id}, 'سند القبض')">📎</button>
        ${delBtn('payments', p.id, `سند ${String(p.receipt_no).padStart(4, '0')} — سيُنقل إلى السندات المحذوفة ويمكن استرجاعه`)}</td></tr>`; }).join('')}</table></div>`
      : '<p class="muted">لا توجد سندات مطابقة.</p>';
  };
  draw(sorted);
  $('#payFilter').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    draw(sorted.filter((p) => { const c = contractById[p.contract_id] || {}; return !q || `${c.tenant_name} ${c.unit_name} ${p.receipt_no}`.includes(q); }));
  });
}

async function editPayment(id) {
  try {
    const p = await api(`/api/payments/${id}`);
    paymentForm(null, null, p);
  } catch (e) { alert(e.message); }
}
let trashOpen = false;
async function toggleTrash() {
  const box = $('#payTrash');
  if (!box) return;
  if (trashOpen) { box.innerHTML = ''; trashOpen = false; return; }
  const trash = await api('/api/payments-trash');
  trashOpen = true;
  const contractById = Object.fromEntries(CACHE.contracts.map((c) => [c.id, c]));
  box.innerHTML = trash.length ? `<div class="table-wrap"><table><tr><th>رقم السند</th><th>التاريخ</th><th>المستأجر</th><th>المبلغ</th><th>حُذف بتاريخ</th><th></th></tr>
    ${trash.map((p) => { const c = contractById[p.contract_id] || {}; return `<tr><td><strong>${String(p.receipt_no).padStart(4, '0')}</strong></td><td>${esc(String(p.payment_date).slice(0, 10))}</td><td>${esc(c.tenant_name || '')}</td><td class="money">${money(p.amount)}</td><td class="muted">${esc(String(p.deleted_at || '').slice(0, 10))}</td>
    <td><button class="btn small" onclick="showReceipt(${p.id})">عرض</button>
    <button class="btn small primary" onclick="restorePayment(${p.id})">↩️ استرجاع</button></td></tr>`; }).join('')}</table></div>`
    : '<p class="muted">لا توجد سندات محذوفة.</p>';
}
async function restorePayment(id) {
  await api(`/api/payments/${id}/restore`, { method: 'POST' });
  trashOpen = false;
  render();
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, (d || 1) + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
// الفترة الافتراضية لسند قبض حسب العقد وتاريخ الدفع (مرآة لمنطق الخادم في calc.paymentPeriod):
// فترة القسط الذي يقع فيه تاريخ الدفع — من بدايته إلى بداية الفترة التالية − يوم، بحد أقصى نهاية العقد
function defaultPeriodClient(contract, paymentDateStr) {
  if (!contract || !contract.start_date) return null;
  const step = CYCLE_MONTHS_F[contract.cycle] || 1;
  const payDate = paymentDateStr || todayStr();
  const limit = contract.end_date || addMonthsStr(payDate, step);
  const starts = [];
  let cur = contract.start_date;
  while (cur <= limit && starts.length < 1200) { starts.push(cur); cur = addMonthsStr(cur, step); }
  if (!starts.length) starts.push(contract.start_date);
  let idx = 0;
  starts.forEach((s, i) => { if (s <= payDate) idx = i; });
  const total = Number(contract.installments_total) || 0;
  if (total > 0 && idx > total - 1) idx = total - 1;
  const from = starts[Math.min(idx, starts.length - 1)];
  let to = addDaysStr(addMonthsStr(from, step), -1);
  if (contract.end_date && to > contract.end_date) to = contract.end_date;
  return { period_from: from, period_to: to };
}

async function paymentForm(contractId, presetAmount, editPayment = null) {
  await refreshCache();
  const active = CACHE.contracts.filter((c) => c.status === 'active');
  if (!editPayment && !active.length) {
    openModal('إضافة سند قبض', '<p>لا يوجد عقد سارٍ بعد. خطوات البداية:</p><ol><li>أضف عقاراً من تبويب العقارات</li><li>أضف وحدة</li><li>أضف مستأجراً</li><li>أنشئ عقداً — وبعدها يصبح زر سند القبض جاهزاً</li></ol>');
    return;
  }
  const pool = editPayment ? CACHE.contracts : active;
  const sel = editPayment ? editPayment.contract_id : (contractId || active[0].id);
  const c0 = pool.find((c) => c.id === sel);
  formModal(editPayment ? `تعديل سند قبض رقم ${String(editPayment.receipt_no || '').padStart(4, '0')}` : 'إضافة سند قبض', `
    <label>بحث العقار<input id="payPropSearch" type="text" placeholder="اكتب اسم العقار للتصفية…"></label>
    <label>العقار<select id="payProp"></select></label>
    <label>بحث المستأجر<input id="payTenantSearch" type="text" placeholder="ابحث بالاسم أو رقم الجوال أو رقم العقد…"></label>
    <label>المستأجر<select id="payTenant"></select></label>
    <label>العقد (الوحدة) *<select name="contract_id" id="payContract"></select></label>
    <p class="muted" id="payUnitInfo" style="margin:-4px 0 10px"></p>
    <label>رقم القسط<select name="installment_no" id="payInstallment"><option value="">تلقائي — حسب ترتيب السندات</option></select></label>
    <p class="muted" style="margin:-4px 0 10px">اختر رقم القسط إن كانت الدفعة عن قسط بعينه — مهم عند أول سند للمستأجر إن لم يكن عن القسط الأول؛ وستُضبط فترة السداد تلقائياً على فترة ذلك القسط.</p>
    ${editPayment ? '' : `<div class="chips">
      <button type="button" class="chip" id="chipArrears" onclick="setPayAmount(${c0 ? c0.arrears : 0})">سداد المتأخرات: ${money(c0 ? c0.arrears : 0)}</button>
      <button type="button" class="chip" id="chipInstallment" onclick="setPayAmount(${c0 ? (c0.installment_amount ?? c0.rent_amount) : 0})">قيمة قسط واحد: ${money(c0 ? (c0.installment_amount ?? c0.rent_amount) : 0)}</button>
    </div>`}
    <label>المبلغ (ر.س) *<input name="amount" id="payAmount" type="number" step="0.01" min="0.01" required value="${editPayment ? editPayment.amount : (presetAmount ?? '')}"></label>
    <label>تاريخ الدفع<input name="payment_date" type="date" value="${editPayment ? String(editPayment.payment_date).slice(0, 10) : todayStr()}"></label>
    <label>تقويم فترة السداد<select name="period_cal" id="periodCal"><option value="greg" selected>ميلادي</option><option value="hijri">هجري</option></select></label>
    <div id="periodGreg">
      <label>فترة السداد — من<input name="period_from" id="periodFrom" type="date"></label>
      <label>فترة السداد — إلى<input name="period_to" id="periodTo" type="date"></label>
    </div>
    <div id="periodHijri" class="hidden">
      <label>فترة السداد — من (هجري)<span style="display:flex;gap:6px">
        <input name="pf_h_d" id="pfHd" type="number" min="1" max="30" placeholder="اليوم">
        <select name="pf_h_m" id="pfHm">${HIJRI_MONTHS.map((mn, i) => `<option value="${i + 1}">${mn}</option>`).join('')}</select>
        <input name="pf_h_y" id="pfHy" type="number" min="1300" max="1600" placeholder="السنة">
      </span></label>
      <label>فترة السداد — إلى (هجري)<span style="display:flex;gap:6px">
        <input name="pt_h_d" id="ptHd" type="number" min="1" max="30" placeholder="اليوم">
        <select name="pt_h_m" id="ptHm">${HIJRI_MONTHS.map((mn, i) => `<option value="${i + 1}">${mn}</option>`).join('')}</select>
        <input name="pt_h_y" id="ptHy" type="number" min="1300" max="1600" placeholder="السنة">
      </span></label>
    </div>
    <label>طريقة الدفع<select name="method">${PAY_METHODS.map((m) => `<option ${editPayment && editPayment.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    <label>المقابل (الغرض)<select name="purpose">${PAY_PURPOSES.map((x) => `<option ${x === (editPayment ? (editPayment.purpose || 'إيجار') : 'إيجار') ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <p class="muted" style="margin:0">تنبيه: دفعات الإيجار فقط تُحتسب في الأقساط والمتأخرات؛ وباقي الأغراض تحصيلات لا تُنقص متأخرات الإيجار، ودفعات «خدمات» لا تظهر في كشف حساب المالك.</p>
    <label>ملاحظات<input name="notes" value="${esc(editPayment ? (editPayment.notes || '') : '')}"></label>`,
    async (data) => {
      if (!data.contract_id) throw new Error('اختر المستأجر والعقد أولاً — عدّل البحث إن لم يظهر');
      data.installment_no = data.installment_no ? Number(data.installment_no) : null;
      // فترة السداد: في وضع الهجري تُحوَّل المدخلات إلى ميلادي ISO (صيغة التخزين القياسية)
      if (data.period_cal === 'hijri') {
        const f = hijriToIso(data.pf_h_y, data.pf_h_m, data.pf_h_d);
        const t = hijriToIso(data.pt_h_y, data.pt_h_m, data.pt_h_d);
        if (!f || !t) throw new Error('تاريخ فترة السداد الهجري غير مكتمل أو غير صالح');
        data.period_from = f;
        data.period_to = t;
      }
      delete data.period_cal;
      delete data.pf_h_d; delete data.pf_h_m; delete data.pf_h_y;
      delete data.pt_h_d; delete data.pt_h_m; delete data.pt_h_y;
      if (data.period_from && data.period_to && data.period_to < data.period_from) {
        throw new Error('تاريخ نهاية فترة السداد يجب أن يكون بعد تاريخ بدايتها أو مساوياً له');
      }
      if (editPayment) {
        await api(`/api/payments/${editPayment.id}`, { method: 'PUT', body: JSON.stringify({ ...data, contract_id: Number(data.contract_id), amount: Number(data.amount) }) });
        render();
        setTimeout(() => showReceipt(editPayment.id), 80);
      } else {
        const payment = await api('/api/payments', { method: 'POST', body: JSON.stringify({ ...data, contract_id: Number(data.contract_id), amount: Number(data.amount) }) });
        render();
        setTimeout(() => showReceipt(payment.id, true), 80);
      }
    }, editPayment ? 'حفظ التعديل' : 'حفظ وإصدار السند');
  // تعبئة فترة السداد افتراضياً من فترة القسط، مع إبقائها قابلة للتعديل،
  // ومزامنة حقول الهجري/الميلادي عند تبديل التقويم
  const form = document.getElementById('modalForm');
  if (form) {
    const contractEl = form.elements.contract_id;
    const dateEl = form.elements.payment_date;
    const calEl = document.getElementById('periodCal');
    const fromEl = document.getElementById('periodFrom');
    const toEl = document.getElementById('periodTo');
    const gregBox = document.getElementById('periodGreg');
    const hijriBox = document.getElementById('periodHijri');
    let periodTouched = false;
    const gregToHijriFill = () => {
      const f = isoToHijriParts(fromEl.value);
      const t = isoToHijriParts(toEl.value);
      if (f) { $('#pfHd').value = f.d; $('#pfHm').value = f.m; $('#pfHy').value = f.y; }
      if (t) { $('#ptHd').value = t.d; $('#ptHm').value = t.m; $('#ptHy').value = t.y; }
    };
    const hijriToGregFill = () => {
      const f = hijriToIso($('#pfHy').value, $('#pfHm').value, $('#pfHd').value);
      const t = hijriToIso($('#ptHy').value, $('#ptHm').value, $('#ptHd').value);
      if (f) fromEl.value = f;
      if (t) toEl.value = t;
    };
    const applyDefaultPeriod = () => {
      const c = pool.find((x) => x.id === Number(contractEl.value));
      const def = defaultPeriodClient(c, dateEl.value);
      if (!def) return;
      fromEl.value = def.period_from;
      toEl.value = def.period_to;
      if (calEl.value === 'hijri') gregToHijriFill();
    };
    calEl.addEventListener('change', () => {
      if (calEl.value === 'hijri') { gregToHijriFill(); gregBox.classList.add('hidden'); hijriBox.classList.remove('hidden'); }
      else { hijriToGregFill(); hijriBox.classList.add('hidden'); gregBox.classList.remove('hidden'); }
    });
    [fromEl, toEl].forEach((el) => el.addEventListener('change', () => { periodTouched = true; }));
    ['pfHd', 'pfHm', 'pfHy', 'ptHd', 'ptHm', 'ptHy'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => { periodTouched = true; });
    });
    // بحث واختيار متسلسل: عقار ← مستأجر ← عقد، والوحدة تظهر تلقائياً بمجرد اختيار المستأجر
    const propSearchEl = document.getElementById('payPropSearch');
    const propEl = document.getElementById('payProp');
    const tenantSearchEl = document.getElementById('payTenantSearch');
    const tenantEl = document.getElementById('payTenant');
    const unitInfoEl = document.getElementById('payUnitInfo');
    const propIdOf = (c) => { const u = CACHE.units.find((x) => x.id === c.unit_id); return u ? u.property_id : null; };
    const propsInPool = [...new Map(pool.map((c) => [propIdOf(c), c.property_name])).entries()];
    const onContractChanged = () => {
      const c = pool.find((x) => x.id === Number(contractEl.value));
      if (unitInfoEl) unitInfoEl.textContent = c ? `الوحدة: ${c.unit_name} · العقار: ${c.property_name}` : 'لا يوجد عقد مطابق — عدّل البحث أو الاختيار';
      const ca = document.getElementById('chipArrears');
      const ci = document.getElementById('chipInstallment');
      if (c && ca) { ca.textContent = `سداد المتأخرات: ${money(c.arrears)}`; ca.onclick = () => setPayAmount(c.arrears); }
      if (c && ci) { const v = c.installment_amount ?? c.rent_amount; ci.textContent = `قيمة قسط واحد: ${money(v)}`; ci.onclick = () => setPayAmount(v); }
      if (!periodTouched) applyDefaultPeriod();
    };
    const fillContracts = () => {
      const tid = tenantEl.value ? Number(tenantEl.value) : null;
      const cur = contractEl.value;
      const list = pool.filter((c) => c.tenant_id === tid);
      contractEl.innerHTML = list.map((c) => `<option value="${c.id}">${esc(c.unit_name)} — من ${esc(c.start_date)} إلى ${esc(c.end_date || '')}</option>`).join('');
      if ([...contractEl.options].some((o) => o.value === cur)) contractEl.value = cur;
      onContractChanged();
    };
    const fillTenants = () => {
      const pid = propEl.value ? Number(propEl.value) : null;
      const q = (tenantSearchEl.value || '').trim();
      const cur = tenantEl.value;
      const seen = new Map();
      pool.forEach((c) => { if (pid === null || propIdOf(c) === pid) { if (!seen.has(c.tenant_id)) seen.set(c.tenant_id, c.tenant_name); } });
      const list = [...seen.entries()].filter(([tid, name]) => {
        if (!q) return true;
        const t = CACHE.tenants.find((x) => x.id === tid) || {};
        return String(name || '').includes(q) || String(t.phone || '').includes(q) || String(t.contract_no || '').includes(q);
      });
      tenantEl.innerHTML = list.map(([tid, name]) => `<option value="${tid}">${esc(name || '')}</option>`).join('');
      if ([...tenantEl.options].some((o) => o.value === cur)) tenantEl.value = cur;
      fillContracts();
    };
    const fillProps = () => {
      const q = (propSearchEl.value || '').trim();
      const cur = propEl.value;
      propEl.innerHTML = `<option value="">كل العقارات</option>` + propsInPool.filter(([, name]) => !q || String(name || '').includes(q)).map(([id, name]) => `<option value="${id}">${esc(name || '')}</option>`).join('');
      if ([...propEl.options].some((o) => o.value === cur)) propEl.value = cur;
    };
    propSearchEl.addEventListener('input', () => { fillProps(); fillTenants(); });
    propEl.addEventListener('change', fillTenants);
    tenantSearchEl.addEventListener('input', fillTenants);
    tenantEl.addEventListener('change', fillContracts);
    contractEl.addEventListener('change', onContractChanged);
    dateEl.addEventListener('change', () => { if (!periodTouched) applyDefaultPeriod(); });
    fillProps();
    if (c0) propEl.value = String(propIdOf(c0) ?? '');
    fillTenants();
    if (c0) { tenantEl.value = String(c0.tenant_id); fillContracts(); contractEl.value = String(c0.id); onContractChanged(); }
    applyDefaultPeriod();
    // رقم القسط الصريح: قائمة تُبنى من العقد المختار حالياً، وفترته تُملأ تلقائياً
    const instEl = document.getElementById('payInstallment');
    const purposeEl = form.elements.purpose;
    const installmentPeriodClient = (contract, k) => {
      if (!contract || !contract.start_date || !k) return null;
      const step = CYCLE_MONTHS_F[contract.cycle] || 1;
      const from = addMonthsStr(contract.start_date, (k - 1) * step);
      let to = addDaysStr(addMonthsStr(from, step), -1);
      if (contract.end_date && to > contract.end_date) to = contract.end_date;
      return { period_from: from, period_to: to };
    };
    const fillInstallments = () => {
      const c = pool.find((x) => x.id === Number(contractEl.value));
      const cur = instEl.value;
      const n = c ? (Number(c.installments_total) || 0) : 0;
      const amounts = c && Array.isArray(c.installment_amounts) ? c.installment_amounts : [];
      instEl.innerHTML = `<option value="">تلقائي — حسب ترتيب السندات</option>` + Array.from({ length: n }, (_, i) => `<option value="${i + 1}">القسط رقم ${i + 1}${amounts[i] != null ? ` — ${money(amounts[i])}` : ''}</option>`).join('');
      if ([...instEl.options].some((o) => o.value === cur)) instEl.value = cur;
    };
    const syncPurpose = () => {
      const isRent = !purposeEl || purposeEl.value === 'إيجار';
      instEl.disabled = !isRent;
      if (!isRent) instEl.value = '';
    };
    contractEl.addEventListener('change', fillInstallments);
    instEl.addEventListener('change', () => {
      if (periodTouched) return;
      const c = pool.find((x) => x.id === Number(contractEl.value));
      if (instEl.value) {
        const per = installmentPeriodClient(c, Number(instEl.value));
        if (per) { fromEl.value = per.period_from; toEl.value = per.period_to; if (calEl.value === 'hijri') gregToHijriFill(); }
      } else applyDefaultPeriod();
    });
    if (purposeEl) purposeEl.addEventListener('change', syncPurpose);
    fillInstallments();
    if (editPayment && editPayment.installment_no) instEl.value = String(editPayment.installment_no);
    syncPurpose();
    if (editPayment) {
      // في وضع التعديل: فترة السند المحفوظة هي الأساس ولا تُستبدل بالافتراضية
      periodTouched = true;
      if (editPayment.period_from) fromEl.value = String(editPayment.period_from).slice(0, 10);
      if (editPayment.period_to) toEl.value = String(editPayment.period_to).slice(0, 10);
    }
  }
}
function setPayAmount(v) { const el = $('#payAmount'); if (el) el.value = v; }
$('#quickReceipt').addEventListener('click', () => paymentForm());

async function showReceipt(paymentId, justCreated = false) {
  const r = await api(`/api/payments/${paymentId}/receipt`);
  const p = r.payment;
  const s = r.summary || {};
  // سند غير الإيجار (خدمات/مياه/كهرباء/أخرى): بلا صف عقد ولا موقف إيجار — الوحدة فقط
  const isRent = (p.purpose || 'إيجار') === 'إيجار';
  const qrSvg = r.qr_text ? makeQrSvg(r.qr_text) : '';
  const html = `
    <div class="receipt-doc">
      ${companyHeader(r.settings)}
      <h2>سند قبض</h2>
      <div class="r-no">رقم السند: ${String(r.receipt_no).padStart(4, '0')} · التاريخ: ${esc(p.payment_date)}</div>
      ${issuedAtLine(p.created_at, p.payment_date)}
      ${p.edit_count ? `<div class="doc-stamp">نسخة معدّلة${p.edited_at ? ` — آخر تعديل: ${esc(String(p.edited_at).slice(0, 10))}` : ''}</div>` : ''}
      ${p.deleted_at ? `<div class="doc-stamp deleted">سند محذوف — للاطلاع فقط</div>` : ''}
      <table>
        <tr><td>استلمنا من السيد/ة</td><td><strong>${esc(r.tenant ? r.tenant.name : '')}</strong></td></tr>
        ${r.tenant && r.tenant.phone ? `<tr><td>رقم المستأجر (الجوال)</td><td><strong>${esc(r.tenant.phone)}</strong></td></tr>` : ''}
        ${r.tenant && r.tenant.id_number ? `<tr><td>رقم الهوية</td><td>${esc(r.tenant.id_number)}</td></tr>` : ''}
        ${isRent ? `<tr><td>العقار / الوحدة</td><td>${esc(r.property ? r.property.name : '')} — ${esc(r.unit ? r.unit.name : '')}</td></tr>` : `<tr><td>الوحدة</td><td>${esc(r.unit ? r.unit.name : '')}</td></tr>`}
        ${r.installment ? `<tr><td>القسط</td><td>${r.installment.installment_total ? `القسط رقم ${r.installment.installment_index} من أصل ${r.installment.installment_total}` : `الدفعة رقم ${r.installment.installment_index}`}${r.installment.installment_amount != null ? ` · قيمة القسط: ${money(r.installment.installment_amount)}` : ''}</td></tr>` : ''}
        ${isRent ? `<tr><td>العقد</td><td>من ${esc(r.contract ? contractDateDisp(r.contract, r.contract.start_date) : '')} ${r.contract && r.contract.end_date ? 'إلى ' + esc(contractDateDisp(r.contract, r.contract.end_date)) : ''} · إجمالي الإيجار ${money(r.contract ? r.contract.rent_amount : 0)} (${esc(s.cycle_label || '')})</td></tr>` : ''}
        ${p.period_from && p.period_to ? `<tr><td>الفترة</td><td>من ${esc(fmtHijriFull(p.period_from))} (الموافق ${esc(fmtGregFull(p.period_from))} م) إلى ${esc(fmtHijriFull(p.period_to))} (الموافق ${esc(fmtGregFull(p.period_to))} م)</td></tr>` : ''}
        ${isRent && r.tenant && r.tenant.contract_no ? `<tr><td>رقم العقد</td><td><strong>${esc(r.tenant.contract_no)}</strong></td></tr>` : ''}
        <tr><td>المبلغ المستلم</td><td><strong>${money(p.amount)}</strong></td></tr>
        <tr><td>طريقة الدفع</td><td>${esc(p.method)}</td></tr>
        <tr><td>مقابل</td><td>${esc(p.purpose || 'إيجار')}</td></tr>
        ${r.issued_by ? `<tr><td>أصدره</td><td>${esc(r.issued_by)}</td></tr>` : ''}
        ${p.notes ? `<tr><td>ملاحظات</td><td>${esc(p.notes)}</td></tr>` : ''}
        ${isRent ? `<tr><td>إجمالي المدفوع على العقد</td><td class="paid-green">${money(s.total_paid)}</td></tr>` : ''}
        ${r.installment_balance ? `<tr><td>باقي القسط رقم ${r.installment_balance.index} من ${r.installment_balance.total}</td><td class="due-red"><strong>${money(r.installment_balance.remaining)}</strong> (${r.installment_balance.status}${r.installment_balance.status === 'باقي' ? ` — يُستحق في ${esc(r.installment_balance.due_date)}` : ''})</td></tr>` : (r.installment ? `<tr><td>الأقساط</td><td class="paid-green"><strong>مسددة بالكامل ✓</strong></td></tr>` : '')}
        ${isRent ? `<tr><td>المتبقي المستحق (متأخرات)</td><td class="due-red">${money(s.arrears)}</td></tr>` : ''}
        ${isRent && s.remaining_on_contract !== null && s.remaining_on_contract !== undefined ? `<tr><td>المتبقي من كامل العقد</td><td class="due-red">${money(s.remaining_on_contract)}</td></tr>` : ''}
      </table>
      <div class="amount-words">المبلغ بالحروف: ${esc(tafqeet(p.amount))}</div>
      ${r.verify_code ? `<div class="receipt-verify">${qrSvg ? `<div class="qr-box">${qrSvg}</div>` : ''}
        <div class="verify-note">رمز التحقق: <strong>${esc(r.verify_code)}</strong><br><span class="muted">امسح رمز QR بكاميرا الجوال لعرض بيانات السند ومقارنتها مع هذه الورقة.</span></div></div>` : ''}
      <div class="signatures"><div>توقيع المستلم: ____________</div><div>توقيع المدير: ____________</div></div>
    </div>
    <div class="form-actions" style="margin-top:12px"><button class="btn primary" onclick="printReceipt()">🖨️ طباعة / حفظ PDF</button>${receiptWaBtn(r)}</div>`;
  openModal(justCreated ? `✅ تم إصدار سند قبض رقم ${String(r.receipt_no).padStart(4, '0')}` : 'سند قبض', html);
  $('#printArea').innerHTML = html.split('<div class="form-actions"')[0];
}
function printReceipt() { window.print(); }

// ---------------- المصروفات ----------------
async function viewExpenses() {
  await refreshCache();
  const expenses = await api('/api/expenses');
  const sorted = [...expenses].sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date)));
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>المصروفات</h3><button class="btn primary" onclick="expenseForm()">+ إضافة مصروف</button></div>
      ${sorted.length ? `<div class="table-wrap"><table><tr><th>رقم السند</th><th>التاريخ</th><th>العقار</th><th>الوحدة</th><th>التصنيف</th><th>المستفيد</th><th>الوصف</th><th>المبلغ</th><th></th></tr>
        ${sorted.map((e) => `<tr><td><strong>${e.voucher_no ? String(e.voucher_no).padStart(4, '0') : '—'}</strong></td><td>${esc(String(e.expense_date).slice(0, 10))}</td><td>${esc(e.property_id ? propName(e.property_id) : 'المكتب')}</td><td>${esc(e.unit_id ? unitName(e.unit_id) : '—')}</td>
          <td><span class="badge">${esc(e.category)}</span></td><td>${esc(e.payee || '')}</td><td>${esc(e.description || '')}</td><td class="money">${money(e.amount)}</td>
          <td><button class="btn small" onclick="showExpenseVoucher(${e.id})">سند الصرف</button>
          <button class="btn small" onclick="showAttachments('expense', ${e.id}, 'سند الصرف')">📎</button>
          <button class="btn small" onclick="expenseForm(${e.id})">تعديل</button>
          ${delBtn('expenses', e.id, `مصروف ${esc(e.category)}`)}</td></tr>`).join('')}</table></div>
        <p>إجمالي المصروفات: <strong>${money(sorted.reduce((s, e) => s + Number(e.amount || 0), 0))}</strong></p>`
      : '<p class="muted">لا توجد مصروفات بعد.</p>'}
    </div>`;
}
// ---------------- سندات الصرف (تبويب مستقل) ----------------
// نفس سجلات المصروفات وسنداتها المرقّمة — باب ثانٍ لنفس البيانات بلا أي تكرار:
// الإضافة من هنا تمرّ بنموذج المصروف نفسه فيُصدَر السند المرقّم ويُعرض للطباعة.
async function viewVouchers() {
  await refreshCache();
  const expenses = await api('/api/expenses');
  const sorted = [...expenses].sort((a, b) => (b.voucher_no || 0) - (a.voucher_no || 0));
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>سندات الصرف</h3><button class="btn primary" onclick="expenseForm()">+ إضافة سند صرف</button></div>
      <div class="search-row"><input id="vchFilter" placeholder="بحث برقم السند أو اسم المستفيد…">
      <select id="vchProperty" style="width:auto"><option value="">كل العقارات</option>${CACHE.properties.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
      <div id="vchTable"></div>
    </div>`;
  const draw = (list) => {
    const total = list.reduce((s, e) => s + Number(e.amount || 0), 0);
    $('#vchTable').innerHTML = (list.length ? `<div class="table-wrap"><table><tr><th>رقم السند</th><th>التاريخ</th><th>المستفيد</th><th>العقار</th><th>الوحدة</th><th>التصنيف</th><th>المبلغ</th><th>طريقة الدفع</th><th>أصدره</th><th></th></tr>
      ${list.map((e) => `<tr><td><strong>${e.voucher_no ? String(e.voucher_no).padStart(4, '0') : '—'}</strong></td><td>${esc(String(e.expense_date).slice(0, 10))}${issuedTimeHM(e.created_at) ? `<div class="muted" style="font-size:11px">🕐 ${esc(issuedTimeHM(e.created_at))}</div>` : ''}</td><td>${esc(e.payee || '')}</td><td>${esc(e.property_id ? propName(e.property_id) : 'المكتب')}</td><td>${esc(e.unit_id ? unitName(e.unit_id) : '—')}</td>
      <td><span class="badge">${esc(e.category)}</span></td><td class="money">${money(e.amount)}</td><td>${esc(e.payment_method || '')}</td><td>${esc(e.created_by || '')}</td>
      <td><button class="btn small" onclick="showExpenseVoucher(${e.id})">عرض السند</button></td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد سندات مطابقة.</p>')
      + `<p>عدد السندات المعروضة: <strong>${list.length}</strong> · إجمالي المبالغ: <strong>${money(total)}</strong></p>`;
  };
  const apply = () => {
    const q = $('#vchFilter').value.trim();
    const pid = $('#vchProperty').value;
    draw(sorted.filter((e) => {
      if (pid && Number(e.property_id) !== Number(pid)) return false;
      if (!q) return true;
      return `${e.payee || ''} ${e.voucher_no || ''} ${e.voucher_no ? String(e.voucher_no).padStart(4, '0') : ''}`.includes(q);
    }));
  };
  draw(sorted);
  $('#vchFilter').addEventListener('input', apply);
  $('#vchProperty').addEventListener('change', apply);
}

async function expenseForm(id) {
  await refreshCache();
  let e = {};
  if (id) { try { e = await api(`/api/expenses/${id}`); } catch (_) { e = {}; } }
  const cats = ['صيانة', 'كهرباء', 'مياه', 'مرافق', 'سباكة', 'لياسة', 'بويات ودهانات', 'نجارة', 'تكييف', 'مصعد', 'زجاج وألمنيوم', 'مواد بناء', 'أجور عمال', 'نظافة', 'حراسة', 'عمولات', 'نقل ومشال', 'دفعة للمالك', 'أخرى'];
  const methods = PAY_METHODS;
  formModal(id ? 'تعديل مصروف' : 'إضافة مصروف', `
    <label>العقار<select name="property_id" id="expProperty"><option value="" ${id && e.property_id == null ? 'selected' : ''}>— مصروف مكتب (بدون عقار) —</option>${CACHE.properties.map((p) => `<option value="${p.id}" ${e.property_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label>الوحدة (اختياري)<select name="unit_id" id="expUnit"><option value="">— كل العقار —</option></select></label>
    <label>التصنيف<select name="category">${cats.map((c) => `<option ${e.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <label>اسم المستفيد<input name="payee" value="${esc(e.payee || '')}" placeholder="لمن صُرف المبلغ؟"></label>
    <label>المبلغ (ر.س) *<input name="amount" type="number" step="0.01" min="0.01" required value="${e.amount ?? ''}"></label>
    <label>طريقة السداد<select name="payment_method">${methods.map((m) => `<option ${e.payment_method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    <label>التاريخ<input name="expense_date" type="date" value="${esc(String(e.expense_date || todayStr()).slice(0, 10))}"></label>
    <label>الوصف<input name="description" value="${esc(e.description || '')}"></label>`,
    async (data) => {
      data.property_id = data.property_id ? Number(data.property_id) : null; data.amount = Number(data.amount);
      if (!data.property_id) data.unit_id = '';
      data.unit_id = data.unit_id ? Number(data.unit_id) : null;
      const saved = id ? await api(`/api/expenses/${id}`, { method: 'PUT', body: JSON.stringify(data) }) : await api('/api/expenses', { method: 'POST', body: JSON.stringify(data) });
      render();
      if (!id && saved && saved.id) setTimeout(() => showExpenseVoucher(saved.id, true), 80);
    }, id ? 'حفظ' : 'حفظ وإصدار سند الصرف');
  const fillUnits = () => {
    const pid = Number($('#expProperty').value);
    $('#expUnit').innerHTML = '<option value="">— كل العقار —</option>' + CACHE.units.filter((u) => u.property_id === pid).map((u) => `<option value="${u.id}" ${e.unit_id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  };
  $('#expProperty').addEventListener('change', fillUnits);
  fillUnits();
}

async function showExpenseVoucher(expenseId, justCreated = false) {
  const r = await api(`/api/expenses/${expenseId}/voucher`);
  const e = r.expense;
  const html = `
    <div class="receipt-doc">
      ${companyHeader(r.settings)}
      <h2>سند صرف</h2>
      <div class="r-no">رقم السند: ${r.voucher_no ? String(r.voucher_no).padStart(4, '0') : '—'} · التاريخ: ${esc(e.expense_date)}</div>
      ${issuedAtLine(e.created_at, e.expense_date)}
      <table>
        <tr><td>اصرفوا إلى السيد/ة</td><td><strong>${esc(e.payee || '')}</strong></td></tr>
        <tr><td>المبلغ المصروف</td><td><strong>${money(e.amount)}</strong></td></tr>
        <tr><td>طريقة السداد</td><td>${esc(e.payment_method || 'نقداً')}</td></tr>
        ${r.issued_by ? `<tr><td>أصدره</td><td>${esc(r.issued_by)}</td></tr>` : ''}
        <tr><td>التصنيف / سبب الصرف</td><td>${esc(e.category)}${e.description ? ' — ' + esc(e.description) : ''}</td></tr>
        <tr><td>العقار / الوحدة</td><td>${r.property ? esc(r.property.name) + (r.unit ? ' — ' + esc(r.unit.name) : '') : 'المكتب'}</td></tr>
      </table>
      <div class="amount-words">المبلغ بالحروف: ${esc(tafqeet(e.amount))}</div>
      <div class="signatures"><div>المستلم: ____________</div><div>المحاسب: ____________</div><div>الاعتماد: ____________</div></div>
    </div>
    <div class="form-actions" style="margin-top:12px"><button class="btn primary" onclick="printReceipt()">🖨️ طباعة / حفظ PDF</button></div>`;
  openModal(justCreated ? `✅ تم إصدار سند صرف رقم ${r.voucher_no ? String(r.voucher_no).padStart(4, '0') : ''}` : 'سند صرف', html);
  $('#printArea').innerHTML = html.split('<div class="form-actions"')[0];
}

// ---------------- كشف حساب مستأجر ----------------
async function showTenantStatement(contractId) {
  const s = await api(`/api/contracts/${contractId}/statement`);
  const doc = `
    <div class="statement-doc">
      ${companyHeader(s.settings)}
      <h2>كشف حساب مستأجر</h2>
      <p style="text-align:center" class="muted">المستأجر: ${esc(s.tenant ? s.tenant.name : '')} · الجوال: ${esc(s.tenant ? (s.tenant.phone || '—') : '—')} · الوحدة: ${esc(s.unit ? s.unit.name : '')} — ${esc(s.property ? s.property.name : '')}<br>
      العقد: من ${esc(s.contract.start_date)} ${s.contract.end_date ? 'إلى ' + esc(s.contract.end_date) : '(مفتوح)'} · إجمالي الإيجار: ${money(s.contract.rent_amount)} · قيمة القسط: ${money(s.summary.installment_amount)} (${s.summary.installments_total} دفعة — ${esc(s.summary.cycle_label || '')})</p>
      <table><tr><th>التاريخ</th><th>البيان</th><th>مستحق</th><th>مدفوع (إيجار)</th><th>مدفوعات أخرى</th><th>رصيد الإيجار</th></tr>
      ${s.ledger.map((r) => r.type === 'other'
        ? `<tr><td>${esc(r.date)}</td><td>${esc(r.description)}</td><td>—</td><td>—</td><td>${money(r.other_amount)}</td><td>${money(r.balance)}</td></tr>`
        : `<tr><td>${esc(r.date)}</td><td>${esc(r.description)}</td><td>${r.due ? money(r.due) : '—'}</td><td>${r.paid ? money(r.paid) : '—'}</td><td>—</td><td>${money(r.balance)}</td></tr>`).join('')}
      </table>
      <h3 style="text-align:center">إجمالي المستحق: ${money(s.total_due)} · إجمالي مدفوعات الإيجار: ${money(s.total_paid)}${s.total_other_paid ? ` · مدفوعات أخرى: ${money(s.total_other_paid)}` : ''} · رصيد الإيجار المتبقي: ${money(s.remaining)}</h3>
    </div>`;
  openModal('كشف حساب مستأجر', doc + `<div class="form-actions" style="margin-top:12px"><button class="btn primary" onclick="printStatement()">🖨️ طباعة / حفظ PDF</button></div>`);
  $('#printArea').innerHTML = doc;
}

// ---------------- طباعة عقد إيجار ----------------
function printLease(contractId) {
  const c = CACHE.contracts.find((x) => x.id === Number(contractId));
  if (!c) return;
  const tenant = CACHE.tenants.find((t) => t.id === c.tenant_id) || {};
  const unit = CACHE.units.find((u) => u.id === c.unit_id) || {};
  const property = CACHE.properties.find((p) => p.id === (unit.property_id || c.property_id)) || {};
  const s = CACHE.settings || {};
  const lessor = property.owner_name
    ? `${esc(property.owner_name)}${s.company_name ? ` — ويمثله في الإدارة: ${esc(s.company_name)}` : ''}`
    : (s.company_name ? `${esc(s.company_name)} (بصفته مكتب الإدارة المفوّض من المالك)` : '____________');
  const doc = `
    <div class="statement-doc">
      ${companyHeader(s)}
      <h2>عقد إيجار</h2>
      <table>
        <tr><td>الطرف الأول (المؤجر)</td><td>${lessor}</td></tr>
        <tr><td>الطرف الثاني (المستأجر)</td><td><strong>${esc(tenant.name || c.tenant_name || '')}</strong></td></tr>
        <tr><td>جوال المستأجر</td><td>${esc(tenant.phone || '—')}</td></tr>
        <tr><td>هوية المستأجر</td><td>${esc(tenant.id_number || '—')}</td></tr>
        ${tenant.contract_no ? `<tr><td>رقم العقد</td><td>${esc(tenant.contract_no)}</td></tr>` : ''}
        <tr><td>الوحدة المؤجرة</td><td>${esc(unit.name || c.unit_name || '')}${unit.type ? ' (' + esc(unit.type) + ')' : ''}${unit.floor ? ' — الدور: ' + esc(unit.floor) : ''}</td></tr>
        <tr><td>العقار / العنوان</td><td>${esc(property.name || c.property_name || '')}${property.address ? ' — ' + esc(property.address) : ''}</td></tr>
        <tr><td>الأجرة</td><td>إجمالي إيجار العقد لكامل المدة: ${money(c.rent_amount)}</td></tr>
        <tr><td>الدفعات</td><td>قيمة القسط: ${money(c.installment_amount)} × ${c.installments_total} دفعة — دورة السداد: ${esc(CYCLE_LABELS[c.cycle] || c.cycle)}</td></tr>
        <tr><td>مدة العقد</td><td>من ${esc(contractDateDisp(c, c.start_date))} ${c.end_date ? 'إلى ' + esc(contractDateDisp(c, c.end_date)) : '(عقد مفتوح حتى إشعار آخر باتفاق الطرفين)'}${c.calendar === 'hijri' ? ' (بالتقويم الهجري)' : ''}</td></tr>
        ${Number(c.deposit) ? `<tr><td>مبلغ التأمين</td><td>${money(c.deposit)}</td></tr>` : ''}
      </table>
      <h4>بنود عامة</h4>
      <ol style="line-height:2">
        <li>يلتزم المستأجر بسداد الأجرة في مواعيد استحقاقها وفق دورة السداد المذكورة أعلاه.</li>
        <li>مدة هذا العقد هي المدة المذكورة أعلاه، ولا يتجدد إلا باتفاق خطي بين الطرفين.</li>
        <li>يلتزم المستأجر بالمحافظة على الوحدة المؤجرة وعدم إجراء تعديلات جوهرية عليها دون موافقة خطية من المؤجر.</li>
        <li>تكون أعمال الصيانة وفق ما يتفق عليه الطرفان، ويلتزم كل طرف بما يخصه منها.</li>
        <li>حُرر هذا العقد من نسختين متطابقتين، بيد كل طرف نسخة للعمل بموجبها.</li>
      </ol>
      <div class="signatures"><div>الطرف الأول (المؤجر): ____________</div><div>الطرف الثاني (المستأجر): ____________</div></div>
      <div class="signatures"><div>شاهد أول: ____________</div><div>شاهد ثانٍ: ____________</div></div>
    </div>`;
  openModal('عقد إيجار — جاهز للطباعة', doc + `<div class="form-actions" style="margin-top:12px"><button class="btn primary" onclick="printStatement()">🖨️ طباعة / حفظ PDF</button></div>`);
  $('#printArea').innerHTML = doc;
}

// ---------------- المرفقات ----------------
let ATT_CTX = null;
function fmtSize(n) {
  n = Number(n || 0);
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ك.ب`;
  return `${(n / (1024 * 1024)).toFixed(2)} م.ب`;
}
async function showAttachments(entityType, entityId, title) {
  ATT_CTX = { entityType, entityId, title };
  openModal(`📎 مرفقات — ${esc(title)}`, `
    <div id="attList"><p class="muted">جارٍ التحميل…</p></div>
    <label>رفع ملف جديد (صورة أو PDF — حتى 3 ميجابايت)<input type="file" id="attFile" accept="image/*,application/pdf"></label>
    <p class="error" id="attMsg"></p>`);
  const load = async () => {
    const list = await api(`/api/attachments?entity_type=${entityType}&entity_id=${entityId}`);
    $('#attList').innerHTML = list.length ? `<div class="table-wrap"><table><tr><th>الملف</th><th>الحجم</th><th>التاريخ</th><th></th></tr>
      ${list.map((a) => `<tr><td>${esc(a.filename)}</td><td>${fmtSize(a.size)}</td><td>${esc(String(a.created_at).slice(0, 10))}</td>
      <td><a class="btn small" style="text-decoration:none" href="/api/attachments/${a.id}/download?token=${encodeURIComponent(token())}" target="_blank" rel="noopener">فتح/تنزيل</a>
      ${IS_ADMIN() ? `<button class="btn small danger" onclick="deleteAttachment(${a.id})">حذف</button>` : ''}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد مرفقات بعد.</p>';
  };
  await load();
  $('#attFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const msg = $('#attMsg');
    if (file.size > 3 * 1024 * 1024) { msg.textContent = 'حجم الملف يتجاوز 3 ميجابايت'; return; }
    msg.style.color = 'var(--muted)';
    msg.textContent = 'جارٍ الرفع…';
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      await api('/api/attachments', {
        method: 'POST',
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId, filename: file.name, mime: file.type, data_base64: String(dataUrl).split(',')[1] }),
      });
      msg.textContent = '';
      await load();
    } catch (err) { msg.style.color = ''; msg.textContent = err.message; }
  });
}
async function deleteAttachment(id) {
  await api(`/api/attachments/${id}`, { method: 'DELETE' });
  if (ATT_CTX) showAttachments(ATT_CTX.entityType, ATT_CTX.entityId, ATT_CTX.title);
}

// ---------------- عدادات الكهرباء والمياه ----------------
// يرتّب القراءات زمنياً ويحسب استهلاك كل قراءة مقابل سابقتها من نفس النوع
function meterHistory(readings) {
  const sorted = [...readings].sort((a, b) =>
    String(a.reading_date).localeCompare(String(b.reading_date)) || (a.id - b.id));
  const lastByType = {};
  return sorted.map((r) => {
    const prev = lastByType[r.meter_type];
    const consumption = prev
      ? Math.round((Number(r.reading_value) - Number(prev.reading_value)) * 100) / 100
      : null;
    const row = { ...r, consumption, prev_date: prev ? String(prev.reading_date).slice(0, 10) : null };
    lastByType[r.meter_type] = r;
    return row;
  });
}
async function meterModal(unitId) {
  await refreshCache();
  const all = await api('/api/meter_readings');
  const hist = meterHistory(all.filter((r) => r.unit_id === Number(unitId))).reverse();
  openModal(`عدادات الوحدة: ${esc(unitName(unitId))}`, `
    <form id="meterForm">
      <label>نوع العداد<select name="meter_type"><option value="electricity">⚡ كهرباء</option><option value="water">💧 مياه</option></select></label>
      <label>القراءة *<input name="reading_value" type="number" step="0.01" min="0" required></label>
      <label>تاريخ القراءة<input name="reading_date" type="date" value="${todayStr()}"></label>
      <label>ملاحظات<input name="notes"></label>
      <div class="form-actions"><button class="btn primary" type="submit">حفظ القراءة</button></div>
      <p class="error" id="meterError"></p>
    </form>
    <h4>سجل القراءات</h4>
    ${hist.length ? `<div class="table-wrap"><table><tr><th>التاريخ</th><th>النوع</th><th>القراءة</th><th>الاستهلاك</th><th>الفترة</th><th></th></tr>
      ${hist.map((r) => `<tr><td>${esc(String(r.reading_date).slice(0, 10))}</td><td>${r.meter_type === 'water' ? '💧 مياه' : '⚡ كهرباء'}</td>
      <td>${Number(r.reading_value).toLocaleString('en-US')}</td>
      <td>${r.consumption === null ? '—' : `<strong>${Number(r.consumption).toLocaleString('en-US')}</strong>`}</td>
      <td class="muted">${r.prev_date ? 'من ' + esc(r.prev_date) : 'أول قراءة'}</td>
      <td>${IS_ADMIN() ? `<button class="btn small danger" onclick="deleteMeter(${r.id}, ${unitId})">حذف</button>` : ''}</td></tr>`).join('')}</table></div>`
    : '<p class="muted">لا توجد قراءات بعد.</p>'}`);
  let meterSaving = false;
  $('#meterForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (meterSaving) return;
    meterSaving = true;
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api('/api/meter_readings', {
        method: 'POST',
        body: JSON.stringify({
          unit_id: Number(unitId), meter_type: data.meter_type,
          reading_value: Number(data.reading_value),
          reading_date: data.reading_date || todayStr(), notes: data.notes || '',
        }),
      });
      meterModal(unitId);
    } catch (err) { $('#meterError').textContent = err.message; }
  });
}
async function deleteMeter(id, unitId) {
  await api(`/api/meter_readings/${id}`, { method: 'DELETE' });
  meterModal(unitId);
}

// ---------------- كشف حساب المالك ----------------
async function viewStatement() {
  await refreshCache();
  const now = new Date();
  const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  main().innerHTML = `
    <div class="section">
      <h3>كشف حساب المالك</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">
        <label>العقار<select id="stmtProperty">${CACHE.properties.map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(p.owner_name || '')}</option>`).join('')}</select></label>
        <label>من تاريخ<input id="stmtFrom" type="date" value="${first}"></label>
        <label>إلى تاريخ<input id="stmtTo" type="date" value="${todayStr()}"></label>
      </div>
      <button class="btn primary" onclick="loadStatement()">عرض الكشف</button>
      <div id="stmtResult" style="margin-top:14px"></div>
    </div>`;
}
async function loadStatement() {
  const pid = $('#stmtProperty').value;
  const from = $('#stmtFrom').value, to = $('#stmtTo').value;
  const s = await api(`/api/properties/${pid}/statement?from=${from}&to=${to}`);
  const doc = `
    <div class="statement-doc">
      ${companyHeader(s.settings)}
      <h2>كشف حساب مالك</h2>
      <p style="text-align:center" class="muted">العقار: ${esc(s.property.name)} · المالك: ${esc(s.property.owner_name || '—')} · الفترة: ${esc(from)} إلى ${esc(to)}</p>
      <h4>الإيرادات (الإيجارات المحصلة)</h4>
      <table><tr><th>التاريخ</th><th>رقم السند</th><th>البيان</th><th>المبلغ</th></tr>
      ${s.income.map((r) => `<tr><td>${esc(r.date)}</td><td>${String(r.receipt_no).padStart(4, '0')}</td><td>${esc(r.description)}</td><td>${money(r.amount)}</td></tr>`).join('')}
      <tr><td colspan="3"><strong>إجمالي الإيرادات</strong></td><td><strong>${money(s.total_income)}</strong></td></tr></table>
      <h4>المصروفات</h4>
      <table><tr><th>التاريخ</th><th>البيان</th><th>المبلغ</th></tr>
      ${s.expenses.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.description)}</td><td>${money(r.amount)}</td></tr>`).join('')}
      <tr><td colspan="2"><strong>إجمالي المصروفات</strong></td><td><strong>${money(s.total_expenses)}</strong></td></tr></table>
      ${s.payouts && s.payouts.length ? `<h4>دفعات للمالك</h4>
      <table><tr><th>التاريخ</th><th>البيان</th><th>المبلغ</th></tr>
      ${s.payouts.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.description)}</td><td>${money(r.amount)}</td></tr>`).join('')}
      <tr><td colspan="2"><strong>إجمالي دفعات المالك</strong></td><td><strong>${money(s.total_payouts)}</strong></td></tr></table>` : ''}
      <h3 style="text-align:center">الصافي المستحق للمالك: ${money(s.net)}</h3>
    </div>`;
  $('#stmtResult').innerHTML = doc + `<div class="form-actions"><button class="btn primary" onclick="printStatement()">🖨️ طباعة / حفظ PDF</button>
  <button class="btn" onclick="downloadStatementXlsx(${s.property.id}, '${esc(from)}', '${esc(to)}')">⬇️ تنزيل إكسل</button></div>`;
  $('#printArea').innerHTML = doc;
}
function printStatement() { window.print(); }
function downloadStatementXlsx(propertyId, from, to) {
  const a = document.createElement('a');
  a.href = `/api/properties/${propertyId}/statement.xlsx?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&token=${encodeURIComponent(token())}`;
  a.download = `statement-${propertyId}-${from}-${to}.xlsx`;
  a.click();
}

// ---------------- الملاك: قائمة وكشف حساب مجمّع ----------------
let ownersCache = [];
async function viewOwners() {
  ownersCache = await api('/api/owners');
  main().innerHTML = `
    <div class="section">
      <h3>👤 الملاك</h3>
      <p class="muted">الرصيد المستحق الحالي (لكل الفترات) = كل ما حُصّل على عقارات المالك (عدا دفعات «خدمات» فهي مال المكتب) − مصروفات عقاراته العادية − الدفعات المسلَّمة له بتصنيف «دفعة للمالك».</p>
      ${ownersCache.length ? `<div class="table-wrap"><table><tr><th>المالك</th><th>العقارات</th><th>الوحدات</th><th>المحصّل (بدون خدمات)</th><th>المصروفات</th><th>دفعات للمالك</th><th>الرصيد المستحق الحالي</th><th></th></tr>
      ${ownersCache.map((o, i) => `<tr><td><strong>${esc(o.name)}</strong></td><td>${o.properties_count}</td><td>${o.units_count}</td><td>${money(o.total_collected)}</td><td>${money(o.total_expenses)}</td><td>${money(o.total_payouts)}</td><td><strong>${money(o.balance)}</strong></td>
      <td><button class="btn small" onclick="ownerStatementModal(${i})">📄 كشف حساب مجمّع</button></td></tr>`).join('')}
      </table></div>` : '<p class="muted">لا يوجد ملاك بعد — أضف اسم المالك في بيانات العقار.</p>'}
    </div>`;
}
function ownerStatementModal(idx) {
  const o = ownersCache[idx];
  if (!o) return;
  const now = new Date();
  const first = `${now.getFullYear()}-01-01`;
  openModal(`كشف حساب مجمّع — ${o.name}`, `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <label>من تاريخ<input id="ownFrom" type="date" value="${first}"></label>
      <label>إلى تاريخ<input id="ownTo" type="date" value="${todayStr()}"></label>
    </div>
    <div class="form-actions"><button class="btn primary" onclick="loadOwnerCombined(${idx})">عرض الكشف</button></div>
    <div id="ownStmtResult" style="margin-top:12px"></div>`);
}
async function loadOwnerCombined(idx) {
  const o = ownersCache[idx];
  if (!o) return;
  const from = $('#ownFrom').value, to = $('#ownTo').value;
  const r = await api(`/api/owners/statement?owner=${encodeURIComponent(o.key)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const moneyTable = (title, rows, noLabel, totalLabel, total) => `
      <h4>${title}</h4>
      <table><tr><th>التاريخ</th>${noLabel ? `<th>${noLabel}</th>` : ''}<th>البيان</th><th>المبلغ</th></tr>
      ${rows.map((x) => `<tr><td>${esc(x.date)}</td>${noLabel ? `<td>${x.receipt_no ? String(x.receipt_no).padStart(4, '0') : (x.voucher_no ? String(x.voucher_no).padStart(4, '0') : '—')}</td>` : ''}<td>${esc(x.description)}</td><td>${money(x.amount)}</td></tr>`).join('')}
      <tr><td colspan="${noLabel ? 3 : 2}"><strong>${totalLabel}</strong></td><td><strong>${money(total)}</strong></td></tr></table>`;
  const doc = `
    <div class="statement-doc">
      ${companyHeader(r.settings)}
      <h2>كشف حساب مالك — مجمّع (كل العقارات)</h2>
      <p style="text-align:center" class="muted">المالك: ${esc(r.owner.name)} · الفترة: ${esc(from)} إلى ${esc(to)}</p>
      <h3 style="text-align:center">الرصيد المستحق الحالي (لكل الفترات): ${money(r.balance)}</h3>
      ${r.sections.map((sec) => `
      <h3 style="margin-top:18px">العقار: ${esc(sec.property.name)}</h3>
      ${moneyTable('الإيرادات (المحصلة)', sec.income, 'رقم السند', 'إجمالي إيرادات العقار', sec.total_income)}
      ${moneyTable('المصروفات', sec.expenses, null, 'إجمالي مصروفات العقار', sec.total_expenses)}
      ${sec.payouts.length ? moneyTable('دفعات للمالك', sec.payouts, 'رقم السند', 'إجمالي دفعات المالك — العقار', sec.total_payouts) : ''}
      <p><strong>صافي العقار للفترة: ${money(sec.net)}</strong></p>`).join('')}
      <h4>الإجماليات العامة للفترة</h4>
      <table><tr><th>إجمالي الإيرادات</th><th>إجمالي المصروفات</th><th>إجمالي دفعات المالك</th><th>صافي الفترة</th></tr>
      <tr><td>${money(r.total_income)}</td><td>${money(r.total_expenses)}</td><td>${money(r.total_payouts)}</td><td><strong>${money(r.net)}</strong></td></tr></table>
    </div>`;
  $('#ownStmtResult').innerHTML = doc + `<div class="form-actions"><button class="btn primary" onclick="printStatement()">🖨️ طباعة / حفظ PDF</button>
  <button class="btn" onclick="downloadOwnerCombinedXlsx(${idx}, '${esc(from)}', '${esc(to)}')">⬇️ تنزيل إكسل</button></div>`;
  $('#printArea').innerHTML = doc;
}
function downloadOwnerCombinedXlsx(idx, from, to) {
  const o = ownersCache[idx];
  if (!o) return;
  const a = document.createElement('a');
  a.href = `/api/owners/statement.xlsx?owner=${encodeURIComponent(o.key)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&token=${encodeURIComponent(token())}`;
  a.download = `owner-statement-${from}-${to}.xlsx`;
  a.click();
}

// ---------------- الملخص الشهري للمكتب ----------------
async function viewMonthly() {
  await refreshCache();
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  main().innerHTML = `
    <div class="section">
      <h3>📊 الملخص الشهري للمكتب</h3>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <label style="margin:0">الشهر<input id="monthlyMonth" type="month" value="${cur}"></label>
        <button class="btn primary" onclick="loadMonthly()">عرض الملخص</button>
      </div>
      <div id="monthlyResult" style="margin-top:14px"></div>
    </div>`;
  await loadMonthly();
}
async function loadMonthly() {
  const month = $('#monthlyMonth').value;
  if (!month) return;
  const r = await api(`/api/reports/monthly?month=${encodeURIComponent(month)}`);
  const doc = `
    <div class="statement-doc">
      ${companyHeader(r.settings)}
      <h2>الملخص الشهري للمكتب — ${esc(month)}</h2>
      <div class="cards" style="grid-template-columns:repeat(3,1fr)">
        <div class="card good"><div class="lbl">إجمالي المحصّل (${r.payments_count} سند)</div><div class="num" style="font-size:18px">${money(r.total_collected)}</div></div>
        <div class="card warn"><div class="lbl">إجمالي المصروفات (${r.expenses_count})</div><div class="num" style="font-size:18px">${money(r.total_expenses)}</div></div>
        <div class="card"><div class="lbl">الصافي</div><div class="num" style="font-size:18px">${money(r.net)}</div></div>
      </div>
      ${r.office ? `<h4>رصيد المكتب</h4>
      <table><tr><th>البند</th><th>هذا الشهر</th><th>التراكمي (منذ البداية)</th></tr>
      <tr><td>تحصيل «خدمات» — دخل المكتب</td><td class="paid-green">${money(r.office.services_month)}</td><td>${money(r.office.services_total)}</td></tr>
      <tr><td>مصروفات المكتب (بدون عقار)</td><td class="due-red">${money(r.office.expenses_month)}</td><td>${money(r.office.expenses_total)}</td></tr>
      <tr><td><strong>رصيد المكتب</strong></td><td><strong>${money(r.office.month_net)}</strong></td><td><strong>${money(r.office.balance)}</strong></td></tr></table>` : ''}
      <h4>حسب العقار</h4>
      ${r.by_property.length ? `<table><tr><th>العقار</th><th>المحصّل</th><th>المصروفات</th><th>الصافي</th></tr>
      ${r.by_property.map((x) => `<tr><td>${esc(x.property_name)}</td><td>${money(x.collected)}</td><td>${money(x.expenses)}</td><td><strong>${money(x.net)}</strong></td></tr>`).join('')}
      <tr><td><strong>الإجمالي</strong></td><td><strong>${money(r.total_collected)}</strong></td><td><strong>${money(r.total_expenses)}</strong></td><td><strong>${money(r.net)}</strong></td></tr></table>`
      : '<p class="muted">لا توجد حركة مالية في هذا الشهر.</p>'}
      <h4>التحصيل حسب طريقة الدفع</h4>
      ${r.by_method.length ? `<table><tr><th>طريقة الدفع</th><th>عدد السندات</th><th>المبلغ</th></tr>
      ${r.by_method.map((x) => `<tr><td>${esc(x.method)}</td><td>${x.count}</td><td>${money(x.total)}</td></tr>`).join('')}</table>`
      : '<p class="muted">لا توجد تحصيلات في هذا الشهر.</p>'}
      <h4>التحصيل حسب المقابل</h4>
      ${(r.by_purpose && r.by_purpose.length) ? `<table><tr><th>المقابل</th><th>عدد السندات</th><th>المبلغ</th></tr>
      ${r.by_purpose.map((x) => `<tr><td>${esc(x.purpose)}</td><td>${x.count}</td><td>${money(x.total)}</td></tr>`).join('')}</table>`
      : '<p class="muted">لا توجد تحصيلات في هذا الشهر.</p>'}
    </div>`;
  $('#monthlyResult').innerHTML = doc + `<div class="form-actions"><button class="btn primary" onclick="printStatement()">🖨️ طباعة / حفظ PDF</button></div>`;
  $('#printArea').innerHTML = doc;
}

// ---------------- التقارير (سندات القبض / سندات الصرف) ----------------
async function viewReports() {
  await refreshCache();
  const now = new Date();
  const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  main().innerHTML = `
    <div class="section">
      <h3>📋 التقارير</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">
        <label>نوع التقرير<select id="repType">
          <option value="receipts">تقرير سندات القبض</option>
          <option value="expenses">تقرير سندات الصرف / المصروفات</option>
        </select></label>
        <label>العقار<select id="repProperty">
          <option value="">كل العقارات</option>
          ${CACHE.properties.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
        </select></label>
        <label>من تاريخ<input id="repFrom" type="date" value="${first}"></label>
        <label>إلى تاريخ<input id="repTo" type="date" value="${todayStr()}"></label>
      </div>
      <button class="btn primary" onclick="loadReports()">عرض التقرير</button>
      <div id="repResult" style="margin-top:14px"></div>
    </div>`;
  await loadReports();
}
async function loadReports() {
  const type = $('#repType').value;
  const pid = $('#repProperty').value;
  const from = $('#repFrom').value, to = $('#repTo').value;
  const qs = `type=${encodeURIComponent(type)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${pid ? `&property_id=${encodeURIComponent(pid)}` : ''}`;
  const r = await api(`/api/reports/vouchers?${qs}`);
  const isReceipts = type === 'receipts';
  const title = isReceipts ? 'تقرير سندات القبض' : 'تقرير سندات الصرف';
  const propLabel = r.property_id != null ? esc(r.property_name) : 'كل العقارات';
  let tableHtml;
  if (!r.rows.length) {
    tableHtml = '<p class="muted">لا توجد بيانات في هذه الفترة</p>';
  } else if (isReceipts) {
    tableHtml = `<div class="table-wrap"><table><tr><th>التاريخ</th><th>رقم السند</th><th>اسم المستأجر</th><th>العقار</th><th>الوحدة</th><th>المبلغ</th><th>فترة السداد</th><th>طريقة الدفع</th><th>المقابل</th><th>المتبقي على العقد (حالياً)</th></tr>
      ${r.rows.map((x) => `<tr><td>${esc(x.date)}</td><td>${String(x.receipt_no).padStart(4, '0')}</td><td>${esc(x.tenant_name)}</td><td>${esc(x.property_name)}</td><td>${esc(x.unit_name)}</td><td class="money">${money(x.amount)}</td><td>${esc(x.period_label)}</td><td>${esc(x.method)}</td><td>${esc(x.purpose || 'إيجار')}</td><td>${x.remaining_on_contract == null ? '—' : money(x.remaining_on_contract)}</td></tr>`).join('')}
      <tr><td colspan="5"><strong>الإجمالي — عدد السندات: ${r.count}</strong></td><td><strong>${money(r.total_amount)}</strong></td><td colspan="4"></td></tr></table></div>
      ${(r.by_purpose && r.by_purpose.length) ? `<h4>الإجمالي حسب المقابل</h4><table><tr><th>المقابل</th><th>عدد السندات</th><th>المبلغ</th></tr>
      ${r.by_purpose.map((x) => `<tr><td>${esc(x.purpose)}</td><td>${x.count}</td><td>${money(x.total)}</td></tr>`).join('')}</table>` : ''}`;
  } else {
    tableHtml = `<div class="table-wrap"><table><tr><th>التاريخ</th><th>رقم سند الصرف</th><th>المستفيد</th><th>العقار</th><th>الوحدة</th><th>التصنيف</th><th>المبلغ</th><th>طريقة الدفع</th></tr>
      ${r.rows.map((x) => `<tr><td>${esc(x.date)}</td><td>${String(x.voucher_no).padStart(4, '0')}</td><td>${esc(x.payee)}</td><td>${esc(x.property_name)}</td><td>${esc(x.unit_name)}</td><td>${esc(x.category)}</td><td class="money">${money(x.amount)}</td><td>${esc(x.payment_method)}</td></tr>`).join('')}
      <tr><td colspan="6"><strong>الإجمالي — عدد سندات الصرف: ${r.count}</strong></td><td><strong>${money(r.total_amount)}</strong></td><td></td></tr></table></div>`;
  }
  const doc = `
    <div class="statement-doc">
      ${companyHeader(r.settings)}
      <h2>${title}</h2>
      <p style="text-align:center" class="muted">الفترة: من ${esc(from)} إلى ${esc(to)} · العقار: ${propLabel}</p>
      ${tableHtml}
    </div>`;
  $('#repResult').innerHTML = doc + `<div class="form-actions"><button class="btn primary" onclick="printStatement()">🖨️ طباعة / حفظ PDF</button>
  <button class="btn" onclick="downloadReportXlsx('${esc(type)}', '${esc(from)}', '${esc(to)}', '${esc(pid)}')">⬇️ تنزيل إكسل</button></div>`;
  $('#printArea').innerHTML = doc;
}
function downloadReportXlsx(type, from, to, pid) {
  const qs = `type=${encodeURIComponent(type)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${pid ? `&property_id=${encodeURIComponent(pid)}` : ''}&token=${encodeURIComponent(token())}`;
  const a = document.createElement('a');
  a.href = `/api/reports/vouchers.xlsx?${qs}`;
  a.download = `report-${type}-${from}-${to}.xlsx`;
  a.click();
}

// ---------------- سجل الحركات ----------------
// صياغة وقت الحركة بالميلادي وبتوقيت الرياض (Asia/Riyadh)
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  return new Intl.DateTimeFormat('ar-u-ca-gregory', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(d);
}
const AUDIT_ENTITY_LABELS = { payments: 'سندات القبض', expenses: 'المصروفات وسندات الصرف', contracts: 'العقود', tenants: 'المستأجرون', properties: 'العقارات', units: 'الوحدات', meter_readings: 'قراءات العدادات', settings: 'الإعدادات', users: 'المستخدمون', backups: 'النسخ الاحتياطية' };
const AUDIT_ACTION_LABELS = { create: 'إضافة', update: 'تعديل', delete: 'حذف', restore: 'استعادة' };
async function viewAudit() {
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>📜 سجل الحركات</h3>
        <select id="auditFilter" style="width:auto">
          <option value="">كل الحركات</option>
          ${Object.entries(AUDIT_ENTITY_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select></div>
      <p class="muted">سجل تدقيق بكل عمليات الإضافة والتعديل والحذف ومن نفّذها ومتى — للاطلاع فقط ولا يمكن حذف قيوده.</p>
      <div id="auditList"><p class="muted">جارٍ التحميل…</p></div>
    </div>`;
  const load = async () => {
    const f = $('#auditFilter').value;
    const rows = await api(`/api/audit?limit=200${f ? `&entity=${encodeURIComponent(f)}` : ''}`);
    $('#auditList').innerHTML = rows.length ? `<div class="table-wrap"><table><tr><th>الوقت</th><th>المستخدم</th><th>النوع</th><th>العملية</th><th>البيان</th></tr>
      ${rows.map((r) => `<tr><td style="white-space:nowrap">${esc(fmtDateTime(r.created_at))}</td><td>${esc(r.actor || '')}</td>
        <td><span class="badge gray">${esc(AUDIT_ENTITY_LABELS[r.entity] || r.entity)}</span></td>
        <td><span class="badge ${r.action === 'create' ? 'green' : r.action === 'delete' ? 'red' : 'gray'}">${esc(AUDIT_ACTION_LABELS[r.action] || r.action)}</span></td>
        <td>${esc(r.summary || '')}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد حركات مسجلة بعد.</p>';
  };
  $('#auditFilter').addEventListener('change', load);
  await load();
}

// ---------------- المستخدمون (للمدير فقط) ----------------
async function viewUsers() {
  const data = await api('/api/users');
  const roleBadge = (r) => (r === 'admin' ? '<span class="badge green">مدير</span>' : '<span class="badge gray">موظف</span>');
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>👥 المستخدمون</h3><button class="btn primary" onclick="userForm()">+ إضافة مستخدم</button></div>
      <p class="muted">كل مستخدم يدخل بحسابه الخاص، ويظهر اسمه الظاهر على السندات التي يصدرها وفي سجل الحركات. الموظف يضيف ويعدّل ويعرض كل شيء، لكن الحذف والإعدادات وإدارة المستخدمين والتصدير للمدير فقط. لا يُحذف أي حساب نهائياً — الإيقاف فقط، حفاظاً على سجل التدقيق.</p>
      <div class="table-wrap"><table><tr><th>اسم المستخدم</th><th>الاسم الظاهر</th><th>الدور</th><th>الحالة</th><th>تاريخ الإنشاء</th><th></th></tr>
        <tr><td><strong>${esc(data.bootstrap.username)}</strong></td><td>${esc(data.bootstrap.display_name)}</td>
          <td>${roleBadge('admin')}</td><td><span class="badge green">نشط</span></td><td class="muted">—</td>
          <td><span class="muted" style="font-size:12px">المدير الرئيسي — يُدار من إعدادات الخادم</span></td></tr>
        ${data.users.map((u) => `<tr><td><strong>${esc(u.username)}</strong></td><td>${esc(u.display_name || '')}</td>
          <td>${roleBadge(u.role)}</td>
          <td><span class="badge ${u.active ? 'green' : 'red'}">${u.active ? 'نشط' : 'موقوف'}</span></td>
          <td>${esc(fmtDateTime(u.created_at))}</td>
          <td><button class="btn small" onclick="userResetPassword(${u.id}, '${esc(u.username)}')">إعادة تعيين كلمة السر</button>
          <button class="btn small ${u.active ? 'danger' : ''}" onclick="userToggleActive(${u.id}, ${u.active ? 'false' : 'true'}, '${esc(u.username)}')">${u.active ? 'إيقاف' : 'تفعيل'}</button></td></tr>`).join('')}
      </table></div>
    </div>`;
}
function userForm() {
  formModal('إضافة مستخدم', `
    <label>اسم المستخدم *<input name="username" required autocomplete="off" placeholder="اسم الدخول — 3 أحرف على الأقل وبدون مسافات"></label>
    <label>الاسم الظاهر<input name="display_name" placeholder="يظهر على السندات — مثال: موظف الاستقبال"></label>
    <label>كلمة المرور *<input name="password" type="password" required autocomplete="new-password" placeholder="6 أحرف على الأقل"></label>
    <label>الدور<select name="role"><option value="staff">موظف — إضافة وتعديل وعرض، بدون حذف أو إعدادات</option><option value="admin">مدير — كل الصلاحيات</option></select></label>`,
    async (data) => { await api('/api/users', { method: 'POST', body: JSON.stringify(data) }); render(); });
}
async function userToggleActive(id, makeActive, username) {
  try {
    await api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ active: !!makeActive }) });
    render();
  } catch (e) { openModal('تنبيه', `<p class="error">${esc(e.message)}</p>`); }
}
function userResetPassword(id, username) {
  formModal(`إعادة تعيين كلمة سر «${username}»`, `
    <label>كلمة المرور الجديدة *<input name="password" type="password" required autocomplete="new-password" placeholder="6 أحرف على الأقل"></label>`,
    async (data) => { await api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ password: data.password }) }); });
}

// ---------------- إعدادات المؤسسة ----------------
async function viewSettings() {
  const s = await api('/api/settings');
  main().innerHTML = `
    <div class="section">
      <h3>إعدادات المؤسسة</h3>
      <p class="muted">اسم المؤسسة أو المكتب وبياناته — تظهر في ترويسة سندات القبض وسندات الصرف وكشوف الملاك عند الطباعة. اتركها فارغة إن لم ترد طباعتها.</p>
      <form id="settingsForm">
        <label>اسم الشركة / المؤسسة / المكتب<input name="company_name" value="${esc(s.company_name || '')}" placeholder="مثال: مكتب سليمان الحصين لإدارة الأملاك"></label>
        <label>العنوان<input name="company_address" value="${esc(s.company_address || '')}" placeholder="مثال: الرياض — حي الشميسي، شارع ..."></label>
        <label>أرقام الهواتف<input name="company_phones" value="${esc(s.company_phones || '')}" placeholder="مثال: 05xxxxxxxx — 011xxxxxxx"></label>
        <label>بيانات إضافية (سجل تجاري / رقم ضريبي…)<input name="company_extra" value="${esc(s.company_extra || '')}" placeholder="مثال: س.ت 1010xxxxxx"></label>
        <label>شعار المكتب (صورة PNG أو JPG أو WebP — حتى 700 كيلوبايت)<input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp"></label>
        <div id="logoPreview" style="margin-bottom:10px"></div>
        <div class="form-actions"><button type="submit" class="btn primary">حفظ الإعدادات</button></div>
        <p class="error" id="settingsMsg"></p>
      </form>
    </div>
    <div class="section">
      <h3>🕌 التذكير بالذكر</h3>
      <p class="muted">تنبيه صوتي بالاستغفار والصلاة على النبي ﷺ أثناء فتح التطبيق. إعداد شخصي يُحفظ على هذا الجهاز فقط، ولا يدخل في إعدادات الخادم أو النسخ الاحتياطي.</p>
      <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="dhikrEnabled" style="width:auto"> تفعيل التذكير بالذكر</label>
      <label>كل كم دقيقة؟<select id="dhikrInterval">
        <option value="15">كل 15 دقيقة</option>
        <option value="30">كل 30 دقيقة</option>
        <option value="60">كل 60 دقيقة</option>
      </select></label>
      <label>نوع الذكر<select id="dhikrMode">
        <option value="istighfar">الاستغفار</option>
        <option value="salawat">الصلاة على النبي</option>
        <option value="alternate">بالتناوب</option>
      </select></label>
      <div class="form-actions"><button type="button" class="btn" id="dhikrPreview">🔊 تشغيل تجريبي</button></div>
      <p class="muted" id="dhikrMsg" style="margin:0"></p>
    </div>`;
  let logoValue = s.company_logo || '';
  let logoDirty = false;
  const drawLogoPreview = () => {
    $('#logoPreview').innerHTML = logoValue
      ? `<img class="logo-preview" src="${logoValue}" alt="شعار المكتب"><div style="margin-top:6px"><button type="button" class="btn small danger" id="logoRemove">إزالة الشعار</button></div>`
      : '<p class="muted" style="margin:0">لا يوجد شعار حالياً.</p>';
    const rm = $('#logoRemove');
    if (rm) rm.addEventListener('click', () => { logoValue = ''; logoDirty = true; $('#logoFile').value = ''; drawLogoPreview(); });
  };
  drawLogoPreview();
  $('#logoFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    const msg = $('#settingsMsg');
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      msg.style.color = ''; msg.textContent = 'صيغة الشعار غير صالحة — يجب أن تكون صورة PNG أو JPG أو WebP'; return;
    }
    if (file.size > 700 * 1024) {
      msg.style.color = ''; msg.textContent = 'حجم الشعار يتجاوز الحد الأقصى (700 كيلوبايت)'; return;
    }
    const reader = new FileReader();
    reader.onload = () => { logoValue = String(reader.result); logoDirty = true; msg.textContent = ''; drawLogoPreview(); };
    reader.onerror = () => { msg.textContent = 'تعذّرت قراءة ملف الشعار'; };
    reader.readAsDataURL(file);
  });
  $('#settingsForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(ev.target).entries());
    if (logoDirty) data.company_logo = logoValue;
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(data) });
      logoDirty = false;
      const msg = $('#settingsMsg');
      msg.style.color = 'var(--ok)';
      msg.textContent = 'تم حفظ الإعدادات ✅';
    } catch (err) { const msg = $('#settingsMsg'); msg.style.color = ''; msg.textContent = err.message; }
  });
  // إعدادات التذكير بالذكر — محلية على هذا الجهاز فقط (localStorage)
  const dp = dhikrPrefs();
  $('#dhikrEnabled').checked = dp.enabled;
  $('#dhikrInterval').value = String(dp.intervalMin);
  $('#dhikrMode').value = dp.mode;
  const saveDhikr = () => {
    dhikrSavePrefs({ enabled: $('#dhikrEnabled').checked, intervalMin: Number($('#dhikrInterval').value), mode: $('#dhikrMode').value });
    dhikrStart();
    $('#dhikrMsg').textContent = 'تم حفظ إعداد التذكير على هذا الجهاز ✅';
  };
  ['dhikrEnabled', 'dhikrInterval', 'dhikrMode'].forEach((id) => $('#' + id).addEventListener('change', saveDhikr));
  $('#dhikrPreview').addEventListener('click', () => { dhikrInteracted = true; dhikrPlay(dhikrKind(dhikrPrefs().mode)); });
}

// ---------------- التصدير والنسخ الاحتياطي ----------------
async function viewBackup() {
  main().innerHTML = `
    <div class="section">
      <h3>تصدير الجداول (CSV — يفتح في Excel)</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${[['properties', 'العقارات'], ['units', 'الوحدات'], ['tenants', 'المستأجرون'], ['contracts-full', 'العقود مع الملخصات'], ['payments', 'الدفعات والسندات'], ['expenses', 'المصروفات'], ['meter_readings', 'قراءات العدادات'], ['attachments', 'المرفقات (البيانات فقط)']]
          .map(([t, l]) => `<button class="btn" onclick="downloadCsv('${t}')">⬇️ ${l}</button>`).join('')}
      </div>
    </div>
    <div class="section">
      <h3>نسخة احتياطية كاملة (JSON)</h3>
      <p class="muted">ملف واحد فيه كل بيانات النظام. احتفظ به في مكان آمن، ويمكنك استرجاعه في أي وقت.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn primary" onclick="downloadBackup()">⬇️ تنزيل النسخة الاحتياطية</button>
        <label style="margin:0">استرجاع نسخة:<input type="file" id="importFile" accept=".json" style="width:auto"></label>
      </div>
      <p class="error" id="importMsg"></p>
    </div>
    <div class="section">
      <h3>🗂️ النسخ الاحتياطية التلقائية</h3>
      <p class="muted">يحتفظ البرنامج بآخر نسخة احتياطية كاملة فقط — تُحدَّث تلقائياً بعد كل عملية، ونسخة أمان إضافية تظهر مؤقتاً عند الاستعادة أو الاستيراد. يمكنك أيضاً أخذ نسخة يدوياً في أي وقت (تحل محل النسخة الحالية). الاستعادة تستبدل كل البيانات الحالية، وقبلها يأخذ النظام نسخة أمان «قبل استعادة» من الحالة الحالية تلقائياً فتبقى ظاهرة في القائمة حتى التغيير التالي.</p>
      <p class="muted" id="driveStatusLine">رفع جوجل درايف: جارٍ التحقق…</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <button class="btn primary" onclick="takeManualBackup()">📸 أخذ نسخة الآن</button>
        <span class="muted" id="backupMsg"></span>
      </div>
      <div id="backupsList"><p class="muted">جارٍ التحميل…</p></div>
    </div>`;
  loadBackupsList();
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('الاسترجاع سيستبدل كل البيانات الحالية. هل أنت متأكد؟')) return;
    try {
      const parsed = JSON.parse(await file.text());
      await api('/api/import', { method: 'POST', body: JSON.stringify(parsed) });
      $('#importMsg').style.color = 'var(--ok)';
      $('#importMsg').textContent = 'تم الاسترجاع بنجاح ✅';
      render();
    } catch (err) { $('#importMsg').textContent = 'فشل الاسترجاع: ' + err.message; }
  });
}
function downloadCsv(table) {
  const a = document.createElement('a');
  a.href = `/api/export/${table}.csv?token=${encodeURIComponent(token())}`;
  a.download = `${table}.csv`;
  a.click();
}
function downloadBackup() {
  const a = document.createElement('a');
  a.href = `/api/backup?token=${encodeURIComponent(token())}`;
  a.download = 'property-backup.json';
  a.click();
}

// ---------------- النسخ الاحتياطية التلقائية (لقطات النظام) ----------------
const BACKUP_TRIGGER_LABELS = { auto: 'تلقائية', manual: 'يدوية', 'pre-restore': 'قبل استعادة', 'pre-import': 'قبل استيراد' };
function driveCell(b) {
  if (b.drive_status === 'synced') return '<span class="badge green">✓ تم الرفع</span>';
  if (b.drive_status === 'failed') return `<span class="badge red" title="${esc(b.drive_error || '')}">✗ فشل الرفع</span>`;
  return '<span class="muted">—</span>';
}
async function loadBackupsList() {
  const box = $('#backupsList');
  if (!box) return;
  try {
    const resp = await api('/api/backups');
    const rows = Array.isArray(resp) ? resp : (resp.backups || []);
    const statusLine = $('#driveStatusLine');
    if (statusLine && !Array.isArray(resp)) {
      statusLine.innerHTML = resp.drive_configured
        ? 'رفع جوجل درايف: <strong>مفعّل ✓</strong> — تُرفع كل نسخة تلقائياً إلى مجلد Drive، ويُحتفظ بأحدث نسخة واحدة فقط هناك.'
        : 'رفع جوجل درايف: <strong>غير مفعّل</strong> — يُفعَّل من إعدادات الخادم (متغيرات البيئة في Render). النسخ محفوظة داخل قاعدة البيانات فقط.';
    }
    box.innerHTML = rows.length ? `<div class="table-wrap"><table><tr><th>الوقت</th><th>النوع</th><th>الحجم</th><th>درايف</th><th></th></tr>
      ${rows.map((b) => `<tr><td style="white-space:nowrap">${esc(fmtDateTime(b.created_at))}</td>
        <td><span class="badge ${b.trigger === 'manual' ? 'green' : (b.trigger === 'pre-restore' || b.trigger === 'pre-import') ? 'red' : 'gray'}">${esc(BACKUP_TRIGGER_LABELS[b.trigger] || b.trigger)}</span></td>
        <td>${fmtSize(b.size_bytes)}</td>
        <td>${driveCell(b)}</td>
        <td><a class="btn small" style="text-decoration:none" href="/api/backups/${b.id}/download?token=${encodeURIComponent(token())}">⬇️ تنزيل</a>
        <button class="btn small danger" onclick="restoreBackup(${b.id}, '${esc(fmtDateTime(b.created_at))}')">استعادة</button></td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد نسخ محفوظة بعد — ستظهر أول نسخة تلقائياً بعد أول تغيير في البيانات.</p>';
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
async function takeManualBackup() {
  const msg = $('#backupMsg');
  try {
    await api('/api/backups', { method: 'POST' });
    if (msg) { msg.style.color = 'var(--ok)'; msg.textContent = 'تم أخذ النسخة ✅'; }
    loadBackupsList();
  } catch (e) { if (msg) { msg.style.color = ''; msg.textContent = e.message; } }
}
function restoreBackup(id, whenLabel) {
  openModal('تأكيد استعادة نسخة احتياطية', `
    <p>سيتم استبدال <strong>كل البيانات الحالية</strong> بمحتوى النسخة المحفوظة بتاريخ <strong>${esc(whenLabel)}</strong>.</p>
    <p class="muted">قبل الاستبدال، سيأخذ النظام تلقائياً نسخة أمان من الحالة الحالية (نوعها «قبل استعادة»)، فيمكنك الرجوع إليها إن احتجت.</p>
    <div class="form-actions"><button class="btn danger" id="restoreYes">استعادة النسخة</button>
    <button class="btn" id="restoreNo">إلغاء</button></div>
    <p class="error" id="restoreMsg"></p>`);
  $('#restoreNo').addEventListener('click', closeModal);
  $('#restoreYes').addEventListener('click', async () => {
    try {
      await api(`/api/backups/${id}/restore`, { method: 'POST' });
      closeModal();
      render();
    } catch (e) { $('#restoreMsg').textContent = e.message; }
  });
}

// ---------------- تثبيت التطبيق (PWA) ----------------
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  $('#installBtn').classList.remove('hidden');
});
$('#installBtn').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $('#installBtn').classList.add('hidden');
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------------- التذكير بالذكر (إعداد شخصي على هذا الجهاز فقط — localStorage) ----------------
const DHIKR_KEY = 'pm_dhikr';
const DHIKR_CLIPS = {
  istighfar: { src: 'dhikr-istighfar.mp3', text: 'أستغفر الله' },
  salawat: { src: 'dhikr-salawat.mp3', text: 'اللهم صلِّ وسلِّم على نبينا محمد ﷺ' },
};
function dhikrPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(DHIKR_KEY) || '{}') || {}; } catch (_) { p = {}; }
  return {
    enabled: !!p.enabled,
    intervalMin: [15, 30, 60].includes(Number(p.intervalMin)) ? Number(p.intervalMin) : 30,
    mode: ['istighfar', 'salawat', 'alternate'].includes(p.mode) ? p.mode : 'alternate',
  };
}
function dhikrSavePrefs(p) { localStorage.setItem(DHIKR_KEY, JSON.stringify(p)); }
let dhikrAudio = null;       // عنصر صوت واحد مشترك لكل المقاطع
let dhikrTimer = null;
let dhikrAltNext = 'istighfar';
let dhikrInteracted = false; // لا تشغيل صوتي قبل أول تفاعل من المستخدم (سياسات المتصفح)
let dhikrToastTimer = null;
function dhikrKind(mode) {
  if (mode === 'istighfar' || mode === 'salawat') return mode;
  const k = dhikrAltNext;
  dhikrAltNext = k === 'istighfar' ? 'salawat' : 'istighfar';
  return k;
}
function showDhikrToast(text) {
  const el = $('#dhikrToast');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(dhikrToastTimer);
  dhikrToastTimer = setTimeout(() => el.classList.add('hidden'), 8000);
}
function dhikrPlay(kind) {
  const clip = DHIKR_CLIPS[kind] || DHIKR_CLIPS.istighfar;
  showDhikrToast(clip.text);
  try {
    if (!dhikrAudio) { dhikrAudio = new Audio(); dhikrAudio.volume = 0.7; dhikrAudio.preload = 'auto'; }
    if (!dhikrAudio.src || !dhikrAudio.src.endsWith(clip.src)) dhikrAudio.src = clip.src;
    dhikrAudio.currentTime = 0;
    const pr = dhikrAudio.play();
    if (pr && pr.catch) pr.catch(() => {}); // منع المتصفح التشغيل: نتجاهل بهدوء ونحاول في الموعد التالي
  } catch (_) { /* صامت — بلا أخطاء */ }
}
function dhikrStop() { if (dhikrTimer) { clearInterval(dhikrTimer); dhikrTimer = null; } }
function dhikrStart() {
  dhikrStop();
  const p = dhikrPrefs();
  if (!p.enabled) return;
  dhikrTimer = setInterval(() => {
    if (!token() || !dhikrInteracted) return; // يعمل فقط أثناء تسجيل الدخول وبعد أول تفاعل
    dhikrPlay(dhikrKind(dhikrPrefs().mode));
  }, p.intervalMin * 60 * 1000);
}
// أول تفاعل من المستخدم: يفتح باب التشغيل الصوتي ويشغّل المحرك إن كان مفعّلاً
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => {
  if (dhikrInteracted) return;
  dhikrInteracted = true;
  dhikrStart();
}, { passive: true }));
const dhikrToastEl = $('#dhikrToast');
if (dhikrToastEl) dhikrToastEl.addEventListener('click', () => dhikrToastEl.classList.add('hidden'));

// ---------------- ساعة الترويسة: التاريخ والوقت الآن (توقيت الرياض) ----------------
const fmtClockWeekday = new Intl.DateTimeFormat('ar-u-ca-gregory', { timeZone: RIYADH_TZ, weekday: 'long' });
const fmtClockHijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', { timeZone: RIYADH_TZ, day: 'numeric', month: 'long', year: 'numeric' });
const fmtClockTime = new Intl.DateTimeFormat('ar-u-ca-gregory', { timeZone: RIYADH_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
function tickHeaderClock() {
  const el = document.getElementById('headerClock');
  if (!el) return;
  const now = new Date();
  el.textContent = `${fmtClockWeekday.format(now)} ${fmtRiyadhDate.format(now)} م · ${fmtClockHijri.format(now)} · 🕐 ${fmtClockTime.format(now)}`;
}
let headerClockTimer = null;
function startHeaderClock() {
  tickHeaderClock();
  if (!headerClockTimer) headerClockTimer = setInterval(tickHeaderClock, 1000);
}

// ---------------- البدء ----------------
async function startApp() {
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  // جلسة قديمة بلا بيانات مستخدم محفوظة: اجلبها من الخادم (الدور من القاعدة)
  if (!ME && token()) {
    try { setME(await api('/api/me')); } catch (_) { /* api() يسجّل الخروج عند 401 */ }
  }
  applyRoleUI();
  dhikrStart();
  startHeaderClock();
  render();
}
if (token()) startApp();

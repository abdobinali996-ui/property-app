'use strict';
/* نظام إدارة الأملاك العقارية — واجهة التطبيق */

// ---------------- أدوات عامة ----------------
const $ = (sel) => document.querySelector(sel);
const main = () => $('#main');
const token = () => localStorage.getItem('pm_token') || '';
const money = (n) => `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ر.س`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

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

// ---------------- النافذة المنبثقة ----------------
function openModal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalBackdrop').classList.remove('hidden');
}
function closeModal() { $('#modalBackdrop').classList.add('hidden'); $('#modalBody').innerHTML = ''; }
$('#modalClose').addEventListener('click', closeModal);
$('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });

function formModal(title, fieldsHtml, onSubmit, submitLabel = 'حفظ') {
  openModal(title, `<form id="modalForm">${fieldsHtml}
    <div class="form-actions"><button type="submit" class="btn primary">${submitLabel}</button>
    <button type="button" class="btn" onclick="void(0)" id="modalCancel">إلغاء</button></div>
    <p class="error" id="formError"></p></form>`);
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try { await onSubmit(data); closeModal(); } catch (err) { $('#formError').textContent = err.message; }
  });
}

function confirmDelete(label, onYes) {
  openModal('تأكيد الحذف', `<p>هل أنت متأكد من حذف «${esc(label)}»؟ لا يمكن التراجع.</p>
    <div class="form-actions"><button class="btn danger" id="delYes">حذف نهائي</button>
    <button class="btn" id="delNo">إلغاء</button></div>`);
  $('#delNo').addEventListener('click', closeModal);
  $('#delYes').addEventListener('click', async () => { await onYes(); closeModal(); });
}

// ---------------- الدخول والخروج ----------------
function logout() {
  localStorage.removeItem('pm_token');
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
    localStorage.setItem('pm_token', out.token);
    startApp();
  } catch (err) { $('#loginError').textContent = err.message; }
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
async function render() {
  const views = { dashboard: viewDashboard, properties: viewProperties, units: viewUnits, tenants: viewTenants, contracts: viewContracts, payments: viewPayments, expenses: viewExpenses, statement: viewStatement, backup: viewBackup };
  main().innerHTML = '<p class="muted">جارٍ التحميل…</p>';
  try { await views[currentView](); } catch (e) { main().innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

// بيانات مشتركة
let CACHE = { properties: [], units: [], tenants: [], contracts: [] };
async function refreshCache() {
  const [properties, units, tenants, contracts] = await Promise.all([
    api('/api/properties'), api('/api/units'), api('/api/tenants'), api('/api/contracts-full'),
  ]);
  CACHE = { properties, units, tenants, contracts };
}
const propName = (id) => (CACHE.properties.find((p) => p.id === Number(id)) || {}).name || '';
const unitName = (id) => (CACHE.units.find((u) => u.id === Number(id)) || {}).name || '';
const tenantName = (id) => (CACHE.tenants.find((t) => t.id === Number(id)) || {}).name || '';
const CYCLE_LABELS = { monthly: 'شهري', quarterly: 'ربع سنوي', semiannual: 'نصف سنوي', annual: 'سنوي' };

// ---------------- لوحة المتابعة ----------------
async function viewDashboard() {
  await refreshCache();
  const d = await api('/api/dashboard');
  main().innerHTML = `
    <div class="cards">
      <div class="card good"><div class="lbl">المحصّل هذا الشهر</div><div class="num">${money(d.collected_this_month)}</div></div>
      <div class="card"><div class="lbl">المستحق هذا الشهر</div><div class="num">${money(d.due_this_month)}</div></div>
      <div class="card warn"><div class="lbl">إجمالي المتأخرات</div><div class="num">${money(d.total_arrears)}</div></div>
      <div class="card"><div class="lbl">عقارات / وحدات</div><div class="num">${d.counts.properties} / ${d.counts.units}</div></div>
      <div class="card"><div class="lbl">مستأجرون / عقود سارية</div><div class="num">${d.counts.tenants} / ${d.counts.active_contracts}</div></div>
    </div>

    <div class="section">
      <div class="section-head"><h3>🔍 بحث سريع عن مستأجر</h3></div>
      <div class="search-row"><input id="dashSearch" placeholder="اكتب الاسم أو رقم الجوال أو رقم الوحدة…"><button class="btn primary" id="dashSearchBtn">بحث</button></div>
      <div id="dashSearchResults"></div>
    </div>

    <div class="section">
      <div class="section-head"><h3>⚠️ قائمة المتأخرين</h3><button class="btn primary" onclick="paymentForm()">+ إضافة سند قبض</button></div>
      ${d.arrears_list.length ? `<div class="table-wrap"><table><tr><th>المستأجر</th><th>الوحدة</th><th>العقار</th><th>المتأخرات</th><th></th></tr>
        ${d.arrears_list.map((r) => `<tr><td>${esc(r.tenant_name)}</td><td>${esc(r.unit_name)}</td><td>${esc(r.property_name)}</td><td class="arrears">${money(r.arrears)}</td>
        <td><button class="btn small primary" onclick="paymentForm(${r.contract_id}, ${r.arrears})">تسجيل دفعة</button></td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد متأخرات — ممتاز 🎉</p>'}
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
    const results = await api(`/api/tenants-search?q=${encodeURIComponent(q)}`);
    $('#dashSearchResults').innerHTML = tenantResultCards(results);
  };
  $('#dashSearchBtn').addEventListener('click', runSearch);
  $('#dashSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
}

function tenantResultCards(results) {
  if (!results.length) return '<p class="muted">لا توجد نتائج.</p>';
  return results.map((t) => `
    <div class="card" style="margin-bottom:8px">
      <strong>${esc(t.name)}</strong> <span class="muted">${esc(t.phone || '')}</span>
      ${t.units && t.units.length ? `<span class="badge">${esc(t.units.join('، '))}</span>` : ''}
      <div style="margin-top:6px">إجمالي ما سدده: <span class="money">${money(t.total_paid)}</span> ·
      سندات: ${t.receipts_count} · المتأخرات: <span class="${t.arrears > 0 ? 'arrears' : ''}">${money(t.arrears)}</span></div>
      <div style="margin-top:8px"><button class="btn small primary" onclick="tenantProfile(${t.id})">فتح ملف المستأجر</button></div>
    </div>`).join('');
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
          <button class="btn small danger" onclick="del('properties', ${p.id}, '${esc(p.name)}')">حذف</button></td></tr>`).join('')}</table></div>`
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
          <td><button class="btn small" onclick="unitForm(${u.id})">تعديل</button>
          <button class="btn small danger" onclick="del('units', ${u.id}, '${esc(u.name)}')">حذف</button></td></tr>`).join('')}</table></div>`
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
      <div class="search-row"><input id="tenantSearch" placeholder="ابحث بالاسم أو رقم الجوال أو رقم الوحدة…"><button class="btn primary" id="tenantSearchBtn">بحث</button></div>
      <div id="tenantResults">${tenantResultCards(all)}</div>
      <div class="table-wrap"><table><tr><th>الاسم</th><th>الجوال</th><th>الهوية</th><th></th></tr>
      ${CACHE.tenants.map((t) => `<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(t.phone || '')}</td><td>${esc(t.id_number || '')}</td>
        <td><button class="btn small primary" onclick="tenantProfile(${t.id})">الملف</button>
        <button class="btn small" onclick="tenantForm(${t.id})">تعديل</button>
        <button class="btn small danger" onclick="del('tenants', ${t.id}, '${esc(t.name)}')">حذف</button></td></tr>`).join('')}</table></div>
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
    <p class="muted">الجوال: ${esc(p.tenant.phone || '—')} · الهوية: ${esc(p.tenant.id_number || '—')}</p>
    <h4>العقود</h4>
    ${p.contracts.length ? p.contracts.map((c) => `<div class="card" style="margin-bottom:6px">
      <strong>${esc(c.unit_name)}</strong> — ${esc(c.property_name)} · ${money(c.rent_amount)} (${esc(CYCLE_LABELS[c.cycle] || c.cycle)})<br>
      <span class="muted">من ${esc(c.start_date)} ${c.end_date ? 'إلى ' + esc(c.end_date) : ''}</span><br>
      المدفوع: ${money(c.total_paid)} · المستحق: ${money(c.total_due)} · المتأخرات: <span class="${c.arrears > 0 ? 'arrears' : ''}">${money(c.arrears)}</span>
      <div style="margin-top:6px"><button class="btn small primary" onclick="closeModal();paymentForm(${c.id})">+ سند قبض لهذا العقد</button></div></div>`).join('') : '<p class="muted">لا توجد عقود.</p>'}
    <h4>سجل الدفعات الكامل</h4>
    ${p.payments.length ? `<div class="table-wrap"><table><tr><th>السند</th><th>التاريخ</th><th>الوحدة</th><th>المبلغ</th><th>الطريقة</th><th></th></tr>
      ${p.payments.map((pay) => `<tr><td>${String(pay.receipt_no).padStart(4, '0')}</td><td>${esc(pay.payment_date)}</td><td>${esc(pay.unit_name)}</td><td class="money">${money(pay.amount)}</td><td>${esc(pay.method)}</td>
      <td><button class="btn small" onclick="showReceipt(${pay.id})">عرض السند</button></td></tr>`).join('')}</table></div>` : '<p class="muted">لا توجد دفعات مسجلة.</p>'}
  `);
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
          <td>${money(c.rent_amount)}<br><span class="muted">${esc(CYCLE_LABELS[c.cycle] || c.cycle)}</span></td>
          <td>${esc(c.start_date)}<br><span class="muted">${c.end_date ? 'إلى ' + esc(c.end_date) : 'مفتوح'}</span></td>
          <td class="money">${money(c.total_paid)}</td><td>${money(c.total_due)}</td>
          <td class="${c.arrears > 0 ? 'arrears' : ''}">${money(c.arrears)}</td>
          <td><span class="badge ${c.status === 'active' ? 'green' : 'gray'}">${c.status === 'active' ? 'سارٍ' : 'منتهٍ'}</span></td>
          <td><button class="btn small primary" onclick="paymentForm(${c.id})">+ سند</button>
          <button class="btn small" onclick="contractForm(${c.id})">تعديل</button>
          <button class="btn small danger" onclick="del('contracts', ${c.id}, 'عقد ${esc(c.tenant_name)}')">حذف</button></td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد عقود بعد.</p>'}
    </div>`;
}
function contractForm(id) {
  const c = id ? CACHE.contracts.find((x) => x.id === id) : {};
  formModal(id ? 'تعديل عقد' : 'إضافة عقد', `
    <label>الوحدة *<select name="unit_id" required>${CACHE.units.map((u) => `<option value="${u.id}" ${c.unit_id === u.id ? 'selected' : ''}>${esc(u.name)} — ${esc(propName(u.property_id))}</option>`).join('')}</select></label>
    <label>المستأجر *<select name="tenant_id" required>${CACHE.tenants.map((t) => `<option value="${t.id}" ${c.tenant_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <label>تاريخ البداية *<input name="start_date" type="date" required value="${esc(c.start_date || todayStr())}"></label>
    <label>تاريخ النهاية (اختياري)<input name="end_date" type="date" value="${esc(c.end_date || '')}"></label>
    <label>قيمة الإيجار للدورة (ر.س) *<input name="rent_amount" type="number" step="0.01" min="0" required value="${c.rent_amount ?? ''}"></label>
    <label>دورة السداد<select name="cycle">${Object.entries(CYCLE_LABELS).map(([v, l]) => `<option value="${v}" ${c.cycle === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>التأمين (ر.س)<input name="deposit" type="number" step="0.01" min="0" value="${c.deposit ?? 0}"></label>
    <label>الحالة<select name="status"><option value="active" ${c.status === 'active' ? 'selected' : ''}>سارٍ</option><option value="ended" ${c.status === 'ended' ? 'selected' : ''}>منتهٍ</option></select></label>
    <label>ملاحظات<textarea name="notes" rows="2">${esc(c.notes || '')}</textarea></label>`,
    async (data) => {
      data.unit_id = Number(data.unit_id); data.tenant_id = Number(data.tenant_id);
      data.rent_amount = Number(data.rent_amount); data.deposit = Number(data.deposit || 0);
      if (!data.end_date) data.end_date = null;
      id ? await api(`/api/contracts/${id}`, { method: 'PUT', body: JSON.stringify(data) }) : await api('/api/contracts', { method: 'POST', body: JSON.stringify(data) });
      render();
    });
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
    </div>`;
  const draw = (list) => {
    $('#payTable').innerHTML = list.length ? `<div class="table-wrap"><table><tr><th>رقم السند</th><th>التاريخ</th><th>المستأجر</th><th>الوحدة</th><th>المبلغ</th><th>الطريقة</th><th></th></tr>
      ${list.map((p) => { const c = contractById[p.contract_id] || {}; return `<tr><td><strong>${String(p.receipt_no).padStart(4, '0')}</strong></td><td>${esc(String(p.payment_date).slice(0, 10))}</td>
        <td>${esc(c.tenant_name || '')}</td><td>${esc(c.unit_name || '')}</td><td class="money">${money(p.amount)}</td><td>${esc(p.method)}</td>
        <td><button class="btn small" onclick="showReceipt(${p.id})">عرض/طباعة</button>
        <button class="btn small danger" onclick="del('payments', ${p.id}, 'سند ${String(p.receipt_no).padStart(4, '0')}')">حذف</button></td></tr>`; }).join('')}</table></div>`
      : '<p class="muted">لا توجد سندات مطابقة.</p>';
  };
  draw(sorted);
  $('#payFilter').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    draw(sorted.filter((p) => { const c = contractById[p.contract_id] || {}; return !q || `${c.tenant_name} ${c.unit_name} ${p.receipt_no}`.includes(q); }));
  });
}

async function paymentForm(contractId, presetAmount) {
  await refreshCache();
  const active = CACHE.contracts.filter((c) => c.status === 'active');
  if (!active.length) {
    openModal('إضافة سند قبض', '<p>لا يوجد عقد سارٍ بعد. خطوات البداية:</p><ol><li>أضف عقاراً من تبويب العقارات</li><li>أضف وحدة</li><li>أضف مستأجراً</li><li>أنشئ عقداً — وبعدها يصبح زر سند القبض جاهزاً</li></ol>');
    return;
  }
  const sel = contractId || active[0].id;
  const c0 = active.find((c) => c.id === sel);
  formModal('إضافة سند قبض', `
    <label>العقد (المستأجر — الوحدة) *<select name="contract_id" id="payContract">${active.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.tenant_name)} — ${esc(c.unit_name)} (${esc(c.property_name)})</option>`).join('')}</select></label>
    <div class="chips">
      <button type="button" class="chip" onclick="setPayAmount(${c0 ? c0.arrears : 0})">سداد المتأخرات: ${money(c0 ? c0.arrears : 0)}</button>
      <button type="button" class="chip" onclick="setPayAmount(${c0 ? c0.rent_amount : 0})">إيجار دورة: ${money(c0 ? c0.rent_amount : 0)}</button>
    </div>
    <label>المبلغ (ر.س) *<input name="amount" id="payAmount" type="number" step="0.01" min="0.01" required value="${presetAmount ?? ''}"></label>
    <label>تاريخ الدفع<input name="payment_date" type="date" value="${todayStr()}"></label>
    <label>طريقة الدفع<select name="method">${['تحويل', 'نقداً', 'شبكة', 'شيك'].map((m) => `<option>${m}</option>`).join('')}</select></label>
    <label>ملاحظات<input name="notes"></label>`,
    async (data) => {
      const payment = await api('/api/payments', { method: 'POST', body: JSON.stringify({ ...data, contract_id: Number(data.contract_id), amount: Number(data.amount) }) });
      render();
      setTimeout(() => showReceipt(payment.id, true), 80);
    }, 'حفظ وإصدار السند');
}
function setPayAmount(v) { const el = $('#payAmount'); if (el) el.value = v; }
$('#quickReceipt').addEventListener('click', () => paymentForm());

async function showReceipt(paymentId, justCreated = false) {
  const r = await api(`/api/payments/${paymentId}/receipt`);
  const p = r.payment;
  const s = r.summary || {};
  const html = `
    <div class="receipt-doc">
      <h2>سند قبض</h2>
      <div class="r-no">رقم السند: ${String(r.receipt_no).padStart(4, '0')} · التاريخ: ${esc(p.payment_date)}</div>
      <table>
        <tr><td>استلمنا من السيد/ة</td><td><strong>${esc(r.tenant ? r.tenant.name : '')}</strong></td></tr>
        <tr><td>رقم الجوال / الهوية</td><td>${esc(r.tenant ? (r.tenant.phone || '') : '')} ${r.tenant && r.tenant.id_number ? '· ' + esc(r.tenant.id_number) : ''}</td></tr>
        <tr><td>العقار / الوحدة</td><td>${esc(r.property ? r.property.name : '')} — ${esc(r.unit ? r.unit.name : '')}</td></tr>
        <tr><td>العقد</td><td>من ${esc(r.contract ? r.contract.start_date : '')} ${r.contract && r.contract.end_date ? 'إلى ' + esc(r.contract.end_date) : ''} · الإيجار ${money(r.contract ? r.contract.rent_amount : 0)} (${esc(s.cycle_label || '')})</td></tr>
        <tr><td>المبلغ المستلم</td><td><strong>${money(p.amount)}</strong></td></tr>
        <tr><td>طريقة الدفع</td><td>${esc(p.method)}</td></tr>
        ${p.notes ? `<tr><td>ملاحظات</td><td>${esc(p.notes)}</td></tr>` : ''}
        <tr><td>إجمالي المدفوع على العقد</td><td>${money(s.total_paid)}</td></tr>
        <tr><td>المتبقي المستحق (متأخرات)</td><td>${money(s.arrears)}</td></tr>
        ${s.remaining_on_contract !== null && s.remaining_on_contract !== undefined ? `<tr><td>المتبقي من كامل العقد</td><td>${money(s.remaining_on_contract)}</td></tr>` : ''}
      </table>
      <div class="amount-words">المبلغ بالحروف: ${esc(tafqeet(p.amount))}</div>
      <div class="signatures"><div>توقيع المستلم: ____________</div><div>توقيع المستأجر: ____________</div></div>
    </div>
    <div class="form-actions" style="margin-top:12px"><button class="btn primary" onclick="printReceipt()">🖨️ طباعة / حفظ PDF</button></div>`;
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
      ${sorted.length ? `<div class="table-wrap"><table><tr><th>التاريخ</th><th>العقار</th><th>الوحدة</th><th>التصنيف</th><th>الوصف</th><th>المبلغ</th><th></th></tr>
        ${sorted.map((e) => `<tr><td>${esc(String(e.expense_date).slice(0, 10))}</td><td>${esc(propName(e.property_id))}</td><td>${esc(e.unit_id ? unitName(e.unit_id) : '—')}</td>
          <td><span class="badge">${esc(e.category)}</span></td><td>${esc(e.description || '')}</td><td class="money">${money(e.amount)}</td>
          <td><button class="btn small" onclick="expenseForm(${e.id})">تعديل</button>
          <button class="btn small danger" onclick="del('expenses', ${e.id}, 'مصروف ${esc(e.category)}')">حذف</button></td></tr>`).join('')}</table></div>
        <p>إجمالي المصروفات: <strong>${money(sorted.reduce((s, e) => s + Number(e.amount || 0), 0))}</strong></p>`
      : '<p class="muted">لا توجد مصروفات بعد.</p>'}
    </div>`;
}
function expenseForm(id) {
  let e = {};
  if (id) { /* تُجلب من القائمة عند الحاجة */ }
  const cats = ['صيانة', 'مرافق', 'عمولات', 'نظافة', 'حراسة', 'أخرى'];
  formModal(id ? 'تعديل مصروف' : 'إضافة مصروف', `
    <label>العقار *<select name="property_id" id="expProperty">${CACHE.properties.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
    <label>الوحدة (اختياري)<select name="unit_id" id="expUnit"><option value="">— كل العقار —</option></select></label>
    <label>التصنيف<select name="category">${cats.map((c) => `<option>${c}</option>`).join('')}</select></label>
    <label>المبلغ (ر.س) *<input name="amount" type="number" step="0.01" min="0.01" required></label>
    <label>التاريخ<input name="expense_date" type="date" value="${todayStr()}"></label>
    <label>الوصف<input name="description"></label>`,
    async (data) => {
      data.property_id = Number(data.property_id); data.amount = Number(data.amount);
      data.unit_id = data.unit_id ? Number(data.unit_id) : null;
      id ? await api(`/api/expenses/${id}`, { method: 'PUT', body: JSON.stringify(data) }) : await api('/api/expenses', { method: 'POST', body: JSON.stringify(data) });
      render();
    });
  const fillUnits = () => {
    const pid = Number($('#expProperty').value);
    $('#expUnit').innerHTML = '<option value="">— كل العقار —</option>' + CACHE.units.filter((u) => u.property_id === pid).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  };
  $('#expProperty').addEventListener('change', fillUnits);
  fillUnits();
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
      <h3 style="text-align:center">الصافي المستحق للمالك: ${money(s.net)}</h3>
    </div>`;
  $('#stmtResult').innerHTML = doc + `<div class="form-actions"><button class="btn primary" onclick="printStatement()">🖨️ طباعة / حفظ PDF</button></div>`;
  $('#printArea').innerHTML = doc;
}
function printStatement() { window.print(); }

// ---------------- التصدير والنسخ الاحتياطي ----------------
async function viewBackup() {
  main().innerHTML = `
    <div class="section">
      <h3>تصدير الجداول (CSV — يفتح في Excel)</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${[['properties', 'العقارات'], ['units', 'الوحدات'], ['tenants', 'المستأجرون'], ['contracts-full', 'العقود مع الملخصات'], ['payments', 'الدفعات والسندات'], ['expenses', 'المصروفات']]
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
    </div>`;
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

// ---------------- البدء ----------------
function startApp() {
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  render();
}
if (token()) startApp();

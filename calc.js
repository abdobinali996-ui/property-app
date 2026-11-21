'use strict';
// منطق حساب المستحقات والمتأخرات — مشترك بين كل أجزاء الخادم

const CYCLE_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const CYCLE_LABELS = { monthly: 'شهري', quarterly: 'ربع سنوي', semiannual: 'نصف سنوي', annual: 'سنوي' };

function toDate(d) {
  if (!d) return null;
  if (d instanceof Date) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, day || 1);
}

function fmtDate(d) {
  const x = toDate(d);
  if (!x) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function addMonths(date, n) {
  const d = toDate(date);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

function today() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

// تواريخ بداية فترات الاستحقاق من بداية العقد حتى نهاية الحد المعطى
function periodStarts(contract, until) {
  const starts = [];
  const start = toDate(contract.start_date);
  if (!start) return starts;
  const step = CYCLE_MONTHS[contract.cycle] || 1;
  const endLimit = contract.end_date ? toDate(contract.end_date) : null;
  let limit = toDate(until) || today();
  if (endLimit && endLimit < limit) limit = endLimit;
  let cur = start;
  let guard = 0;
  while (cur <= limit && guard < 1200) {
    starts.push(new Date(cur));
    cur = addMonths(cur, step);
    guard++;
  }
  return starts;
}

// ملخص عقد: إجمالي المستحق حتى اليوم، المدفوع، المتأخرات، المتبقي من العقد
function contractSummary(contract, payments, asOf) {
  const at = asOf ? toDate(asOf) : today();
  const rent = Number(contract.rent_amount) || 0;
  const duePeriods = contract.status === 'ended' && !contract.end_date
    ? periodStarts(contract, at)
    : periodStarts(contract, at);
  const totalDue = duePeriods.length * rent;
  const totalPaid = (payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const arrears = Math.max(0, Math.round((totalDue - totalPaid) * 100) / 100);

  // إجمالي قيمة العقد كاملة (من البداية لنهاية العقد إن وُجد تاريخ نهاية)
  let fullTotal = null;
  if (contract.end_date) {
    fullTotal = periodStarts(contract, toDate(contract.end_date)).length * rent;
  }
  return {
    rent_amount: rent,
    cycle: contract.cycle,
    cycle_label: CYCLE_LABELS[contract.cycle] || contract.cycle,
    due_periods: duePeriods.length,
    total_due: totalDue,
    total_paid: totalPaid,
    arrears,
    contract_total: fullTotal,
    remaining_on_contract: fullTotal === null ? null : Math.max(0, Math.round((fullTotal - totalPaid) * 100) / 100),
    next_due_date: (() => {
      const step = CYCLE_MONTHS[contract.cycle] || 1;
      const start = toDate(contract.start_date);
      if (!start) return null;
      let cur = start;
      let guard = 0;
      while (cur <= at && guard < 1200) { cur = addMonths(cur, step); guard++; }
      if (contract.end_date && cur > toDate(contract.end_date)) return null;
      return fmtDate(cur);
    })(),
  };
}

// معلومات القسط لدفعة معيّنة: ترتيبها بين دفعات العقد (حسب رقم السند)،
// وإجمالي عدد أقساط العقد إن كان له تاريخ نهاية (وإلا null)
function installmentInfo(contract, payments, paymentId) {
  const sorted = [...(payments || [])].sort((a, b) =>
    ((a.receipt_no || 0) - (b.receipt_no || 0)) || ((a.id || 0) - (b.id || 0)));
  const idx = sorted.findIndex((p) => Number(p.id) === Number(paymentId));
  const index = idx >= 0 ? idx + 1 : sorted.length;
  let total = null;
  if (contract && contract.end_date) {
    const n = periodStarts(contract, toDate(contract.end_date)).length;
    total = n > 0 ? n : null;
  }
  return { installment_index: index, installment_total: total };
}

// المستحق خلال شهر معيّن (فترات تبدأ داخل ذلك الشهر)
function dueInMonth(contract, year, month) {
  const rent = Number(contract.rent_amount) || 0;
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const starts = periodStarts(contract, last);
  const inMonth = starts.filter((s) => s >= first && s <= last);
  return inMonth.length * rent;
}

module.exports = { CYCLE_MONTHS, CYCLE_LABELS, toDate, fmtDate, addMonths, today, periodStarts, contractSummary, dueInMonth, installmentInfo };

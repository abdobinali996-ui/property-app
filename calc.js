'use strict';
// منطق حساب المستحقات والمتأخرات — مشترك بين كل أجزاء الخادم
// ملاحظة: rent_amount في العقد = إجمالي إيجار العقد لكامل مدته،
// وقيمة كل قسط = الإجمالي ÷ عدد الدفعات (الدفعة الأخيرة تمتص فرق التقريب).

const CYCLE_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const CYCLE_LABELS = { monthly: 'شهري', quarterly: 'ربع سنوي', semiannual: 'نصف سنوي', annual: 'سنوي' };
// عدد الدفعات الافتراضي في السنة لكل دورة — للعقود المفتوحة بلا عدد دفعات محدد
const CYCLE_YEAR_COUNT = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 };

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

function addDays(date, n) {
  const d = toDate(date);
  d.setDate(d.getDate() + n);
  return d;
}

function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

// أغراض الدفعات (مقابل سند القبض): «إيجار» هو الافتراضي — والدفعات القديمة
// بلا غرض تُعامل كإيجار. قاعدة محاسبية: دفعات الإيجار فقط تُحتسب في موقف
// الإيجار (الأقساط والمستحق والمتأخرات والمتبقي)، أما باقي الأغراض فهي
// تحصيلات دخل لا تُنقص متأخرات الإيجار.
const PAYMENT_PURPOSES = ['إيجار', 'خدمات', 'مياه', 'كهرباء', 'أخرى'];
// غرض «خدمات» يمثّل مال المكتب نفسه (عمولته): يُستبعد كلياً من كشف حساب
// المالك، ويبقى داخلاً في ملخص المكتب الشهري وفي تقرير السندات.
const OFFICE_PURPOSE = 'خدمات';
function paymentPurpose(p) {
  const v = p && p.purpose;
  return PAYMENT_PURPOSES.includes(v) ? v : 'إيجار';
}
function isRentPayment(p) { return paymentPurpose(p) === 'إيجار'; }
function isOfficePayment(p) { return paymentPurpose(p) === OFFICE_PURPOSE; }

// تطبيع اسم المالك للمقارنة والتجميع: قصّ الطرفين + دمج المسافات الداخلية
// + تجاهل حالة الأحرف اللاتينية. الاسم الفارغ بعد التطبيع = '' (لا يُحتسب).
function normalizeOwnerName(name) {
  return String(name == null ? '' : name).trim().replace(/\s+/g, ' ').toLowerCase();
}
function rentPayments(payments) { return (payments || []).filter(isRentPayment); }
function sumAmounts(list) { return (list || []).reduce((s, p) => s + (Number(p.amount) || 0), 0); }

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

// عدد دفعات العقد: القيمة المحفوظة صراحة (installments_count) إن وُجدت،
// وإلا من تاريخي البداية والنهاية، وإلا الافتراضي السنوي للدورة
function installmentsCount(contract) {
  const stored = Number(contract && contract.installments_count);
  if (Number.isFinite(stored) && stored > 0) return Math.floor(stored);
  if (contract && contract.end_date) {
    const n = periodStarts(contract, toDate(contract.end_date)).length;
    if (n > 0) return n;
  }
  return CYCLE_YEAR_COUNT[contract && contract.cycle] || 12;
}

// مبالغ الأقساط: قسمة إجمالي الإيجار بالتساوي مع امتصاص الدفعة الأخيرة لفرق
// التقريب، بحيث يكون مجموع المبالغ مساوياً للإجمالي تماماً
function installmentAmounts(contract) {
  const total = Number(contract.rent_amount) || 0;
  const n = installmentsCount(contract);
  const base = round2(total / n);
  const amounts = [];
  for (let i = 0; i < n - 1; i++) amounts.push(base);
  amounts.push(round2(total - base * (n - 1)));
  return amounts;
}

// ملخص عقد: إجمالي المستحق حتى اليوم، المدفوع، المتأخرات، المتبقي من العقد
function contractSummary(contract, payments, asOf) {
  const at = asOf ? toDate(asOf) : today();
  const total = Number(contract.rent_amount) || 0;
  const amounts = installmentAmounts(contract);
  const n = amounts.length;
  const startedCount = periodStarts(contract, at).length;
  const dueCount = Math.min(startedCount, n);
  const totalDue = round2(amounts.slice(0, dueCount).reduce((s, a) => s + a, 0));
  // المدفوع لأغراض الإيجار فقط هو ما يغطي الأقساط؛ المدفوعات الأخرى تُرصد
  // منفصلة (other_paid) ولا تُنقص المستحق ولا المتأخرات ولا المتبقي
  const totalPaid = round2(sumAmounts(rentPayments(payments)));
  const otherPaid = round2(sumAmounts((payments || []).filter((p) => !isRentPayment(p))));
  const arrears = Math.max(0, round2(totalDue - totalPaid));

  return {
    rent_amount: total,
    cycle: contract.cycle,
    cycle_label: CYCLE_LABELS[contract.cycle] || contract.cycle,
    due_periods: dueCount,
    total_due: totalDue,
    total_paid: totalPaid,
    other_paid: otherPaid,
    arrears,
    contract_total: total,
    remaining_on_contract: Math.max(0, round2(total - totalPaid)),
    installments_total: n,
    installment_amount: amounts[0],
    installment_amounts: amounts,
    next_due_date: (() => {
      const start = toDate(contract.start_date);
      if (!start) return null;
      if (dueCount >= n) return null;
      const step = CYCLE_MONTHS[contract.cycle] || 1;
      const next = addMonths(start, dueCount * step);
      if (contract.end_date && next > toDate(contract.end_date)) return null;
      return fmtDate(next);
    })(),
  };
}

// معلومات القسط لدفعة معيّنة: إن حدّد المستخدم رقم القسط صراحةً
// (installment_no) فهو المعتمد، وإلا فترتيبها بين دفعات إيجار العقد فقط
// (حسب رقم السند)، وإجمالي عدد أقساط العقد، وقيمة القسط المقابل.
// دفعة غير إيجارية لا قسط لها: تعيد فهارس خالية (null).
function installmentInfo(contract, payments, paymentId) {
  const amounts = contract ? installmentAmounts(contract) : [];
  const target = (payments || []).find((p) => Number(p.id) === Number(paymentId));
  if (target && !isRentPayment(target)) {
    return { installment_index: null, installment_total: amounts.length || null, installment_amount: null };
  }
  const assigned = target ? Number(target.installment_no) : NaN;
  if (Number.isFinite(assigned) && assigned >= 1 && assigned <= amounts.length) {
    return {
      installment_index: assigned,
      installment_total: amounts.length || null,
      installment_amount: amounts[assigned - 1],
    };
  }
  const sorted = rentPayments(payments).sort((a, b) =>
    ((a.receipt_no || 0) - (b.receipt_no || 0)) || ((a.id || 0) - (b.id || 0)));
  const idx = sorted.findIndex((p) => Number(p.id) === Number(paymentId));
  const index = idx >= 0 ? idx + 1 : sorted.length;
  return {
    installment_index: index,
    installment_total: amounts.length || null,
    installment_amount: index >= 1 && index <= amounts.length ? amounts[index - 1] : null,
  };
}

// الفترة الافتراضية التي يغطيها سند قبض: فترة القسط الذي تقع فيه الدفعة
// (حسب تاريخ الدفع) — من بداية فترة ذلك القسط إلى نهاية فترته
// (بداية الفترة التالية − يوم)، وبحد أقصى تاريخ نهاية العقد.
// تُحسب دائماً بالميلادي (ISO) لأن التخزين القياسي ميلادي.
function paymentPeriod(contract, payment) {
  if (!contract || !contract.start_date) return null;
  const start = toDate(contract.start_date);
  if (!start) return null;
  const step = CYCLE_MONTHS[contract.cycle] || 1;
  const n = installmentsCount(contract);
  const payDate = payment && payment.payment_date ? toDate(payment.payment_date) : today();
  const untilLimit = contract.end_date ? toDate(contract.end_date) : addMonths(payDate, step);
  let starts = periodStarts(contract, untilLimit);
  if (!starts.length) starts = [start];
  let idx = 0;
  starts.forEach((s, i) => { if (s <= payDate) idx = i; });
  if (idx > n - 1) idx = n - 1;
  const from = starts[Math.min(idx, starts.length - 1)];
  let to = addDays(addMonths(from, step), -1);
  if (contract.end_date) {
    const e = toDate(contract.end_date);
    if (to > e) to = e;
  }
  return { period_from: fmtDate(from), period_to: fmtDate(to) };
}

// جدول الأقساط الكامل للعقد: رقم القسط وتاريخ استحقاقه ومبلغه،
// بترتيب زمني (تاريخ القسط = بداية العقد + ترتيبه × أشهر الدورة)
function installmentSchedule(contract) {
  const amounts = installmentAmounts(contract);
  const start = toDate(contract && contract.start_date);
  if (!start) return [];
  const step = CYCLE_MONTHS[contract.cycle] || 1;
  return amounts.map((amount, i) => ({
    index: i + 1,
    due_date: fmtDate(addMonths(start, i * step)),
    amount,
  }));
}

// تغطية الأقساط دفعةً دفعة: كل دفعة إيجار تغطي قسطها المحدد صراحةً
// (installment_no) أولاً وما زاد ينساب للأقساط التالية بالترتيب، والدفعة
// بلا تحديد تغطي أقدم قسط غير مكتمل ثم ما بعده (السلوك الأصلي بالضبط).
// يعيد جدول الأقساط مضافاً إليه covered وremaining لكل قسط.
function installmentCoverage(contract, payments) {
  const schedule = installmentSchedule(contract);
  const covered = schedule.map(() => 0);
  const sorted = rentPayments(payments).slice().sort((a, b) =>
    ((a.receipt_no || 0) - (b.receipt_no || 0)) || ((a.id || 0) - (b.id || 0)));
  for (const p of sorted) {
    let left = Number(p.amount) || 0;
    if (!(left > 0)) continue;
    const assigned = Number(p.installment_no);
    let start;
    if (Number.isFinite(assigned) && assigned >= 1 && assigned <= schedule.length) {
      start = assigned - 1;
    } else {
      start = covered.findIndex((c, i) => c < schedule[i].amount - 1e-9);
      if (start < 0) start = schedule.length;
    }
    for (let i = start; i < schedule.length && left > 1e-9; i++) {
      const room = round2(schedule[i].amount - covered[i]);
      if (room <= 0) continue;
      const take = Math.min(room, left);
      covered[i] = round2(covered[i] + take);
      left = round2(left - take);
    }
  }
  return schedule.map((s, i) => ({ ...s, covered: covered[i], remaining: round2(s.amount - covered[i]) }));
}

// القسط التالي غير المسدد: أول قسط غير مغطّى بالكامل حسب تغطية الدفعات.
// يعيد null إن كان العقد مسدداً بالكامل.
// remaining = الجزء غير المغطى من ذلك القسط حتى الآن
function nextUnpaidInstallment(contract, payments) {
  const cov = installmentCoverage(contract, payments);
  for (const e of cov) {
    if (e.remaining > 0) return { ...e, paid_towards: e.covered };
  }
  return null;
}

// فترة قسط بعينه (لبدء فترة السداد الافتراضية عند تحديد رقم القسط):
// من تاريخ استحقاقه إلى بداية القسط التالي − يوم، وبحد أقصى نهاية العقد
function installmentPeriod(contract, k) {
  const schedule = installmentSchedule(contract);
  const e = schedule[k - 1];
  if (!e) return null;
  const step = CYCLE_MONTHS[contract.cycle] || 1;
  const from = toDate(e.due_date);
  let to = addDays(addMonths(from, step), -1);
  if (contract.end_date) {
    const en = toDate(contract.end_date);
    if (to > en) to = en;
  }
  return { period_from: fmtDate(from), period_to: fmtDate(to) };
}

// موقف القسط الحالي (أول قسط غير مغطّى بالكامل): باقيه وتصنيفه حسب تاريخ
// استحقاقه — «متأخر» إن بدأت فترته وبقي منه شيء، و«باقي» إن لم يحل موعده
// بعد، ويشمل ذلك المسدد مقدماً (دفعة قبل الاستحقاق تغطي جزءاً من القسط
// فيبقى باقيه «باقي» لا «متأخر»). يعيد null عند سداد العقد بالكامل.
function installmentBalance(contract, payments) {
  const next = nextUnpaidInstallment(contract, payments);
  if (!next) return null;
  return {
    index: next.index,
    total: installmentsCount(contract),
    amount: next.amount,
    remaining: next.remaining,
    paid_towards: next.paid_towards,
    due_date: next.due_date,
    status: next.due_date <= fmtDate(today()) ? 'متأخر' : 'باقي',
  };
}

// باقي القسط كما يظهر على سند قبض بعينه: إن كانت الدفعة محددةً لقسط
// وبقي من ذلك القسط شيء بعد كل الدفعات، فهو المعروض؛ وإلا فباقي أول قسط
// غير مغطّى (installmentBalance). يعيد null عند سداد العقد بالكامل.
function installmentBalanceForPayment(contract, payments, payment) {
  const assigned = payment ? Number(payment.installment_no) : NaN;
  if (Number.isFinite(assigned) && assigned >= 1) {
    const cov = installmentCoverage(contract, payments);
    const e = cov[assigned - 1];
    if (e && e.remaining > 0) {
      return {
        index: e.index,
        total: cov.length,
        amount: e.amount,
        remaining: e.remaining,
        paid_towards: e.covered,
        due_date: e.due_date,
        status: e.due_date <= fmtDate(today()) ? 'متأخر' : 'باقي',
      };
    }
  }
  return installmentBalance(contract, payments);
}

// المستحق خلال شهر معيّن (أقساط تبدأ فترتها داخل ذلك الشهر، بمبالغها الفردية)
function dueInMonth(contract, year, month) {
  const amounts = installmentAmounts(contract);
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const starts = periodStarts(contract, last);
  let sum = 0;
  starts.forEach((s, i) => {
    if (s >= first && s <= last && i < amounts.length) sum += amounts[i];
  });
  return round2(sum);
}

module.exports = {
  CYCLE_MONTHS, CYCLE_LABELS, CYCLE_YEAR_COUNT, PAYMENT_PURPOSES,
  toDate, fmtDate, addMonths, addDays, today, round2,
  periodStarts, installmentsCount, installmentAmounts,
  contractSummary, dueInMonth, installmentInfo, paymentPeriod,
  installmentSchedule, nextUnpaidInstallment, installmentBalance,
  installmentCoverage, installmentBalanceForPayment, installmentPeriod,
  paymentPurpose, isRentPayment, isOfficePayment, rentPayments, OFFICE_PURPOSE,
  normalizeOwnerName,
};

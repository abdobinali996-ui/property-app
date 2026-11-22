'use strict';
// رفع النسخ الاحتياطية إلى Google Drive عبر حساب خدمة (Service Account).
// بلا أي مكتبات خارجية: JWT بتوقيع RS256 عبر crypto المدمج، وطلبات HTTP عبر fetch.
// كل الإعدادات من متغيرات البيئة وكلها اختيارية — عند غيابها تُعطَّل الميزة بصمت
// وتعمل اللقطات كما هي تماماً داخل قاعدة البيانات فقط.
//
// المتغيرات:
//   GOOGLE_DRIVE_FOLDER_ID      — معرّف مجلد Drive الهدف (مطلوب في الحالتين)
//   الطريقة أ (المستخدم نفسه — لحسابات Gmail الشخصية):
//   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
//   الطريقة ب (حساب خدمة — لـGoogle Workspace / الدرايفات المشتركة فقط؛ حسابات
//   Gmail الشخصية ترفضها جوجل بخطأ «Service Accounts do not have storage quota»):
//   GOOGLE_SERVICE_ACCOUNT_JSON — محتوى ملف مفتاح حساب الخدمة (JSON) كنص واحد
//   GOOGLE_OAUTH_TOKEN_URL      — (اختياري، للاختبارات) بديل لنقطة تبادل الرمز
//   GOOGLE_DRIVE_API_BASE       — (اختياري، للاختبارات) بديل لقاعدة Drive API
const crypto = require('crypto');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_API_BASE = 'https://www.googleapis.com';
const KEEP_ON_DRIVE = 1; // الاحتفاظ بأحدث نسخة واحدة فقط على Drive
const FETCH_TIMEOUT_MS = 30000;

function tokenUrl() {
  return process.env.GOOGLE_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL;
}
function apiBase() {
  return String(process.env.GOOGLE_DRIVE_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
}

// مصادقة المستخدم نفسه (OAuth برمز تحديث) — تُفضَّل عند وجودها
function oauthConfigured() {
  return !!(String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim()
    && String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim()
    && String(process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '').trim());
}

// الميزة مفعّلة عند وجود معرّف المجلد مع أيٍّ من طريقتي المصادقة كاملةً
function configured() {
  if (!String(process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim()) return false;
  return oauthConfigured()
    || !!String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
}

function serviceAccount() {
  let sa;
  try {
    sa = JSON.parse(String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ''));
  } catch (_) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON ليس JSON صالحاً');
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('مفتاح حساب الخدمة ناقص (client_email / private_key)');
  }
  return sa;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// بناء JWT موقّع RS256 لحساب الخدمة (يُصدَّر للاختبار أيضاً)
function buildJwt(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: clientEmail,
    scope: DRIVE_SCOPE,
    aud: tokenUrl(),
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

// تبادل الـJWT برمز وصول — يُخزَّن الرمز حتى قرب انتهائه
let tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (oauthConfigured()) {
    // تبادل رمز التحديث برمز وصول باسم المستخدم نفسه
    const res = await fetchWithTimeout(tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: String(process.env.GOOGLE_OAUTH_CLIENT_ID).trim(),
        client_secret: String(process.env.GOOGLE_OAUTH_CLIENT_SECRET).trim(),
        refresh_token: String(process.env.GOOGLE_OAUTH_REFRESH_TOKEN).trim(),
      }).toString(),
    });
    if (!res.ok) throw new Error(`فشل تجديد رمز Drive (${res.status})${await shortBody(res)}`);
    const json = await res.json();
    if (!json.access_token) throw new Error('استجابة رمز Drive بلا access_token');
    const ttlMs = Math.max(60, Number(json.expires_in || 3600) - 60) * 1000;
    tokenCache = { token: json.access_token, expiresAt: Date.now() + ttlMs };
    return tokenCache.token;
  }
  const sa = serviceAccount();
  const jwt = buildJwt(sa.client_email, sa.private_key);
  const res = await fetchWithTimeout(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) throw new Error(`فشل الحصول على رمز Drive (${res.status})${await shortBody(res)}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('استجابة رمز Drive بلا access_token');
  const ttlMs = Math.max(60, Number(json.expires_in || 3600) - 60) * 1000;
  tokenCache = { token: json.access_token, expiresAt: Date.now() + ttlMs };
  return tokenCache.token;
}

async function fetchWithTimeout(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function shortBody(res) {
  try {
    const text = await res.text();
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return t ? `: ${t}` : '';
  } catch (_) { return ''; }
}

// اسم الملف بتوقيت الرياض: property-backup-YYYYMMDD-HHmmss.json
function backupFilename(when) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(when instanceof Date ? when : new Date(when || Date.now()));
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return `property-backup-${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}.json`;
}

// قاعدة الاحتفاظ على Drive: أحدث ملف نسخة واحد فقط (الذي رُفع للتو) —
// تُحذف كل ملفات النسخ الأقدم. أي فشل هنا يُتجاهل بصمت
async function pruneDrive(token, folderId) {
  try {
    const files = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and name contains 'property-backup-' and trashed = false`,
        fields: 'files(id,name,createdTime),nextPageToken',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetchWithTimeout(`${apiBase()}/drive/v3/files?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const json = await res.json();
      for (const f of json.files || []) files.push(f);
      pageToken = json.nextPageToken || '';
    } while (pageToken);
    // الأحدث أولاً حسب وقت الإنشاء (وعند التساوي حسب الاسم — فالأسماء مرتّبة زمنياً)
    files.sort((a, b) => String(b.createdTime || '').localeCompare(String(a.createdTime || ''))
      || String(b.name || '').localeCompare(String(a.name || '')));
    for (const f of files.slice(KEEP_ON_DRIVE)) {
      try {
        await fetchWithTimeout(`${apiBase()}/drive/v3/files/${encodeURIComponent(f.id)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (_) { /* حذف ملف واحد فشل — نتابع الباقي */ }
    }
  } catch (_) { /* الاحتفاظ جهد أفضل فقط */ }
}

// رفع حمولة لقطة واحدة إلى مجلد Drive. يرمي خطأً قصيراً عند الفشل —
// المتصل (الخادم) يبتلع الخطأ ويكتفي بتسجيل الحالة على اللقطة.
async function uploadSnapshot(payload, when) {
  if (!configured()) throw new Error('رفع Drive غير مفعّل');
  const folderId = String(process.env.GOOGLE_DRIVE_FOLDER_ID).trim();
  const token = await getAccessToken();
  const name = backupFilename(when);
  const content = JSON.stringify(payload, null, 1);
  const boundary = `pm-backup-${crypto.randomBytes(8).toString('hex')}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
    + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetchWithTimeout(`${apiBase()}/upload/drive/v3/files?uploadType=multipart`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`فشل رفع النسخة إلى Drive (${res.status})${await shortBody(res)}`);
  let created = null;
  try { created = await res.json(); } catch (_) { /* بعض الخوادم ترد بلا جسم */ }
  await pruneDrive(token, folderId);
  return { id: created && created.id, name };
}

function _resetTokenCache() { tokenCache = { token: null, expiresAt: 0 }; }

module.exports = { configured, uploadSnapshot, buildJwt, backupFilename, _resetTokenCache, KEEP_ON_DRIVE };

// /api/auth.js
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function envOk() { return SUPABASE_URL && SERVICE_ROLE_KEY && SESSION_SECRET; }

async function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function createToken(payload) {
  const full = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const body = base64url(JSON.stringify(full));
  const sig = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  let payload;
  try { payload = JSON.parse(base64urlDecode(body)); } catch { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}
function extractBearer(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (!auth || typeof auth !== 'string') return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
async function sb(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.method === 'PATCH' || options.method === 'POST' ? 'return=representation' : '',
      ...options.headers,
    },
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Supabase ${res.status}: ${text}`); }
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}
function bad(res, status, message) { return res.status(status).json({ error: message }); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');
  if (!envOk()) { console.error('Missing env vars'); return bad(res, 500, 'サーバー設定エラー'); }
  const body = req.body || {};
  const action = body.action;
  try {
    if (action === 'staff-login') return await staffLogin(req, res, body);
    if (action === 'admin-login') return await adminLogin(req, res, body);
    if (action === 'change-password') return await changePassword(req, res, body);
    return bad(res, 400, '不明なアクション');
  } catch (e) {
    console.error('auth error:', e);
    return bad(res, 500, '内部エラー');
  }
}

async function staffLogin(req, res, body) {
  const { deptId, staffCode, password } = body;
  if (deptId === undefined || deptId === null || !staffCode || !password) return bad(res, 400, '入力が不足しています');
  const hash = await sha256(password);
  const deptIdNum = parseInt(deptId);
  const codeNum = parseInt(staffCode);
  const accounts = await sb(`accounts?staff_code=eq.${codeNum}&dept_id=eq.${deptIdNum}&password_hash=eq.${hash}&role=eq.staff&select=id,name,dept_id,staff_id,staff_code,role`);
  if (!accounts || accounts.length === 0) return bad(res, 401, 'パスワードが正しくありません');
  const a = accounts[0];
  if (a.staff_id == null || a.staff_code == null) return bad(res, 500, 'アカウント設定が不完全です。管理者に連絡してください');
  const token = createToken({ accountId: a.id, role: a.role, deptId: a.dept_id });
  return res.status(200).json({ token, user: { id: a.staff_id, accountId: a.id, staffCode: a.staff_code, name: a.name, deptId: a.dept_id, role: a.role } });
}

async function adminLogin(req, res, body) {
  const { email, password } = body;
  if (!email || !password) return bad(res, 400, '入力が不足しています');
  const hash = await sha256(password);
  const accounts = await sb(`accounts?email=eq.${encodeURIComponent(email.toLowerCase())}&password_hash=eq.${hash}&select=id,name,email,role,dept_id`);
  if (!accounts || accounts.length === 0) return bad(res, 401, 'メールアドレスまたはパスワードが正しくありません');
  const a = accounts[0];
  if (a.role !== 'master' && a.role !== 'leader') return bad(res, 403, '管理者権限がありません');
  const token = createToken({ accountId: a.id, role: a.role, deptId: a.dept_id });
  return res.status(200).json({ token, user: { id: a.id, name: a.name, email: a.email, role: a.role, deptId: a.dept_id } });
}

async function changePassword(req, res, body) {
  const token = extractBearer(req);
  const payload = verifyToken(token);
  if (!payload) return bad(res, 401, 'セッションが無効です。再ログインしてください');
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) return bad(res, 400, '入力が不足しています');
  if (newPassword.length < 8) return bad(res, 400, 'パスワードは8文字以上にしてください');
  const currentHash = await sha256(currentPassword);
  const check = await sb(`accounts?id=eq.${payload.accountId}&password_hash=eq.${currentHash}&select=id`);
  if (!check || check.length === 0) return bad(res, 401, '現在のパスワードが正しくありません');
  const newHash = await sha256(newPassword);
  await sb(`accounts?id=eq.${payload.accountId}`, { method: 'PATCH', body: JSON.stringify({ password_hash: newHash }) });
  return res.status(200).json({ ok: true });
}

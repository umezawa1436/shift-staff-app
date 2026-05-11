// /api/admin-accounts.js
// kingyo-shift 管理者用 accounts CRUD API
// すべて要 admin token（role=master or leader）
//
// ハンドルする action:
//   - list                 : アカウント一覧取得（master/leader）
//   - create               : 単発アカウント追加（master）
//   - update               : アカウント編集（master）
//   - delete               : アカウント削除（master）
//   - create-for-new-staff : 新規スタッフのアカウント作成（master/leader、staff_id/staff_code必須）

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;

function envOk() { return SUPABASE_URL && SERVICE_ROLE_KEY && SESSION_SECRET; }

async function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

function bad(res, status, message) {
  return res.status(status).json({ error: message });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');
  if (!envOk()) return bad(res, 500, 'サーバー設定エラー');

  // 認証
  const token = extractBearer(req);
  const payload = verifyToken(token);
  if (!payload) return bad(res, 401, 'セッションが無効です');
  const isMaster = payload.role === 'master';
  const isLeader = payload.role === 'leader';
  if (!isMaster && !isLeader) return bad(res, 403, '権限がありません');

  const body = req.body || {};
  const action = body.action;

  try {
    if (action === 'list') return await listAccounts(req, res, payload);
    if (action === 'create') {
      if (!isMaster) return bad(res, 403, 'masterのみ');
      return await createAccount(req, res, body);
    }
    if (action === 'update') {
      if (!isMaster) return bad(res, 403, 'masterのみ');
      return await updateAccount(req, res, body);
    }
    if (action === 'delete') {
      if (!isMaster) return bad(res, 403, 'masterのみ');
      return await deleteAccount(req, res, body);
    }
    if (action === 'create-for-new-staff') {
      // master / leader 両方OK（スタッフ追加と同時のアカウント作成）
      return await createForNewStaff(req, res, body);
    }
    return bad(res, 400, '不明なアクション');
  } catch (e) {
    console.error('admin-accounts error:', e);
    return bad(res, 500, '内部エラー');
  }
}

async function listAccounts(req, res, payload) {
  // master 以外は閲覧自体禁止
  if (payload.role !== 'master') return bad(res, 403, 'masterのみ');
  const accounts = await sb(`accounts?order=role,name&select=id,email,name,role,dept_id`);
  return res.status(200).json({ accounts });
}

async function createAccount(req, res, body) {
  const { name, email, password, role, deptId } = body;
  if (!name || !email || !password) return bad(res, 400, '入力不足');
  if (password.length < 8) return bad(res, 400, 'パスワードは8文字以上');
  if (!['master', 'leader', 'staff'].includes(role)) return bad(res, 400, 'roleが不正');

  const hash = await sha256(password);
  try {
    await sb('accounts', {
      method: 'POST',
      body: JSON.stringify([{
        name,
        email: email.toLowerCase(),
        password_hash: hash,
        role,
        dept_id: ['leader', 'staff'].includes(role) ? (deptId ?? null) : null,
      }]),
    });
  } catch (e) {
    if (String(e.message).includes('unique')) return bad(res, 409, 'このメールアドレスは既に登録されています');
    throw e;
  }
  return res.status(200).json({ ok: true });
}

async function updateAccount(req, res, body) {
  const { id, name, email, password, role, deptId } = body;
  if (!id) return bad(res, 400, 'idがありません');
  const update = {};
  if (name !== undefined) update.name = name;
  if (email !== undefined) update.email = String(email).toLowerCase();
  if (role !== undefined) update.role = role;
  if (deptId !== undefined) update.dept_id = deptId;
  if (password) {
    if (password.length < 8) return bad(res, 400, 'パスワードは8文字以上');
    update.password_hash = await sha256(password);
  }
  if (Object.keys(update).length === 0) return bad(res, 400, '更新内容なし');
  await sb(`accounts?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(update),
  });
  return res.status(200).json({ ok: true });
}

async function deleteAccount(req, res, body) {
  const { id } = body;
  if (!id) return bad(res, 400, 'idがありません');
  await sb(`accounts?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.status(200).json({ ok: true });
}

async function createForNewStaff(req, res, body) {
  const { name, email, password, deptId, staffId, staffCode } = body;
  if (!name || !email || !password || deptId == null || !staffId || staffCode == null) {
    return bad(res, 400, '入力不足（staff_id/staff_code必須）');
  }
  if (password.length < 8) return bad(res, 400,

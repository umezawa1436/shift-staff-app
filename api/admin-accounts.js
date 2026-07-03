// /api/admin-accounts.js
// kingyo-shift 管理者用 accounts CRUD API
// 仕様: メールアドレス収集なし
//   - list                 : アカウント一覧（master/leader）
//   - create               : 単発アカウント追加（master）
//   - update               : アカウント編集（master）
//   - delete               : アカウント削除（master）
//   - create-for-new-staff : 新規スタッフのアカウント作成（master/leader）

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;

function envOk() { return SUPABASE_URL && SERVICE_ROLE_KEY && SESSION_SECRET; }

// ===== パスワードハッシュ（scrypt・ソルト付き）=====
// 形式: s2$N$r$p$salt(base64)$hash(base64)
// 旧形式（SHA-256 hex 64桁）はログイン成功時に自動で scrypt へ再ハッシュ（レイジー移行）。
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `s2$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  try {
    if (stored.startsWith('s2$')) {
      const parts = stored.split('$');
      if (parts.length !== 6) return false;
      const N = parseInt(parts[1]), r = parseInt(parts[2]), p = parseInt(parts[3]);
      const salt = Buffer.from(parts[4], 'base64');
      const expected = Buffer.from(parts[5], 'base64');
      if (!Number.isInteger(N) || N < 2 || N > 1048576 || !Number.isInteger(r) || !Number.isInteger(p) || !salt.length || !expected.length) return false;
      const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p, maxmem: 128 * 1024 * 1024 });
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }
    // 旧形式: SHA-256 hex
    const legacy = crypto.createHash('sha256').update(String(password)).digest();
    const storedBuf = Buffer.from(stored, 'hex');
    return storedBuf.length === legacy.length && crypto.timingSafeEqual(storedBuf, legacy);
  } catch { return false; }
}

// 旧形式かどうか（ログイン成功時の自動再ハッシュ判定用）
function isLegacyHash(stored) {
  return typeof stored === 'string' && !stored.startsWith('s2$');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
  if (!envOk()) return bad(res, 500, 'サーバー設定エラー');
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
    if (action === 'unlock') {
      if (!isMaster) return bad(res, 403, 'masterのみ');
      return await unlockAccount(req, res, body);
    }
    if (action === 'create-for-new-staff') {
      return await createForNewStaff(req, res, body);
    }
    return bad(res, 400, '不明なアクション');
  } catch (e) {
    console.error('admin-accounts error:', e);
    return bad(res, 500, '内部エラー');
  }
}

async function listAccounts(req, res, payload) {
  if (payload.role !== 'master') return bad(res, 403, 'masterのみ');
  const accounts = await sb(`accounts?order=role,dept_id.asc.nullslast,name&select=id,name,role,dept_id,failed_attempts,locked_at,staff_id,staff_code`);
  return res.status(200).json({ accounts });
}

async function createAccount(req, res, body) {
  const { name, password, role, deptId } = body;
  if (!name || !password) return bad(res, 400, '名前とパスワードを入力してください');
  if (password.length < 4) return bad(res, 400, 'パスワードは4文字以上');
  if (!['master', 'leader', 'staff'].includes(role)) return bad(res, 400, 'roleが不正');
  if (role === 'master' && deptId != null) return bad(res, 400, 'masterは部門を指定できません');
  if ((role === 'leader' || role === 'staff') && (deptId === null || deptId === undefined)) return bad(res, 400, '部門を指定してください');

  // 重複チェック: 同一 dept_id (or null) + 同一 name + 同一 role はNG
  const deptCondition = (deptId == null) ? 'dept_id=is.null' : `dept_id=eq.${parseInt(deptId)}`;
  const existing = await sb(`accounts?name=eq.${encodeURIComponent(name)}&${deptCondition}&role=eq.${role}&select=id`);
  if (existing && existing.length > 0) {
    return bad(res, 409, '同じ部門・名前・権限のアカウントが既に存在します');
  }

  const hash = hashPassword(password);
  const record = {
    name,
    password_hash: hash,
    role,
    dept_id: (role === 'master') ? null : parseInt(deptId),
  };
  // role=staff の場合はスタッフ紐付け（任意）。staff_id/staff_code が無いとスタッフログイン不可なので推奨。
  if (role === 'staff') {
    if (body.staffId) record.staff_id = body.staffId;
    if (body.staffCode !== undefined && body.staffCode !== null && body.staffCode !== '') record.staff_code = parseInt(body.staffCode);
  }
  await sb('accounts', {
    method: 'POST',
    body: JSON.stringify([record]),
  });
  return res.status(200).json({ ok: true });
}

async function updateAccount(req, res, body) {
  const { id, name, password, role, deptId, staffCode, staffId } = body;
  if (!id) return bad(res, 400, 'idがありません');
  const update = {};
  if (name !== undefined) update.name = name;
  if (role !== undefined) {
    update.role = role;
    // role変更時は dept_id も適切に
    if (role === 'master') update.dept_id = null;
    else if (deptId !== undefined) update.dept_id = parseInt(deptId);
  } else if (deptId !== undefined) {
    update.dept_id = deptId === null ? null : parseInt(deptId);
  }
  if (password) {
    if (password.length < 4) return bad(res, 400, 'パスワードは4文字以上');
    update.password_hash = hashPassword(password);
  }
  // スタッフ紐付け: staff_code = ログインID（部門内ユニーク）, staff_id = staffレコード参照(uuid)
  // 空文字/nullで紐付け解除も可能
  if (staffCode !== undefined) update.staff_code = (staffCode === null || staffCode === '') ? null : parseInt(staffCode);
  if (staffId !== undefined) update.staff_id = staffId ? staffId : null;
  if (Object.keys(update).length === 0) return bad(res, 400, '更新内容なし');
  await sb(`accounts?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(update) });
  return res.status(200).json({ ok: true });
}

async function deleteAccount(req, res, body) {
  const { id } = body;
  if (!id) return bad(res, 400, 'idがありません');
  await sb(`accounts?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.status(200).json({ ok: true });
}

async function unlockAccount(req, res, body) {
  const { id } = body;
  if (!id) return bad(res, 400, 'idがありません');
  await sb(`accounts?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ failed_attempts: 0, locked_at: null }),
  });
  return res.status(200).json({ ok: true });
}

async function createForNewStaff(req, res, body) {
  const { name, password, deptId, staffId, staffCode } = body;
  if (!name || !password || deptId == null || !staffId || staffCode == null) {
    return bad(res, 400, '入力不足（staff_id/staff_code必須）');
  }
  if (password.length < 4) return bad(res, 400, 'パスワードは4文字以上');

  // 重複チェック: 同一 dept_id + 同一 name + role=staff はNG
  const existing = await sb(`accounts?name=eq.${encodeURIComponent(name)}&dept_id=eq.${parseInt(deptId)}&role=eq.staff&select=id`);
  if (existing && existing.length > 0) {
    return bad(res, 409, '同じ部門・名前のスタッフアカウントが既に存在します');
  }

  const hash = hashPassword(password);
  await sb('accounts', {
    method: 'POST',
    body: JSON.stringify([{
      name,
      password_hash: hash,
      role: 'staff',
      dept_id: parseInt(deptId),
      staff_id: staffId,
      staff_code: staffCode,
    }]),
  });
  return res.status(200).json({ ok: true });
}

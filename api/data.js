// /api/auth.js
// kingyo-shift 認証API
// 仕様: 部門 + 名前 + パスワード でログイン (master/leader/staff 共通方式)
//   - staff-login    : { deptId, staffCode, password }
//   - admin-login    : { deptId (null=master), name, password }
//   - change-password: { currentPassword, newPassword } + Authorization header

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    if (action === 'staff-login') {
      // 新方式: 社員番号ID + パスワード（deptId 付きの旧クライアントはレガシー処理へ）
      if (body.deptId === undefined || body.deptId === null || body.deptId === '') return await staffLoginByCode(req, res, body);
      return await staffLogin(req, res, body);
    }
    if (action === 'admin-login') {
      if (body.name === undefined) return await adminLoginByCode(req, res, body);
      return await adminLogin(req, res, body);
    }
    if (action === 'change-password') return await changePassword(req, res, body);
    return bad(res, 400, '不明なアクション');
  } catch (e) {
    console.error('auth error:', e);
    return bad(res, 500, '内部エラー');
  }
}

// スタッフログイン: 部門 + staff_code + password
async function staffLogin(req, res, body) {
  const { deptId, staffCode, password } = body;
  if (deptId === undefined || deptId === null || !staffCode || !password) return bad(res, 400, '入力が不足しています');
  const deptIdNum = parseInt(deptId);
  const codeNum = parseInt(staffCode);

  // 該当アカウント取得（パスワード関係なく、ロック状態を確認するため）
  const candidates = await sb(`accounts?staff_code=eq.${codeNum}&dept_id=eq.${deptIdNum}&role=eq.staff&select=id,name,dept_id,staff_id,staff_code,role,password_hash,failed_attempts,locked_at`);
  if (!candidates || candidates.length === 0) return bad(res, 401, 'パスワードが正しくありません');
  const a = candidates[0];

  // ロックチェック
  if (a.locked_at) {
    return bad(res, 423, 'このアカウントはロックされています。管理者に解除を依頼してください。');
  }

  // パスワード照合（scrypt / 旧SHA-256 両対応）
  if (!verifyPassword(password, a.password_hash)) {
    // 失敗カウント増、5回でロック
    const newCount = (a.failed_attempts || 0) + 1;
    const updates = { failed_attempts: newCount };
    if (newCount >= 5) updates.locked_at = new Date().toISOString();
    await sb(`accounts?id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify(updates) });
    if (newCount >= 5) {
      return bad(res, 423, 'ログイン失敗が5回に達したため、アカウントがロックされました。管理者に解除を依頼してください。');
    }
    return bad(res, 401, `パスワードが正しくありません（残り${5 - newCount}回でロックされます）`);
  }

  if (a.staff_id == null || a.staff_code == null) return bad(res, 500, 'アカウント設定が不完全です。管理者に連絡してください');

  // 成功: 失敗カウントをリセット＋旧形式ハッシュは scrypt へ自動移行
  const successUpdates = {};
  if (a.failed_attempts && a.failed_attempts > 0) successUpdates.failed_attempts = 0;
  if (isLegacyHash(a.password_hash)) successUpdates.password_hash = hashPassword(password);
  if (Object.keys(successUpdates).length) {
    await sb(`accounts?id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify(successUpdates) });
  }

  const token = createToken({ accountId: a.id, role: a.role, deptId: a.dept_id });
  return res.status(200).json({ token, user: { id: a.staff_id, accountId: a.id, staffCode: a.staff_code, name: a.name, deptId: a.dept_id, role: a.role } });
}

// 管理者ログイン: 部門 (nullなら master) + 名前 + password
// leaderは自部門のdept_idでログイン
async function adminLogin(req, res, body) {
  const { deptId, name, password } = body;
  if (name === undefined || name === null || name === '' || !password) return bad(res, 400, '入力が不足しています');

  let query;
  if (deptId === null || deptId === undefined || deptId === 'null' || deptId === '') {
    // master 検索
    query = `accounts?name=eq.${encodeURIComponent(name)}&dept_id=is.null&role=eq.master&select=id,name,role,dept_id,password_hash,failed_attempts,locked_at`;
  } else {
    const deptIdNum = parseInt(deptId);
    query = `accounts?name=eq.${encodeURIComponent(name)}&dept_id=eq.${deptIdNum}&role=eq.leader&select=id,name,role,dept_id,password_hash,failed_attempts,locked_at`;
  }
  const candidates = await sb(query);
  if (!candidates || candidates.length === 0) return bad(res, 401, '名前またはパスワードが正しくありません');
  const a = candidates[0];

  // ロックチェック
  if (a.locked_at) {
    return bad(res, 423, 'このアカウントはロックされています。管理者に解除を依頼してください。');
  }

  // パスワード照合（scrypt / 旧SHA-256 両対応）
  if (!verifyPassword(password, a.password_hash)) {
    const newCount = (a.failed_attempts || 0) + 1;
    const updates = { failed_attempts: newCount };
    if (newCount >= 5) updates.locked_at = new Date().toISOString();
    await sb(`accounts?id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify(updates) });
    if (newCount >= 5) {
      return bad(res, 423, 'ログイン失敗が5回に達したため、アカウントがロックされました。管理者に解除を依頼してください。');
    }
    return bad(res, 401, `名前またはパスワードが正しくありません（残り${5 - newCount}回でロックされます）`);
  }

  // 成功: 失敗カウントをリセット＋旧形式ハッシュは scrypt へ自動移行
  const successUpdates = {};
  if (a.failed_attempts && a.failed_attempts > 0) successUpdates.failed_attempts = 0;
  if (isLegacyHash(a.password_hash)) successUpdates.password_hash = hashPassword(password);
  if (Object.keys(successUpdates).length) {
    await sb(`accounts?id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify(successUpdates) });
  }

  const token = createToken({ accountId: a.id, role: a.role, deptId: a.dept_id });
  return res.status(200).json({ token, user: { id: a.id, name: a.name, role: a.role, deptId: a.dept_id } });
}

// ===== 社員番号ID + パスワード によるログイン中核 =====
// staff_code は歴史的に部署内ユニーク採番のため、部署跨ぎの重複があり得る。
// 候補全員に対して照合し、一致が1件のときだけログイン成立。複数一致は安全側で拒否。
async function authenticateByCode(staffCode, password) {
  const codeNum = parseInt(staffCode);
  if (!Number.isInteger(codeNum) || codeNum < 0) {
    return { status: 400, error: '社員番号IDを入力してください' };
  }
  const candidates = await sb(`accounts?staff_code=eq.${codeNum}&select=id,name,role,dept_id,staff_id,staff_code,password_hash,failed_attempts,locked_at`);
  if (!candidates || candidates.length === 0) {
    return { status: 401, error: '社員番号IDまたはパスワードが正しくありません' };
  }
  const matches = candidates.filter(a => verifyPassword(password, a.password_hash));
  if (matches.length > 1) {
    return { status: 409, error: '同じ社員番号IDのアカウントが複数一致しました。管理者に社員番号IDの重複解消を依頼してください' };
  }
  if (matches.length === 1) {
    const a = matches[0];
    if (a.locked_at) {
      return { status: 423, error: 'このアカウントはロックされています。管理者に解除を依頼してください。' };
    }
    // 成功: 失敗カウントリセット＋旧形式ハッシュは scrypt へ自動移行
    const upd = {};
    if (a.failed_attempts && a.failed_attempts > 0) upd.failed_attempts = 0;
    if (isLegacyHash(a.password_hash)) upd.password_hash = hashPassword(password);
    if (Object.keys(upd).length) {
      await sb(`accounts?id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify(upd) });
    }
    return { account: a };
  }
  // 全候補で不一致: 未ロック候補の失敗カウントを進める（5回でロック）
  let minRemain = 5;
  let anyUnlocked = false;
  for (const a of candidates) {
    if (a.locked_at) continue;
    anyUnlocked = true;
    const n = (a.failed_attempts || 0) + 1;
    const u = { failed_attempts: n };
    if (n >= 5) u.locked_at = new Date().toISOString();
    await sb(`accounts?id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify(u) });
    minRemain = Math.min(minRemain, 5 - n);
  }
  if (!anyUnlocked) {
    return { status: 423, error: 'このアカウントはロックされています。管理者に解除を依頼してください。' };
  }
  if (minRemain <= 0) {
    return { status: 423, error: 'ログイン失敗が5回に達したため、アカウントがロックされました。管理者に解除を依頼してください。' };
  }
  return { status: 401, error: `社員番号IDまたはパスワードが正しくありません（残り${minRemain}回でロックされます）` };
}

// スタッフ画面ログイン（新方式）: どの権限でも可。スタッフ紐付け必須。
async function staffLoginByCode(req, res, body) {
  const { staffCode, password } = body;
  if (staffCode === undefined || staffCode === null || staffCode === '' || !password) {
    return bad(res, 400, '社員番号IDとパスワードを入力してください');
  }
  const r = await authenticateByCode(staffCode, password);
  if (r.error) return bad(res, r.status, r.error);
  const a = r.account;
  if (!a.staff_id) {
    return bad(res, 400, 'スタッフ情報が未紐付けのアカウントです。管理者に紐付けを依頼してください');
  }
  // 部門はスタッフ本体から解決（master/leaderはアカウント側dept_idがnullの場合があるため）
  const staffRows = await sb(`staff?id=eq.${encodeURIComponent(a.staff_id)}&select=dept_id`);
  const deptId = (staffRows && staffRows[0] && staffRows[0].dept_id != null) ? staffRows[0].dept_id : a.dept_id;
  const token = createToken({ accountId: a.id, role: a.role, deptId });
  return res.status(200).json({ token, user: { id: a.staff_id, accountId: a.id, staffCode: a.staff_code, name: a.name, deptId, role: a.role } });
}

// 管理画面ログイン（新方式）: leader/master 権限が必須。
async function adminLoginByCode(req, res, body) {
  const { staffCode, password } = body;
  if (staffCode === undefined || staffCode === null || staffCode === '' || !password) {
    return bad(res, 400, '社員番号IDとパスワードを入力してください');
  }
  const r = await authenticateByCode(staffCode, password);
  if (r.error) return bad(res, r.status, r.error);
  const a = r.account;
  if (a.role !== 'leader' && a.role !== 'master') {
    return bad(res, 403, '管理者権限がありません。スタッフ画面からログインしてください');
  }
  const token = createToken({ accountId: a.id, role: a.role, deptId: a.dept_id });
  return res.status(200).json({ token, user: { id: a.id, name: a.name, role: a.role, deptId: a.dept_id } });
}

async function changePassword(req, res, body) {
  const token = extractBearer(req);
  const payload = verifyToken(token);
  if (!payload) return bad(res, 401, 'セッションが無効です。再ログインしてください');
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) return bad(res, 400, '入力が不足しています');
  if (newPassword.length < 4) return bad(res, 400, 'パスワードは4文字以上にしてください');
  const rows = await sb(`accounts?id=eq.${payload.accountId}&select=id,password_hash`);
  if (!rows || rows.length === 0) return bad(res, 401, 'アカウントが見つかりません');
  if (!verifyPassword(currentPassword, rows[0].password_hash)) return bad(res, 401, '現在のパスワードが正しくありません');
  await sb(`accounts?id=eq.${payload.accountId}`, { method: 'PATCH', body: JSON.stringify({ password_hash: hashPassword(newPassword) }) });
  return res.status(200).json({ ok: true });
}

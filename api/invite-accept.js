// /api/invite-accept.js
// 招待リンクからのアカウント作成API
// 仕様: メールアドレス収集なし、パスワードのみ入力
//   - lookup : { token } → スタッフ情報を返す
//   - create : { token, password } → アカウント作成 or 既存アカウント更新

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function envOk() { return SUPABASE_URL && SERVICE_ROLE_KEY; }

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
  const body = req.body || {};
  const action = body.action;
  try {
    if (action === 'lookup') return await lookupInvite(req, res, body);
    if (action === 'create') return await createFromInvite(req, res, body);
    return bad(res, 400, '不明なアクション');
  } catch (e) {
    console.error('invite-accept error:', e);
    return bad(res, 500, '内部エラー');
  }
}

async function fetchInviteAndStaff(token) {
  const invitations = await sb(`invitations?token=eq.${encodeURIComponent(token)}&select=id,token,staff_id,used_at,expires_at`);
  if (!invitations || invitations.length === 0) return { err: '招待リンクが見つかりません' };
  const invitation = invitations[0];
  if (new Date(invitation.expires_at) < new Date()) return { err: '招待リンクは期限切れです' };
  if (invitation.used_at) return { err: 'この招待リンクは既に使用されています' };
  const staffs = await sb(`staff?id=eq.${invitation.staff_id}&select=id,name,dept_id,staff_code`);
  if (!staffs || staffs.length === 0) return { err: 'スタッフ情報が見つかりません' };
  return { invitation, staff: staffs[0] };
}

async function lookupInvite(req, res, body) {
  const { token } = body;
  if (!token) return bad(res, 400, 'トークンがありません');
  const r = await fetchInviteAndStaff(token);
  if (r.err) return bad(res, 400, r.err);
  return res.status(200).json({
    staff: { id: r.staff.id, name: r.staff.name, dept_id: r.staff.dept_id, staff_code: r.staff.staff_code },
  });
}

async function createFromInvite(req, res, body) {
  const { token, password } = body;
  if (!token || !password) return bad(res, 400, '入力不足');
  if (password.length < 4) return bad(res, 400, 'パスワードは4文字以上');
  const r = await fetchInviteAndStaff(token);
  if (r.err) return bad(res, 400, r.err);
  const { invitation, staff } = r;
  const hash = hashPassword(password);

  // このスタッフの既存アカウントを探す (同部門・同名・role=staff)
  const sameStaffAccounts = await sb(`accounts?name=eq.${encodeURIComponent(staff.name)}&dept_id=eq.${staff.dept_id}&role=eq.staff&select=id`);

  if (sameStaffAccounts && sameStaffAccounts.length > 0) {
    const accountId = sameStaffAccounts[0].id;
    await sb(`accounts?id=eq.${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ password_hash: hash, staff_id: staff.id, staff_code: staff.staff_code }),
    });
  } else {
    await sb('accounts', {
      method: 'POST',
      body: JSON.stringify([{
        name: staff.name, password_hash: hash, role: 'staff',
        dept_id: staff.dept_id, staff_id: staff.id, staff_code: staff.staff_code,
      }]),
    });
  }
  await sb(`invitations?id=eq.${invitation.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ used_at: new Date().toISOString() }),
  });
  return res.status(200).json({ ok: true });
}

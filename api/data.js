// /api/data.js
// 認証付き汎用データAPI（service_role）
// anonキー直叩きを段階的に置き換えるための共有エンドポイント。
// shift_token（HMAC）を検証し、「テーブル × アクション × role」のホワイトリストに従って
// service_role で Supabase REST を実行する。anonキーは一切使わない。
//
// 対応アクション: list / insert / update / delete
// 対応テーブル（順次追加）:
//   shift_types  list: staff/leader/master   insert/update/delete: leader/master
//
// リクエスト形:
//   { action:'list',   table:'shift_types' }
//   { action:'insert', table:'shift_types', values:{...} }
//   { action:'update', table:'shift_types', id:'日勤+', values:{...} }
//   { action:'delete', table:'shift_types', id:'日勤+' }
//
// レスポンス: list→{ rows }, insert/update→{ ok:true, rows }, delete→{ ok:true }

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;

function envOk() { return SUPABASE_URL && SERVICE_ROLE_KEY && SESSION_SECRET; }

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

// ===== テーブル × アクション × role ホワイトリスト =====
// listQuery: 固定の読み取りクエリ（クライアントから任意クエリは受け付けない）
// idCol    : update/delete で id を当てる主キー列
const POLICY = {
  shift_types: {
    idCol: 'id',
    listQuery: 'shift_types?order=display_order,id&select=*',
    list:   ['staff', 'leader', 'master'],
    insert: ['leader', 'master'],
    update: ['leader', 'master'],
    delete: ['leader', 'master'],
  },
};

function allowed(table, action, role) {
  const p = POLICY[table];
  if (!p) return false;
  const roles = p[action];
  return Array.isArray(roles) && roles.includes(role);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');
  if (!envOk()) return bad(res, 500, 'サーバー設定エラー');
  const payload = verifyToken(extractBearer(req));
  if (!payload) return bad(res, 401, 'セッションが無効です');

  const body = req.body || {};
  const { action, table } = body;
  if (!action || !table) return bad(res, 400, 'action と table が必要です');
  if (!POLICY[table]) return bad(res, 400, '許可されていないテーブルです');
  if (!allowed(table, action, payload.role)) return bad(res, 403, '権限がありません');

  const p = POLICY[table];
  try {
    if (action === 'list') {
      const rows = await sb(p.listQuery);
      return res.status(200).json({ rows });
    }
    if (action === 'insert') {
      const values = body.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) return bad(res, 400, 'values が不正です');
      const rows = await sb(table, { method: 'POST', body: JSON.stringify([values]) });
      return res.status(200).json({ ok: true, rows });
    }
    if (action === 'update') {
      const { id, values } = body;
      if (id === undefined || id === null || id === '') return bad(res, 400, 'id が必要です');
      if (!values || typeof values !== 'object' || Array.isArray(values)) return bad(res, 400, 'values が不正です');
      const rows = await sb(`${table}?${p.idCol}=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(values) });
      return res.status(200).json({ ok: true, rows });
    }
    if (action === 'delete') {
      const { id } = body;
      if (id === undefined || id === null || id === '') return bad(res, 400, 'id が必要です');
      await sb(`${table}?${p.idCol}=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }
    return bad(res, 400, '不明なアクション');
  } catch (e) {
    console.error('data api error:', e);
    return bad(res, 500, '内部エラー');
  }
}

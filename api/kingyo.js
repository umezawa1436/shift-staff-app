// /api/kingyo.js
// 「今日の一言（好きな言葉）」共有のサーバーAPI
// 目的: anonキー直叩きを遮断し、独自トークンで本人/権限を検証して操作する。
//   - list-shared : 全員。非表示を除く共有語。匿名は name/staff_id を返さない（実名秘匿）。
//   - list-mine   : 本人の言葉（非表示のみ）を返す。編集用。
//   - save-mine   : 本人の言葉を置き換え。staff_id/name/dept はアカウントから解決（なりすまし防止）。
//                   非表示にされた語は保持（再保存で復活させない＝モデレーション尊重）。
//   - list-admin  : master のみ。全件（実名込み）。
//   - moderate    : master のみ。hide / show / delete。

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');
  if (!envOk()) return bad(res, 500, 'サーバー設定エラー');
  const payload = verifyToken(extractBearer(req));
  if (!payload) return bad(res, 401, 'セッションが無効です');

  const role = payload.role;
  const isAdmin = role === 'master' || role === 'leader';
  const action = (req.body || {}).action;

  try {
    if (action === 'list-shared') return await listShared(req, res);
    if (action === 'list-mine') return await listMine(req, res, payload);
    if (action === 'save-mine') return await saveMine(req, res, payload);
    if (action === 'list-admin') {
      if (role !== 'master') return bad(res, 403, 'masterのみ');
      return await listAdmin(req, res);
    }
    if (action === 'moderate') {
      if (role !== 'master') return bad(res, 403, 'masterのみ');
      return await moderate(req, res, req.body);
    }
    return bad(res, 400, '不明なアクション');
  } catch (e) {
    console.error('kingyo error:', e);
    return bad(res, 500, '内部エラー');
  }
}

// アカウントID → staff_id / name / dept を解決（クライアントの自己申告は信用しない）
async function resolveStaff(accountId) {
  const accs = await sb(`accounts?id=eq.${encodeURIComponent(accountId)}&select=staff_id,name,dept_id`);
  return (accs && accs[0]) || null;
}

// 全員向け：非表示を除く共有語。匿名は実名・staff_id を返さない。
async function listShared(req, res) {
  const rows = await sb(`kingyo_words?is_hidden=eq.false&select=staff_id,name,text,is_anonymous&order=created_at.desc`);
  const words = (rows || []).map(w => w.is_anonymous
    ? { text: w.text, anonymous: true }
    : { text: w.text, name: w.name, staff_id: w.staff_id, anonymous: false });
  return res.status(200).json({ words });
}

// 本人の言葉（非表示のみ）を編集用に返す
async function listMine(req, res, payload) {
  const acc = await resolveStaff(payload.accountId);
  if (!acc || !acc.staff_id) return res.status(200).json({ words: [] });
  const rows = await sb(`kingyo_words?staff_id=eq.${encodeURIComponent(acc.staff_id)}&is_hidden=eq.false&select=text,is_anonymous&order=created_at`);
  return res.status(200).json({ words: rows || [] });
}

// 本人の言葉を置き換え。非表示にされた語は残す（再保存で復活させない）。
async function saveMine(req, res, payload) {
  const acc = await resolveStaff(payload.accountId);
  if (!acc || !acc.staff_id) return bad(res, 400, 'スタッフ未紐付けのアカウントです');
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 30) : [];
  const clean = items
    .map(it => ({ text: String((it && it.text) || '').trim().slice(0, 200), anon: !!(it && it.anon) }))
    .filter(it => it.text);
  // 本人の「非表示でない」語だけ削除（管理者が非表示にした語は保持）
  await sb(`kingyo_words?staff_id=eq.${encodeURIComponent(acc.staff_id)}&is_hidden=eq.false`, { method: 'DELETE' });
  if (clean.length) {
    await sb('kingyo_words', {
      method: 'POST',
      body: JSON.stringify(clean.map(it => ({
        staff_id: acc.staff_id, name: acc.name, dept_id: acc.dept_id, text: it.text, is_anonymous: it.anon
      }))),
    });
  }
  return res.status(200).json({ ok: true });
}

// 管理：全件（実名込み）
async function listAdmin(req, res) {
  const rows = await sb(`kingyo_words?select=id,staff_id,name,dept_id,text,is_hidden,is_anonymous,created_at&order=created_at.desc`);
  return res.status(200).json({ words: rows || [] });
}

// 管理：非表示 / 再表示 / 削除
async function moderate(req, res, body) {
  const { id, op } = body;
  if (!id) return bad(res, 400, 'idがありません');
  const idEq = `kingyo_words?id=eq.${encodeURIComponent(id)}`;
  if (op === 'hide') await sb(idEq, { method: 'PATCH', body: JSON.stringify({ is_hidden: true }) });
  else if (op === 'show') await sb(idEq, { method: 'PATCH', body: JSON.stringify({ is_hidden: false }) });
  else if (op === 'delete') await sb(idEq, { method: 'DELETE' });
  else return bad(res, 400, '不明な操作');
  return res.status(200).json({ ok: true });
}

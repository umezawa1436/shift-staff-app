// /api/data.js
// 認証付き汎用データAPI（service_role）
// anonキー直叩きを段階的に置き換えるための共有エンドポイント。
// shift_token（HMAC）を検証し、「テーブル × アクション × role」のホワイトリストに従って
// service_role で Supabase REST を実行する。anonキーは一切使わない。
//
// 対応アクション:
//   list（旧: 固定listQuery / 新: view+params）/ insert / update / delete / submit-requests
// 対応テーブル:
//   shift_types    list: staff/leader/master   insert/update/delete: leader/master
//   invitations    insert/delete: master
//   staff          list(view): me/dept=全roles, admin-all=leader/master
//                  insert/update/delete: leader/master（列ホワイトリスト・leaderは自部門限定）
//   shift_requests list(view): mine=全roles(本人強制), admin-month=leader/master
//                  submit-requests: 本人分の一括提出（月内を全削除→再INSERT、staff_idはサーバ強制）
//
// 所有者解決: トークンの accountId → accounts テーブル → staff_id / dept_id（自己申告は信用しない）

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

// アカウントID → role / staff_id / dept_id を解決（クライアントの自己申告は信用しない）
async function resolveAccount(accountId) {
  if (!accountId) return null;
  const rows = await sb(`accounts?id=eq.${encodeURIComponent(accountId)}&select=id,role,staff_id,dept_id,name`);
  return (rows && rows[0]) || null;
}

const intOk = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// staff テーブルで書き込みを許す列（これ以外は黙って落とす）
const STAFF_COLS = ['staff_code','name','dept_id','emp_type','no_night','no_count','skill_level','fixed_shifts','display_order'];
function pickCols(values, cols) {
  const out = {};
  for (const k of cols) if (Object.prototype.hasOwnProperty.call(values, k)) out[k] = values[k];
  return out;
}

// ===== テーブル × アクション × role ホワイトリスト =====
const POLICY = {
  shift_types: {
    idCol: 'id',
    listQuery: 'shift_types?order=display_order,id&select=*',
    list:   ['staff', 'leader', 'master'],
    insert: ['leader', 'master'],
    update: ['leader', 'master'],
    delete: ['leader', 'master'],
  },
  invitations: {
    idCol: 'id',
    insert: ['master'],
    delete: ['master'],
  },
  staff: {
    idCol: 'id',
    insert: ['leader', 'master'],
    update: ['leader', 'master'],
    delete: ['leader', 'master'],
  },
  shift_requests: {},
};

function allowed(table, action, role) {
  const p = POLICY[table];
  if (!p) return false;
  const roles = p[action];
  return Array.isArray(roles) && roles.includes(role);
}

// ===== list views =====
async function listView(res, payload, table, view, params) {
  params = params && typeof params === 'object' ? params : {};
  const role = payload.role;

  if (table === 'staff') {
    if (view === 'me') {
      const acc = await resolveAccount(payload.accountId);
      if (!acc || !acc.staff_id) return res.status(200).json({ rows: [] });
      const rows = await sb(`staff?id=eq.${encodeURIComponent(acc.staff_id)}&select=id,staff_code,name,dept_id,emp_type`);
      return res.status(200).json({ rows });
    }
    if (view === 'dept') {
      const deptId = params.dept_id;
      if (!intOk(deptId, 0, 99)) return bad(res, 400, 'dept_id が不正です');
      const rows = await sb(`staff?dept_id=eq.${deptId}&select=id,name,emp_type&order=display_order.asc.nullslast,staff_code`);
      return res.status(200).json({ rows });
    }
    if (view === 'admin-all') {
      if (role !== 'leader' && role !== 'master') return bad(res, 403, '権限がありません');
      let f = '';
      if (role === 'leader') {
        const acc = await resolveAccount(payload.accountId);
        if (!acc || acc.dept_id == null) return bad(res, 403, '部門が特定できません');
        f = `&dept_id=eq.${acc.dept_id}`;
      }
      const rows = await sb(`staff?order=dept_id,display_order.asc.nullslast,staff_code${f}&select=id,staff_code,name,dept_id,emp_type,no_night,no_count,skill_level,fixed_shifts,display_order`);
      return res.status(200).json({ rows });
    }
    return bad(res, 400, '不明なviewです');
  }

  if (table === 'shift_requests') {
    const year = params.year, month = params.month;
    if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
    if (view === 'mine') {
      const acc = await resolveAccount(payload.accountId);
      if (!acc || !acc.staff_id) return res.status(200).json({ rows: [] });
      const rows = await sb(`shift_requests?staff_id=eq.${encodeURIComponent(acc.staff_id)}&year=eq.${year}&month=eq.${month}&select=day,request_type&order=day`);
      return res.status(200).json({ rows });
    }
    if (view === 'admin-month') {
      if (role !== 'leader' && role !== 'master') return bad(res, 403, '権限がありません');
      const rows = await sb(`shift_requests?year=eq.${year}&month=eq.${month}&select=staff_id,day,request_type,submitted_at`);
      return res.status(200).json({ rows });
    }
    return bad(res, 400, '不明なviewです');
  }

  return bad(res, 400, 'viewに未対応のテーブルです');
}

// ===== 本人の希望を一括提出（月内全削除→INSERT。staff_idはサーバ側で強制）=====
async function submitRequests(res, payload, body) {
  const acc = await resolveAccount(payload.accountId);
  if (!acc || !acc.staff_id) return bad(res, 400, 'スタッフ未紐付けのアカウントです');
  const year = body.year, month = body.month;
  if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
  const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
  const clean = [];
  for (const it of items) {
    const day = it && it.day;
    const rt = String((it && it.request_type) || '').trim().slice(0, 30);
    if (!intOk(day, 1, 31) || !rt) continue;
    clean.push({ staff_id: acc.staff_id, year, month, day, request_type: rt });
  }
  await sb(`shift_requests?staff_id=eq.${encodeURIComponent(acc.staff_id)}&year=eq.${year}&month=eq.${month}`, { method: 'DELETE' });
  if (clean.length) {
    await sb('shift_requests', { method: 'POST', body: JSON.stringify(clean) });
  }
  return res.status(200).json({ ok: true, count: clean.length });
}

// leader は自部門の staff にしか書き込めない
async function assertLeaderDept(payload, targetDeptId) {
  if (payload.role !== 'leader') return true;
  const acc = await resolveAccount(payload.accountId);
  if (!acc || acc.dept_id == null) return false;
  return acc.dept_id === targetDeptId;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');
  if (!envOk()) return bad(res, 500, 'サーバー設定エラー');
  const payload = verifyToken(extractBearer(req));
  if (!payload) return bad(res, 401, 'セッションが無効です');

  const body = req.body || {};
  const { action, table } = body;
  if (!action) return bad(res, 400, 'action が必要です');

  try {
    // テーブル横断のカスタムアクション
    if (action === 'submit-requests') {
      return await submitRequests(res, payload, body);
    }

    if (!table || !POLICY[table]) return bad(res, 400, '許可されていないテーブルです');
    const p = POLICY[table];

    if (action === 'list') {
      // 新: view指定
      if (body.view) return await listView(res, payload, table, body.view, body.params);
      // 旧: 固定listQuery（shift_types）
      if (!allowed(table, 'list', payload.role)) return bad(res, 403, '権限がありません');
      if (!p.listQuery) return bad(res, 400, 'listに未対応のテーブルです');
      const rows = await sb(p.listQuery);
      return res.status(200).json({ rows });
    }

    if (!allowed(table, action, payload.role)) return bad(res, 403, '権限がありません');

    if (action === 'insert') {
      let values = body.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) return bad(res, 400, 'values が不正です');
      if (table === 'staff') {
        values = pickCols(values, STAFF_COLS);
        if (!intOk(values.dept_id, 0, 99)) return bad(res, 400, 'dept_id が不正です');
        if (!(await assertLeaderDept(payload, values.dept_id))) return bad(res, 403, '自部門以外は操作できません');
      }
      const rows = await sb(table, { method: 'POST', body: JSON.stringify([values]) });
      return res.status(200).json({ ok: true, rows });
    }

    if (action === 'update') {
      const { id } = body;
      let values = body.values;
      if (id === undefined || id === null || id === '') return bad(res, 400, 'id が必要です');
      if (!values || typeof values !== 'object' || Array.isArray(values)) return bad(res, 400, 'values が不正です');
      if (table === 'staff') {
        values = pickCols(values, STAFF_COLS);
        if (!Object.keys(values).length) return bad(res, 400, '更新可能な列がありません');
        if (payload.role === 'leader') {
          const target = await sb(`staff?id=eq.${encodeURIComponent(id)}&select=dept_id`);
          const deptId = target && target[0] ? target[0].dept_id : null;
          if (deptId == null || !(await assertLeaderDept(payload, deptId))) return bad(res, 403, '自部門以外は操作できません');
          if (Object.prototype.hasOwnProperty.call(values, 'dept_id') && !(await assertLeaderDept(payload, values.dept_id))) return bad(res, 403, '自部門以外へは移動できません');
        }
      }
      const rows = await sb(`${table}?${p.idCol}=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(values) });
      return res.status(200).json({ ok: true, rows });
    }

    if (action === 'delete') {
      const { id, match } = body;
      if (id !== undefined && id !== null && id !== '') {
        if (table === 'staff' && payload.role === 'leader') {
          const target = await sb(`staff?id=eq.${encodeURIComponent(id)}&select=dept_id`);
          const deptId = target && target[0] ? target[0].dept_id : null;
          if (deptId == null || !(await assertLeaderDept(payload, deptId))) return bad(res, 403, '自部門以外は操作できません');
        }
        await sb(`${table}?${p.idCol}=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
        return res.status(200).json({ ok: true });
      }
      // match: { col: value, ... } の等価フィルタで削除（value が null なら is.null）
      if (table !== 'staff' && match && typeof match === 'object' && !Array.isArray(match) && Object.keys(match).length) {
        const filters = Object.entries(match).map(([k, v]) =>
          (v === null) ? `${encodeURIComponent(k)}=is.null` : `${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`
        ).join('&');
        await sb(`${table}?${filters}`, { method: 'DELETE' });
        return res.status(200).json({ ok: true });
      }
      return bad(res, 400, 'id または match が必要です');
    }

    return bad(res, 400, '不明なアクション');
  } catch (e) {
    console.error('data api error:', e);
    return bad(res, 500, '内部エラー');
  }
}

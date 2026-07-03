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
const UUIDISH = /^[0-9a-fA-F-]{8,60}$/;
function validStaffIds(arr, cap = 300) {
  if (!Array.isArray(arr) || !arr.length || arr.length > cap) return null;
  for (const x of arr) if (typeof x !== 'string' || !UUIDISH.test(x)) return null;
  return arr;
}
const inFilter = (ids) => ids.map(id => `"${id}"`).join(',');

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
  shifts: {},
  cell_locks: {},
  shift_request_drafts: {},
  shift_breaks: {},
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

  if (table === 'shifts') {
    if (view === 'admin-month') {
      if (role !== 'leader' && role !== 'master') return bad(res, 403, '権限がありません');
      const year = params.year, month = params.month;
      if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
      const rows = await sb(`shifts?year=eq.${year}&month=eq.${month}&select=staff_id,day,shift_type_id,is_locked,is_confirmed,cell_label`);
      return res.status(200).json({ rows });
    }
    if (view === 'admin-confirmed-months') {
      if (role !== 'leader' && role !== 'master') return bad(res, 403, '権限がありません');
      const rows = await sb(`shifts?is_confirmed=eq.true&select=staff_id,year,month`);
      return res.status(200).json({ rows });
    }
    if (view === 'admin-staff-month') {
      if (role !== 'leader' && role !== 'master') return bad(res, 403, '権限がありません');
      const year = params.year, month = params.month, staffId = params.staff_id;
      if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
      if (typeof staffId !== 'string' || !UUIDISH.test(staffId)) return bad(res, 400, 'staff_id が不正です');
      const rows = await sb(`shifts?staff_id=eq.${encodeURIComponent(staffId)}&year=eq.${year}&month=eq.${month}&select=day,shift_type_id,is_locked`);
      return res.status(200).json({ rows });
    }
    const year = params.year, month = params.month;
    if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
    if (view === 'day-confirmed') {
      const day = params.day;
      if (!intOk(day, 1, 31)) return bad(res, 400, 'day が不正です');
      const rows = await sb(`shifts?year=eq.${year}&month=eq.${month}&day=eq.${day}&is_confirmed=eq.true&select=staff_id,shift_type_id,cell_label`);
      return res.status(200).json({ rows });
    }
    if (view === 'day-has-unconfirmed') {
      const day = params.day;
      if (!intOk(day, 1, 31)) return bad(res, 400, 'day が不正です');
      const rows = await sb(`shifts?year=eq.${year}&month=eq.${month}&day=eq.${day}&is_confirmed=eq.false&select=staff_id&limit=1`);
      return res.status(200).json({ rows });
    }
    if (view === 'my-month-confirmed') {
      const acc = await resolveAccount(payload.accountId);
      if (!acc || !acc.staff_id) return res.status(200).json({ rows: [] });
      const rows = await sb(`shifts?staff_id=eq.${encodeURIComponent(acc.staff_id)}&year=eq.${year}&month=eq.${month}&is_confirmed=eq.true&select=day,shift_type_id&order=day`);
      return res.status(200).json({ rows });
    }
    if (view === 'my-month-has-unconfirmed') {
      const acc = await resolveAccount(payload.accountId);
      if (!acc || !acc.staff_id) return res.status(200).json({ rows: [] });
      const rows = await sb(`shifts?staff_id=eq.${encodeURIComponent(acc.staff_id)}&year=eq.${year}&month=eq.${month}&is_confirmed=eq.false&select=day&limit=1`);
      return res.status(200).json({ rows });
    }
    return bad(res, 400, '不明なviewです');
  }

  if (table === 'cell_locks') {
    if (view === 'admin-month') {
      if (role !== 'leader' && role !== 'master') return bad(res, 403, '権限がありません');
      const year = params.year, month = params.month;
      if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
      try {
        const rows = await sb(`cell_locks?year=eq.${year}&month=eq.${month}&select=staff_id,day`);
        return res.status(200).json({ rows });
      } catch { return res.status(200).json({ rows: [] }); } // テーブル未作成でも壊さない
    }
    return bad(res, 400, '不明なviewです');
  }

  if (table === 'shift_request_drafts') {
    if (view === 'mine') {
      const year = params.year, month = params.month;
      if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
      const acc = await resolveAccount(payload.accountId);
      if (!acc || !acc.staff_id) return res.status(200).json({ rows: [] });
      const rows = await sb(`shift_request_drafts?staff_id=eq.${encodeURIComponent(acc.staff_id)}&year=eq.${year}&month=eq.${month}&select=day,request_type`);
      return res.status(200).json({ rows });
    }
    return bad(res, 400, '不明なviewです');
  }

  if (table === 'shift_breaks') {
    if (view === 'day') {
      const year = params.year, month = params.month, day = params.day;
      if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12) || !intOk(day, 1, 31)) return bad(res, 400, 'year/month/day が不正です');
      const rows = await sb(`shift_breaks?year=eq.${year}&month=eq.${month}&day=eq.${day}&order=staff_id,display_order&select=id,staff_id,break_start,break_end,display_order`);
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

// ===== シフト月次保存（部署スタッフ分を全削除→一括INSERT）=====
// confirmed=true で確定保存、false で通常保存。cellLocks（未選択セルのロック）も同時永続化。
async function saveShiftMonth(res, payload, body) {
  if (payload.role !== 'leader' && payload.role !== 'master') return bad(res, 403, '権限がありません');
  const year = body.year, month = body.month;
  if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
  const staffIds = validStaffIds(body.staff_ids);
  if (!staffIds) return bad(res, 400, 'staff_ids が不正です');
  const idSet = new Set(staffIds);
  const confirmed = !!body.confirmed;

  const rawRows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
  const rows = [];
  for (const r of rawRows) {
    if (!r || typeof r !== 'object') continue;
    const sid = r.staff_id;
    if (typeof sid !== 'string' || !UUIDISH.test(sid) || !idSet.has(sid)) continue;
    if (!intOk(r.day, 1, 31)) continue;
    const shiftId = (r.shift_type_id == null) ? null : String(r.shift_type_id).slice(0, 40);
    const label = (r.cell_label == null) ? null : String(r.cell_label).trim().slice(0, 40) || null;
    if (!shiftId && !label) continue;
    rows.push({
      staff_id: sid, year, month, day: r.day,
      shift_type_id: shiftId,
      is_locked: !!r.is_locked,
      is_confirmed: confirmed,
      cell_label: label,
    });
  }

  await sb(`shifts?staff_id=in.(${inFilter(staffIds)})&year=eq.${year}&month=eq.${month}`, { method: 'DELETE' });
  if (rows.length) await sb('shifts', { method: 'POST', body: JSON.stringify(rows) });

  // 未選択セルのロック永続化（cell_locks テーブルが無い環境でも壊さない）
  try {
    const rawLocks = Array.isArray(body.cellLocks) ? body.cellLocks.slice(0, 2000) : [];
    const locks = [];
    for (const l of rawLocks) {
      if (!l || typeof l !== 'object') continue;
      if (typeof l.staff_id !== 'string' || !UUIDISH.test(l.staff_id) || !idSet.has(l.staff_id)) continue;
      if (!intOk(l.day, 1, 31)) continue;
      locks.push({ staff_id: l.staff_id, year, month, day: l.day });
    }
    await sb(`cell_locks?staff_id=in.(${inFilter(staffIds)})&year=eq.${year}&month=eq.${month}`, { method: 'DELETE' });
    if (locks.length) await sb('cell_locks', { method: 'POST', body: JSON.stringify(locks) });
  } catch (e) { console.warn('cell_locks skip:', e.message); }

  return res.status(200).json({ ok: true, count: rows.length });
}

// ===== 月次の確定フラグ変更（確定取り消し等）=====
async function setShiftMonthConfirmed(res, payload, body) {
  if (payload.role !== 'leader' && payload.role !== 'master') return bad(res, 403, '権限がありません');
  const year = body.year, month = body.month;
  if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
  const staffIds = validStaffIds(body.staff_ids);
  if (!staffIds) return bad(res, 400, 'staff_ids が不正です');
  const confirmed = !!body.confirmed;
  // 取り消し時は is_confirmed=true の行だけを対象（現行挙動を踏襲）
  const extra = confirmed ? '' : '&is_confirmed=eq.true';
  await sb(`shifts?staff_id=in.(${inFilter(staffIds)})&year=eq.${year}&month=eq.${month}${extra}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ is_confirmed: confirmed }),
  });
  return res.status(200).json({ ok: true });
}

// ===== 曜日固定シフト：1か月分の適用（ロック済みは保護）=====
async function fixedShiftApply(res, payload, body) {
  if (payload.role !== 'leader' && payload.role !== 'master') return bad(res, 403, '権限がありません');
  const year = body.year, month = body.month, staffId = body.staff_id;
  if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
  if (typeof staffId !== 'string' || !UUIDISH.test(staffId)) return bad(res, 400, 'staff_id が不正です');
  const rawRows = Array.isArray(body.rows) ? body.rows.slice(0, 31) : [];

  // ロック済みの日はサーバ側でも保護
  const lockedRows = await sb(`shifts?staff_id=eq.${encodeURIComponent(staffId)}&year=eq.${year}&month=eq.${month}&is_locked=eq.true&select=day`);
  const lockedDays = new Set((lockedRows || []).map(r => r.day));

  const rows = [];
  for (const r of rawRows) {
    if (!r || typeof r !== 'object') continue;
    if (!intOk(r.day, 1, 31) || lockedDays.has(r.day)) continue;
    const shiftId = (r.shift_type_id == null) ? null : String(r.shift_type_id).slice(0, 40);
    if (!shiftId) continue;
    rows.push({
      staff_id: staffId, year, month, day: r.day,
      shift_type_id: shiftId,
      is_locked: !!r.is_locked,
      lock_type: (r.lock_type == null) ? null : String(r.lock_type).slice(0, 30),
    });
  }
  for (const r of rows) {
    await sb(`shifts?staff_id=eq.${encodeURIComponent(staffId)}&year=eq.${year}&month=eq.${month}&day=eq.${r.day}&is_locked=eq.false`, { method: 'DELETE' });
  }
  if (rows.length) await sb('shifts', { method: 'POST', body: JSON.stringify(rows) });
  return res.status(200).json({ ok: true, inserted: rows.length });
}

// ===== 曜日固定シフト：1か月分の解除（day+shift_type_id 完全一致のみ削除）=====
async function fixedShiftRemove(res, payload, body) {
  if (payload.role !== 'leader' && payload.role !== 'master') return bad(res, 403, '権限がありません');
  const year = body.year, month = body.month, staffId = body.staff_id;
  if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
  if (typeof staffId !== 'string' || !UUIDISH.test(staffId)) return bad(res, 400, 'staff_id が不正です');
  const items = Array.isArray(body.items) ? body.items.slice(0, 31) : [];
  let deleted = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (!intOk(it.day, 1, 31) || it.shift_type_id == null) continue;
    const st = String(it.shift_type_id).slice(0, 40);
    const url = `shifts?staff_id=eq.${encodeURIComponent(staffId)}&year=eq.${year}&month=eq.${month}&day=eq.${it.day}&shift_type_id=eq.${encodeURIComponent(st)}`;
    const before = await sb(`${url}&select=id`);
    if (before && before.length > 0) {
      await sb(url, { method: 'DELETE' });
      deleted += before.length;
    }
  }
  return res.status(200).json({ ok: true, deleted });
}

// ===== 希望の下書き（本人スコープ・staff_idはサーバ強制）=====
const TIME_RE = /^\d{1,2}:\d{2}$/;

async function draftSaveDay(res, payload, body) {
  const acc = await resolveAccount(payload.accountId);
  if (!acc || !acc.staff_id) return bad(res, 400, 'スタッフ未紐付けのアカウントです');
  const year = body.year, month = body.month, day = body.day;
  if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12) || !intOk(day, 1, 31)) return bad(res, 400, 'year/month/day が不正です');
  const rt = String(body.request_type || '').trim().slice(0, 30);
  if (!rt) return bad(res, 400, 'request_type が必要です');
  const sid = encodeURIComponent(acc.staff_id);
  await sb(`shift_request_drafts?staff_id=eq.${sid}&year=eq.${year}&month=eq.${month}&day=eq.${day}`, { method: 'DELETE' });
  await sb('shift_request_drafts', { method: 'POST', body: JSON.stringify([{ staff_id: acc.staff_id, year, month, day, request_type: rt }]) });
  return res.status(200).json({ ok: true });
}

async function draftDeleteDay(res, payload, body) {
  const acc = await resolveAccount(payload.accountId);
  if (!acc || !acc.staff_id) return bad(res, 400, 'スタッフ未紐付けのアカウントです');
  const year = body.year, month = body.month, day = body.day;
  if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12) || !intOk(day, 1, 31)) return bad(res, 400, 'year/month/day が不正です');
  await sb(`shift_request_drafts?staff_id=eq.${encodeURIComponent(acc.staff_id)}&year=eq.${year}&month=eq.${month}&day=eq.${day}`, { method: 'DELETE' });
  return res.status(200).json({ ok: true });
}

// 提出後の下書き同期（月内全削除→提出内容で再作成。items空なら削除のみ）
async function draftSync(res, payload, body) {
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
  await sb(`shift_request_drafts?staff_id=eq.${encodeURIComponent(acc.staff_id)}&year=eq.${year}&month=eq.${month}`, { method: 'DELETE' });
  if (clean.length) await sb('shift_request_drafts', { method: 'POST', body: JSON.stringify(clean) });
  return res.status(200).json({ ok: true });
}

// ===== 休憩の日次保存（その日を全削除→一括INSERT）=====
async function breaksSaveDay(res, payload, body) {
  if (payload.role !== 'leader' && payload.role !== 'master') return bad(res, 403, '権限がありません');
  const year = body.year, month = body.month, day = body.day;
  if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12) || !intOk(day, 1, 31)) return bad(res, 400, 'year/month/day が不正です');
  const rawRows = Array.isArray(body.rows) ? body.rows.slice(0, 300) : [];
  const rows = [];
  for (const r of rawRows) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.staff_id !== 'string' || !UUIDISH.test(r.staff_id)) continue;
    const bs = String(r.break_start || '').slice(0, 5);
    const be = String(r.break_end || '').slice(0, 5);
    if (!TIME_RE.test(bs) || !TIME_RE.test(be)) continue;
    const ord = Number.isInteger(r.display_order) ? Math.max(0, Math.min(100, r.display_order)) : 0;
    rows.push({ staff_id: r.staff_id, year, month, day, break_start: bs, break_end: be, display_order: ord });
  }
  await sb(`shift_breaks?year=eq.${year}&month=eq.${month}&day=eq.${day}`, { method: 'DELETE' });
  if (rows.length) await sb('shift_breaks', { method: 'POST', body: JSON.stringify(rows) });
  return res.status(200).json({ ok: true, count: rows.length });
}

// ===== 設定系テーブルの汎用ゲートウェイ =====
// クライアントは従来の PostgREST 風パス（table?col=eq.x&...）をそのまま送る。
// サーバ側でクエリを完全にパースし、テーブル・列・演算子のホワイトリストで検証してから
// 安全に再構築して service_role で実行する（生文字列のパススルーはしない）。
const SETTINGS_TABLES = {
  staff_settings:               { cols: ['id','staff_id','year','month','planned_hours','max_night_per_month','max_late_per_month','max_long_per_month','max_mid_per_month'], ownCol: 'staff_id' },
  monthly_hours:                { cols: ['id','year','month','dept_id','hours'] },
  staffing_requirements:        { cols: ['id','dept_id','period_id','day_type','min_count'] },
  special_days:                 { cols: ['id','year','month','day','is_closed','is_holiday','label'] },
  wednesday_types:              { cols: ['id','year','month','day','wed_type'] },
  thursday_types:               { cols: ['id','year','month','day','is_open'] },
  shift_request_deadline_rules: { cols: ['id','dept_id','days_before','hour','minute','months_before'] },
  shift_request_limits_default: { cols: ['id','dept_id','limit_kibou_kyu','limit_yukyu','limit_other'] },
  beginner_limits:              { cols: ['id','dept_id','period_id','day_type','max_beginners'] },
  app_settings:                 { cols: ['id','key','value'] },
  dept_shift_pattern_settings:  { cols: ['id','dept_id','enabled_patterns'] },
};
const OPS = new Set(['eq','neq','gt','gte','lt','lte','is','in']);
const SAFE_SCALAR = /^[\w\-.:+ %ぁ-んァ-ヶ一-龠々ー]*$/u;

function parseSettingsPath(path) {
  if (typeof path !== 'string' || path.length > 2000) return null;
  const qi = path.indexOf('?');
  const table = (qi === -1 ? path : path.slice(0, qi)).trim();
  const conf = SETTINGS_TABLES[table];
  if (!conf) return null;
  const out = { table, conf, filters: [], select: null, order: null, limit: null };
  if (qi === -1) return out;
  const usp = new URLSearchParams(path.slice(qi + 1));
  for (const [key, value] of usp.entries()) {
    if (key === 'select') {
      const parts = String(value).split(',').map(x => x.trim());
      for (const p of parts) if (p !== '*' && !conf.cols.includes(p)) return null;
      out.select = parts.join(',');
    } else if (key === 'order') {
      const segs = String(value).split(',').map(x => x.trim());
      for (const seg of segs) {
        const col = seg.split('.')[0];
        if (!conf.cols.includes(col)) return null;
        if (!/^[a-z_]+(\.(asc|desc))?(\.(nullslast|nullsfirst))?$/.test(seg)) return null;
      }
      out.order = segs.join(',');
    } else if (key === 'limit' || key === 'offset') {
      const n = parseInt(value);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return null;
      out[key] = n;
    } else {
      if (!conf.cols.includes(key)) return null;
      const dot = String(value).indexOf('.');
      if (dot === -1) return null;
      const op = value.slice(0, dot);
      const rest = value.slice(dot + 1);
      if (!OPS.has(op)) return null;
      if (op === 'is') {
        if (rest !== 'null' && rest !== 'true' && rest !== 'false') return null;
        out.filters.push(`${key}=is.${rest}`);
      } else if (op === 'in') {
        const m = rest.match(/^\((.*)\)$/s);
        if (!m) return null;
        const items = m[1].split(',').map(x => x.trim().replace(/^"|"$/g, ''));
        if (!items.length || items.length > 400) return null;
        for (const it of items) if (!/^[\w\-]{1,60}$/.test(it)) return null;
        out.filters.push(`${key}=in.(${items.map(x => `"${x}"`).join(',')})`);
      } else {
        const raw = decodeURIComponent(rest);
        if (raw.length > 100 || !SAFE_SCALAR.test(raw)) return null;
        out.filters.push(`${key}=${op}.${encodeURIComponent(raw)}`);
      }
    }
  }
  return out;
}

async function settingsGateway(res, payload, body) {
  const method = (body.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return bad(res, 400, 'method が不正です');
  const parsed = parseSettingsPath(body.path);
  if (!parsed) return bad(res, 400, '不正なクエリです');
  const { table, conf } = parsed;

  // 書き込みは leader/master のみ
  if (method !== 'GET' && payload.role !== 'leader' && payload.role !== 'master') {
    return bad(res, 403, '権限がありません');
  }
  // staff ロールの読み取りで ownCol があるテーブルは本人分に強制
  if (method === 'GET' && conf.ownCol && payload.role === 'staff') {
    const acc = await resolveAccount(payload.accountId);
    if (!acc || !acc.staff_id) return res.status(200).json({ rows: [] });
    parsed.filters = parsed.filters.filter(f => !f.startsWith(`${conf.ownCol}=`));
    parsed.filters.push(`${conf.ownCol}=eq.${encodeURIComponent(acc.staff_id)}`);
  }

  const qs = [];
  for (const f of parsed.filters) qs.push(f);
  if (parsed.select) qs.push(`select=${parsed.select}`);
  if (parsed.order) qs.push(`order=${parsed.order}`);
  if (parsed.limit != null) qs.push(`limit=${parsed.limit}`);
  if (parsed.offset != null) qs.push(`offset=${parsed.offset}`);
  const pathFinal = qs.length ? `${table}?${qs.join('&')}` : table;

  if (method === 'GET') {
    const rows = await sb(pathFinal);
    return res.status(200).json({ rows });
  }

  if (method === 'DELETE') {
    if (!parsed.filters.length) return bad(res, 400, 'フィルタ無しの削除は許可されていません');
    await sb(pathFinal, { method: 'DELETE' });
    return res.status(200).json({ ok: true });
  }

  // POST / PATCH：列ホワイトリストで body を濾過
  const raw = body.body;
  const clean = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const o = pickCols(obj, conf.cols);
    return Object.keys(o).length ? o : null;
  };
  if (method === 'POST') {
    const arr = Array.isArray(raw) ? raw.slice(0, 500).map(clean).filter(Boolean) : [clean(raw)].filter(Boolean);
    if (!arr.length) return bad(res, 400, '登録内容がありません');
    const headers = body.upsert ? { 'Prefer': 'resolution=merge-duplicates,return=representation' } : {};
    const rows = await sb(table, { method: 'POST', headers, body: JSON.stringify(arr) });
    return res.status(200).json({ rows, ok: true });
  }
  // PATCH
  if (!parsed.filters.length) return bad(res, 400, 'フィルタ無しの更新は許可されていません');
  const values = clean(raw);
  if (!values) return bad(res, 400, '更新内容がありません');
  const rows = await sb(pathFinal, { method: 'PATCH', body: JSON.stringify(values) });
  return res.status(200).json({ rows, ok: true });
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
    if (action === 'save-shift-month') {
      return await saveShiftMonth(res, payload, body);
    }
    if (action === 'set-shift-month-confirmed') {
      return await setShiftMonthConfirmed(res, payload, body);
    }
    if (action === 'fixed-shift-apply') {
      return await fixedShiftApply(res, payload, body);
    }
    if (action === 'fixed-shift-remove') {
      return await fixedShiftRemove(res, payload, body);
    }
    if (action === 'draft-save-day') {
      return await draftSaveDay(res, payload, body);
    }
    if (action === 'draft-delete-day') {
      return await draftDeleteDay(res, payload, body);
    }
    if (action === 'draft-sync') {
      return await draftSync(res, payload, body);
    }
    if (action === 'breaks-save-day') {
      return await breaksSaveDay(res, payload, body);
    }
    if (action === 'settings') {
      return await settingsGateway(res, payload, body);
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

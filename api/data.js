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
//
// カレンダー機能（events-* / ical-*）:
//   段階公開 app_settings.calendar_release（0=masterのみ/1=leaderまで/2=全員）をサーバ側で強制。
//   個人予定(scope='private')は所有アカウント以外に絶対に返さない。

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

// ===== 1000行上限（Supabase Max Rows）対策 =====
// PostgRESTはサーバー設定 Max Rows（既定1000）でレスポンスをサイレントに切り捨てる。
// 月間シフト等が閾値を超えると「確定シフトが一部表示されない」事故になるため（2026-07に実発生・1049行）、
// 大量になり得る読み込みは本関数で全件取得する。
// 仕組み: 安定ソートを付け、実際に返った行数分だけoffsetを進めて0件になるまでループ。
// limitを送らず「返った行数」で進めるので、サーバーのMax Rows設定値がいくつでも正しく動く。
async function sbAll(path, order) {
  const PAGE = 1000; // 【不変条件】Supabase設定の Max Rows は必ず PAGE 以上にしておくこと（現在5000）。
                     // Max Rows < PAGE だと1ページが PAGE 未満で返り、途中終了＝取りこぼしが再発する。
  const sep = path.includes('?') ? '&' : '?';
  const out = [];
  let offset = 0;
  for (let i = 0; i < 50; i++) { // 安全弁: 最大5万行
    const rows = await sb(`${path}${sep}order=${order}&limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE) break; // PAGE未満＝最終ページ。空ページ確認の余分な1往復を省く
    offset += rows.length;
  }
  return out;
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
      const rows = await sbAll(`shift_requests?year=eq.${year}&month=eq.${month}&select=staff_id,day,request_type,submitted_at`, 'staff_id,day');
      return res.status(200).json({ rows });
    }
    return bad(res, 400, '不明なviewです');
  }

  if (table === 'shifts') {
    if (view === 'admin-month') {
      if (role !== 'leader' && role !== 'master') return bad(res, 403, '権限がありません');
      const year = params.year, month = params.month;
      if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
      const rows = await sbAll(`shifts?year=eq.${year}&month=eq.${month}&select=staff_id,day,shift_type_id,is_locked,is_confirmed,cell_label`, 'staff_id,day');
      return res.status(200).json({ rows });
    }
    if (view === 'admin-confirmed-months') {
      if (role !== 'leader' && role !== 'master') return bad(res, 403, '権限がありません');
      const rows = await sbAll(`shifts?is_confirmed=eq.true&select=staff_id,year,month`, 'year,month,staff_id');
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
        const rows = await sbAll(`cell_locks?year=eq.${year}&month=eq.${month}&select=staff_id,day`, 'staff_id,day');
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

  // ===== UPSERT方式 =====
  // 旧実装（全削除→INSERT）は INSERT 失敗時に対象月のシフトが全消失する事故構造だったため廃止。
  // 前提: shifts に UNIQUE (staff_id, year, month, day)（shifts_staff_ymd_uniq）が必要。
  // 手順: ①現状読み取り → ②UPSERT（ここで失敗しても旧データ無傷） → ③差分DELETE（失敗しても余分セルが残るだけ）
  // どの段階で失敗してもデータ消失は起きない。
  // ペイロード内の同一セル重複は upsert でエラーになるため、後勝ちで事前排除する。
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.staff_id}|${r.day}`, r);
  const upsertRows = Array.from(byKey.values());

  // ① 現状の行（差分DELETE用）
  const current = await sbAll(`shifts?staff_id=in.(${inFilter(staffIds)})&year=eq.${year}&month=eq.${month}&select=id,staff_id,day`, 'staff_id,day');

  // ② UPSERT（既存セルは更新・新規セルは挿入）
  if (upsertRows.length) {
    await sb(`shifts?on_conflict=staff_id,year,month,day`, {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(upsertRows),
    });
  }

  // ③ 新しい状態に存在しないセルだけを id 指定で削除
  const keep = new Set(upsertRows.map(r => `${r.staff_id}|${r.day}`));
  const staleIds = (current || []).filter(c => !keep.has(`${c.staff_id}|${c.day}`)).map(c => c.id);
  for (let i = 0; i < staleIds.length; i += 100) {
    const chunk = staleIds.slice(i, i + 100);
    await sb(`shifts?id=in.(${chunk.map(encodeURIComponent).join(',')})`, { method: 'DELETE' });
  }

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

  return res.status(200).json({ ok: true, count: upsertRows.length });
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
  special_days:                 { cols: ['id','year','month','day','day_type','is_closed','is_holiday','label'] },
  wednesday_types:              { cols: ['id','year','month','day','wed_type'] },
  thursday_types:               { cols: ['id','year','month','day','is_open'] },
  shift_request_deadline_rules: { cols: ['id','dept_id','days_before','hour','minute','months_before'] },
  shift_request_limits_default: { cols: ['id','dept_id','limit_kibou_kyu','limit_yukyu','limit_other'] },
  beginner_limits:              { cols: ['id','dept_id','period_id','day_type','max_beginners'] },
  app_settings:                 { cols: ['id','key','value'] },
  dept_shift_pattern_settings:  { cols: ['id','dept_id','enabled_patterns'] },
  // 日付メモ（部門×年月日ごと。タイトル10字/詳細500字）。
  //   書き込みは settingsGateway により leader/master のみ。読み取りは全ロール（スタッフ画面の表示用）。
  day_notes:                    { cols: ['id','dept_id','year','month','day','title','detail'] },
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

// ===== カレンダー機能（calendars / calendar_members / calendar_prefs / events / ical_feed_settings）=====
// モデル: 予定はどれかの「カレンダー」に属する（TimeTree型）。
//   カレンダーの visibility: 'private'(所有者のみ) / 'members'(参加者のみ) / 'all'(全体)
//   メンバー管理・名前変更・削除はカレンダー所有者（＋master）のみ。
//   表示/非表示は calendar_prefs で各自が制御（データは消えない）。
// 段階公開: app_settings.calendar_release  0=masterのみ / 1=leaderまで / 2=全員（行なし=0）
async function calendarReleaseLevel() {
  try {
    const rows = await sb(`app_settings?key=eq.calendar_release&select=value`);
    return rows && rows[0] ? (parseFloat(rows[0].value) || 0) : 0;
  } catch { return 0; }
}
// 実効ティア判定。
// スタッフ画面のログインは role='staff' のアカウント限定（auth.js の照合条件）なので、
// トークンの role だけでは master/leader 本人の試験利用を判定できない。
// 同じ staff_id に紐づく別アカウント（leader/master の二重アカウント運用）まで見て実効ロールを決める。
async function calendarEffectiveTier(payload) {
  if (payload.role === 'master') return 'master';
  let tier = payload.role === 'leader' ? 'leader' : 'staff';
  try {
    const acc = await resolveAccount(payload.accountId);
    if (acc && acc.staff_id) {
      const linked = await sb(`accounts?staff_id=eq.${encodeURIComponent(acc.staff_id)}&select=role`);
      const roles = (linked || []).map(x => x.role);
      if (roles.includes('master')) return 'master';
      if (roles.includes('leader')) tier = 'leader';
    }
  } catch (e) { console.error('calendar tier resolve:', e); }
  return tier;
}
function calendarTierAllowed(tier, level) {
  if (tier === 'master') return true;
  if (tier === 'leader') return level >= 1;
  return level >= 2;
}
// タブ非表示だけに頼らず、APIを直接叩かれても公開レベル未満なら 403 にする
async function assertCalendarAccess(res, payload) {
  const level = await calendarReleaseLevel();
  const tier = await calendarEffectiveTier(payload);
  if (!calendarTierAllowed(tier, level)) {
    bad(res, 403, 'カレンダー機能は公開されていません');
    return false;
  }
  return true;
}

// クライアントがタブ表示可否を問い合わせる（ログイン直後に1回）
async function calendarAccess(res, payload) {
  const level = await calendarReleaseLevel();
  const tier = await calendarEffectiveTier(payload);
  // tier はクライアントの編集ボタン表示にも使う（権限の強制はあくまでサーバ側の各アクション）
  return res.status(200).json({ allowed: calendarTierAllowed(tier, level), level, tier });
}

const CAL_COLORS = ['blue', 'green', 'red', 'orange', 'purple', 'teal', 'pink', 'gray'];
const CAL_VISIBILITIES = ['private', 'members', 'all'];
// 名称注意: TIME_RE は休憩バリデーション用に既存。イベント用は別名にする
const EVENT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EVENT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 自分から見えるカレンダー一覧を返す（所有 / 参加 / 全体公開）。
// 個人用「マイカレンダー」が無ければ自動作成（全員が最初から1つ持てる）。
async function fetchVisibleCalendars(acc, tier) {
  let all = await sbAll('calendars?deleted_at=is.null&select=*', 'created_at,id');
  if (!all.some(c => c.visibility === 'private' && c.owner_account_id === acc.id)) {
    const created = await sb('calendars', { method: 'POST', body: JSON.stringify([{
      name: 'マイカレンダー', color: 'blue', visibility: 'private',
      owner_account_id: acc.id, owner_staff_id: acc.staff_id || null, owner_name: acc.name || null,
    }]) });
    all = all.concat(created || []);
  }
  let memSet = new Set();
  if (acc.staff_id) {
    const mem = await sb(`calendar_members?staff_id=eq.${encodeURIComponent(acc.staff_id)}&select=calendar_id`);
    memSet = new Set((mem || []).map(m => m.calendar_id));
  }
  const visible = all.filter(c =>
    c.visibility === 'all' ||
    c.owner_account_id === acc.id ||
    (c.visibility === 'members' && memSet.has(c.id))
  );
  const prefs = await sb(`calendar_prefs?account_id=eq.${encodeURIComponent(acc.id)}&select=calendar_id,hidden`);
  const hiddenSet = new Set((prefs || []).filter(p => p.hidden).map(p => p.calendar_id));
  return visible.map(c => ({
    id: c.id, name: c.name, color: c.color, visibility: c.visibility,
    owner_account_id: c.owner_account_id, owner_name: c.owner_name,
    is_owner: c.owner_account_id === acc.id,
    is_member: memSet.has(c.id),
    hidden: hiddenSet.has(c.id),
    can_post: c.visibility === 'all' ? true
      : c.visibility === 'members' ? (memSet.has(c.id) || c.owner_account_id === acc.id)
      : c.owner_account_id === acc.id,
    can_manage: c.owner_account_id === acc.id || tier === 'master',
  }));
}

async function calendarsList(res, payload) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  const tier = await calendarEffectiveTier(payload);
  const calendars = await fetchVisibleCalendars(acc, tier);
  return res.status(200).json({ calendars });
}

// カレンダー作成/更新。全体公開(all)の作成・変更はリーダー以上のみ
async function calendarSave(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  const tier = await calendarEffectiveTier(payload);
  const cal = body.calendar;
  if (!cal || typeof cal !== 'object' || Array.isArray(cal)) return bad(res, 400, 'calendar が不正です');

  const name = String(cal.name || '').trim().slice(0, 20);
  if (!name) return bad(res, 400, 'カレンダー名を入力してください');
  if (!CAL_VISIBILITIES.includes(cal.visibility)) return bad(res, 400, '公開種別が不正です');
  if (cal.visibility === 'all' && tier === 'staff') return bad(res, 403, '全体公開カレンダーはリーダー以上のみ作成できます');
  const color = CAL_COLORS.includes(cal.color) ? cal.color : 'blue';
  const memberIds = (cal.visibility === 'members' && Array.isArray(cal.member_staff_ids))
    ? (validStaffIds(cal.member_staff_ids, 200) || []) : null;

  if (cal.id) {
    if (typeof cal.id !== 'string' || !UUIDISH.test(cal.id)) return bad(res, 400, 'id が不正です');
    const cur = (await sb(`calendars?id=eq.${encodeURIComponent(cal.id)}&select=id,owner_account_id,deleted_at`))[0];
    if (!cur || cur.deleted_at) return bad(res, 404, 'カレンダーが見つかりません');
    if (cur.owner_account_id !== acc.id && tier !== 'master') return bad(res, 403, 'このカレンダーを編集する権限がありません');
    await sb(`calendars?id=eq.${encodeURIComponent(cal.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, color, visibility: cal.visibility, updated_at: new Date().toISOString() }),
    });
    if (memberIds !== null) {
      await sb(`calendar_members?calendar_id=eq.${encodeURIComponent(cal.id)}`, { method: 'DELETE' });
      if (memberIds.length) {
        await sb('calendar_members', { method: 'POST',
          body: JSON.stringify(memberIds.map(sid => ({ calendar_id: cal.id, staff_id: sid }))) });
      }
    }
    return res.status(200).json({ ok: true, id: cal.id });
  }

  const rows = await sb('calendars', { method: 'POST', body: JSON.stringify([{
    name, color, visibility: cal.visibility,
    owner_account_id: acc.id, owner_staff_id: acc.staff_id || null, owner_name: acc.name || null,
  }]) });
  const newId = rows && rows[0] ? rows[0].id : null;
  if (newId && memberIds && memberIds.length) {
    await sb('calendar_members', { method: 'POST',
      body: JSON.stringify(memberIds.map(sid => ({ calendar_id: newId, staff_id: sid }))) });
  }
  return res.status(200).json({ ok: true, id: newId });
}

// ===== カレンダー削除（ソフトデリート方式）=====
// 削除は「管理者（実効ティア master）」のみ。deleted_at を立てるだけで、
// 予定・メンバー・表示設定はそのまま残す＝30日以内なら復元で完全に元に戻る。
const CAL_TRASH_DAYS = 30;

// 30日を過ぎた削除済みカレンダーを物理削除（削除・ゴミ箱閲覧のタイミングで遅延実行）
async function purgeExpiredCalendars() {
  try {
    const limit = new Date(Date.now() - CAL_TRASH_DAYS * 24 * 3600 * 1000).toISOString();
    const expired = await sb(`calendars?deleted_at=lt.${encodeURIComponent(limit)}&select=id`);
    for (const c of expired || []) {
      const eid = encodeURIComponent(c.id);
      await sb(`events?calendar_id=eq.${eid}`, { method: 'DELETE' });
      await sb(`calendar_members?calendar_id=eq.${eid}`, { method: 'DELETE' });
      await sb(`calendar_prefs?calendar_id=eq.${eid}`, { method: 'DELETE' });
      await sb(`ical_feed_excludes?calendar_id=eq.${eid}`, { method: 'DELETE' });
      await sb(`calendars?id=eq.${eid}`, { method: 'DELETE' });
    }
  } catch (e) { console.error('calendar purge:', e); }
}

async function calendarDelete(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const tier = await calendarEffectiveTier(payload);
  if (tier !== 'master') return bad(res, 403, 'カレンダーの削除は管理者のみ行えます');
  const id = body.id;
  if (typeof id !== 'string' || !UUIDISH.test(id)) return bad(res, 400, 'id が不正です');
  await sb(`calendars?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  });
  await purgeExpiredCalendars();
  return res.status(200).json({ ok: true });
}

// 削除済み一覧（管理者のみ。残り日数付き）
async function calendarTrashList(res, payload) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const tier = await calendarEffectiveTier(payload);
  if (tier !== 'master') return bad(res, 403, '管理者のみ閲覧できます');
  await purgeExpiredCalendars();
  const rows = await sb(`calendars?deleted_at=not.is.null&select=id,name,color,visibility,owner_name,deleted_at&order=deleted_at.desc`);
  const now = Date.now();
  const trash = (rows || []).map(c => ({
    ...c,
    days_left: Math.max(0, CAL_TRASH_DAYS - Math.floor((now - new Date(c.deleted_at).getTime()) / 86400000)),
  }));
  return res.status(200).json({ trash });
}

// 復元（管理者のみ・30日以内）
async function calendarRestore(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const tier = await calendarEffectiveTier(payload);
  if (tier !== 'master') return bad(res, 403, 'カレンダーの復元は管理者のみ行えます');
  const id = body.id;
  if (typeof id !== 'string' || !UUIDISH.test(id)) return bad(res, 400, 'id が不正です');
  const cur = (await sb(`calendars?id=eq.${encodeURIComponent(id)}&select=id,deleted_at`))[0];
  if (!cur || !cur.deleted_at) return bad(res, 404, '削除済みカレンダーが見つかりません');
  if (Date.now() - new Date(cur.deleted_at).getTime() > CAL_TRASH_DAYS * 24 * 3600 * 1000) {
    return bad(res, 400, '削除から30日を過ぎているため復元できません');
  }
  await sb(`calendars?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ deleted_at: null, updated_at: new Date().toISOString() }),
  });
  return res.status(200).json({ ok: true });
}

// メンバー一覧（所有者・参加者のみ閲覧可）
async function calendarMembersList(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  const tier = await calendarEffectiveTier(payload);
  const id = body.calendar_id;
  if (typeof id !== 'string' || !UUIDISH.test(id)) return bad(res, 400, 'calendar_id が不正です');
  const cal = (await sb(`calendars?id=eq.${encodeURIComponent(id)}&select=id,owner_account_id,visibility`))[0];
  if (!cal) return bad(res, 404, 'カレンダーが見つかりません');
  const mem = await sb(`calendar_members?calendar_id=eq.${encodeURIComponent(id)}&select=staff_id`);
  const memIds = (mem || []).map(m => m.staff_id);
  const isOwner = cal.owner_account_id === acc.id;
  const isMember = acc.staff_id && memIds.includes(acc.staff_id);
  if (!isOwner && !isMember && tier !== 'master' && cal.visibility !== 'all') {
    return bad(res, 403, '閲覧権限がありません');
  }
  let members = [];
  if (memIds.length) {
    members = await sb(`staff?id=in.(${inFilter(memIds)})&select=id,name,dept_id&order=dept_id,staff_code`);
  }
  return res.status(200).json({ members });
}

// メンバー選択用の最小名簿（id・名前・部門のみ。ログイン画面が既に全氏名を公開している範囲を超えない）
async function staffDirectory(res, payload) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const rows = await sbAll('staff?select=id,name,dept_id', 'dept_id,staff_code');
  return res.status(200).json({ staff: rows });
}

// ===== 管理画面用: 全カレンダー一覧（管理者のみ）=====
// calendars-list と違い「マイカレンダー自動作成」を行わず、削除されていない全カレンダーを
// メンバー数・予定数付きで返す。個人カレンダーの中身（予定そのもの）は返さない。
async function calendarAdminList(res, payload) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const tier = await calendarEffectiveTier(payload);
  if (tier !== 'master') return bad(res, 403, '管理者のみ閲覧できます');
  const cals = await sbAll('calendars?deleted_at=is.null&select=id,name,color,visibility,owner_account_id,owner_name,created_at', 'created_at,id');
  const mems = await sbAll('calendar_members?select=calendar_id', 'calendar_id,staff_id');
  const evs = await sbAll('events?select=calendar_id', 'id');
  const memCount = {};
  (mems || []).forEach(m => { memCount[m.calendar_id] = (memCount[m.calendar_id] || 0) + 1; });
  const evCount = {};
  (evs || []).forEach(e => { if (e.calendar_id) evCount[e.calendar_id] = (evCount[e.calendar_id] || 0) + 1; });
  const calendars = cals.map(c => ({
    id: c.id, name: c.name, color: c.color, visibility: c.visibility,
    owner_account_id: c.owner_account_id, owner_name: c.owner_name, created_at: c.created_at,
    member_count: memCount[c.id] || 0, event_count: evCount[c.id] || 0,
  }));
  return res.status(200).json({ calendars });
}

// 管理画面用: 共有カレンダー（全体・メンバー限定）の月間予定（管理者のみ・閲覧用）
// 個人(private)カレンダーの予定は「本人以外に表示しない」方針のため、管理者にも返さない
async function calendarAdminEvents(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const tier = await calendarEffectiveTier(payload);
  if (tier !== 'master') return bad(res, 403, '管理者のみ閲覧できます');
  const year = body.year, month = body.month;
  if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
  const cals = await sbAll(
    'calendars?deleted_at=is.null&visibility=in.("all","members")&select=id,name,color,visibility,owner_name',
    'created_at,id');
  const mm = String(month).padStart(2, '0');
  const first = `${year}-${mm}-01`;
  const last = `${year}-${mm}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
  const rows = cals.length ? await sbAll(
    `events?start_date=lte.${last}&end_date=gte.${first}&calendar_id=in.(${inFilter(cals.map(c => c.id))})&select=*`,
    'start_date,id') : [];
  const calendars = cals.map(c => ({ ...c }));

  // リクエストした管理者本人の取り込みカレンダー（Google等）も合流させる。
  // レスポンスは本人ごとに生成されるため、他の管理者のGoogle予定が混ざることはない
  try {
    const acc = await resolveAccount(payload.accountId);
    if (acc) {
      const linkedIds = await extLinkedAccountIds(acc);
      const exts = await sb(`external_calendars?account_id=in.(${inFilter(linkedIds)})&select=*`);
      const refreshed = await Promise.all((exts || []).map(c => extRefresh(c)));
      for (const c of refreshed) {
        calendars.push({ id: c.id, name: c.name, color: c.color, visibility: 'external', owner_name: null, external: true, last_error: c.last_error || null });
        const inst = extExpand(c.cache || [], first, last);
        inst.forEach((m, i) => rows.push({
          id: `ext-${c.id}-${i}`, calendar_id: c.id, title: m.title,
          start_date: m.sd, end_date: m.ed, start_time: m.st, end_time: m.et,
          location: m.location, url: m.url, memo: null, external: true,
        }));
      }
    }
  } catch (e) { console.error('admin external merge:', e); }
  return res.status(200).json({ rows, calendars });
}

// 表示/非表示の切替（本人の表示設定のみ）
async function calendarPrefSave(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  const id = body.calendar_id;
  if (typeof id !== 'string' || !UUIDISH.test(id)) return bad(res, 400, 'calendar_id が不正です');
  const hidden = body.hidden === true;
  await sb(`calendar_prefs?account_id=eq.${encodeURIComponent(acc.id)}&calendar_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  await sb('calendar_prefs', { method: 'POST',
    body: JSON.stringify([{ account_id: acc.id, calendar_id: id, hidden }]) });
  return res.status(200).json({ ok: true });
}

// 月に重なる予定＋見えるカレンダー一覧を返す（1往復で描画に必要な全て）
async function eventsList(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const year = body.year, month = body.month;
  if (!intOk(year, 2000, 2100) || !intOk(month, 1, 12)) return bad(res, 400, 'year/month が不正です');
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  const tier = await calendarEffectiveTier(payload);
  const calendars = await fetchVisibleCalendars(acc, tier);
  if (!calendars.length) return res.status(200).json({ rows: [], calendars });
  const mm = String(month).padStart(2, '0');
  const first = `${year}-${mm}-01`;
  const last = `${year}-${mm}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
  const ids = calendars.map(c => c.id);
  const rows = await sbAll(
    `events?start_date=lte.${last}&end_date=gte.${first}&calendar_id=in.(${inFilter(ids)})&select=*`,
    'start_date,id');

  // 外部カレンダー（本人のみ・読み取り専用）をカレンダー一覧と予定に合流させる
  try {
    const linkedIds = await extLinkedAccountIds(acc);
    const exts = await sb(`external_calendars?account_id=in.(${inFilter(linkedIds)})&select=*`);
    if (exts && exts.length) {
      const prefs2 = await sb(`calendar_prefs?account_id=eq.${encodeURIComponent(acc.id)}&hidden=eq.true&select=calendar_id`);
      const hidden2 = new Set((prefs2 || []).map(x => x.calendar_id));
      const refreshed = await Promise.all(exts.map(c => extRefresh(c)));
      for (const c of refreshed) {
        calendars.push({
          id: c.id, name: c.name, color: c.color, visibility: 'external', external: true,
          owner_account_id: acc.id, owner_name: null, is_owner: true, is_member: false,
          hidden: hidden2.has(c.id), can_post: false, can_manage: false, last_error: c.last_error || null,
        });
        const inst = extExpand(c.cache || [], first, last);
        inst.forEach((m, i) => rows.push({
          id: `ext-${c.id}-${i}`, calendar_id: c.id, title: m.title,
          start_date: m.sd, end_date: m.ed, start_time: m.st, end_time: m.et,
          location: m.location, url: m.url, memo: null, external: true,
        }));
      }
    }
  } catch (e) { console.error('external calendars merge:', e); }
  return res.status(200).json({ rows, calendars });
}

// 予定の新規/更新。所有者はトークンから強制（自己申告不可）
async function eventsSave(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  const tier = await calendarEffectiveTier(payload);
  const ev = body.event;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return bad(res, 400, 'event が不正です');

  const title = String(ev.title || '').trim().slice(0, 30);
  if (!title) return bad(res, 400, 'タイトルを入力してください');
  if (typeof ev.calendar_id !== 'string' || !UUIDISH.test(ev.calendar_id)) return bad(res, 400, 'カレンダーを選択してください');
  const startDate = ev.start_date;
  const endDate = ev.end_date || ev.start_date;
  if (typeof startDate !== 'string' || !EVENT_DATE_RE.test(startDate)) return bad(res, 400, '開始日が不正です');
  if (typeof endDate !== 'string' || !EVENT_DATE_RE.test(endDate)) return bad(res, 400, '終了日が不正です');
  if (endDate < startDate) return bad(res, 400, '終了日は開始日以降にしてください');
  let startTime = ev.start_time || null;
  let endTime = ev.end_time || null;
  if (startTime != null && !EVENT_TIME_RE.test(startTime)) return bad(res, 400, '開始時刻が不正です');
  if (endTime != null && !EVENT_TIME_RE.test(endTime)) return bad(res, 400, '終了時刻が不正です');
  if (startTime == null) endTime = null; // 開始時刻なし = 終日

  // URL（任意）。リンクとして表示するため http/https のみ許可（javascript: 等の注入を遮断）
  const url = String(ev.url || '').trim().slice(0, 300);
  if (url && !/^https?:\/\/\S+$/i.test(url)) {
    return bad(res, 400, 'URLは http:// または https:// で始まる形式で入力してください');
  }

  // 投稿先カレンダーの権限チェック
  const cal = (await sb(`calendars?id=eq.${encodeURIComponent(ev.calendar_id)}&select=id,owner_account_id,visibility,color,deleted_at`))[0];
  if (!cal || cal.deleted_at) return bad(res, 404, 'カレンダーが見つかりません');
  let canPost = false;
  if (cal.visibility === 'all') canPost = true;
  else if (cal.owner_account_id === acc.id) canPost = true;
  else if (cal.visibility === 'members' && acc.staff_id) {
    const m = await sb(`calendar_members?calendar_id=eq.${encodeURIComponent(cal.id)}&staff_id=eq.${encodeURIComponent(acc.staff_id)}&select=staff_id`);
    canPost = (m && m.length > 0);
  }
  if (!canPost) return bad(res, 403, 'このカレンダーに予定を追加する権限がありません');

  const record = {
    calendar_id: cal.id,
    title,
    start_date: startDate,
    end_date: endDate,
    start_time: startTime,
    end_time: endTime,
    location: String(ev.location || '').slice(0, 100) || null,
    url: url || null,
    memo: String(ev.memo || '').slice(0, 500) || null,
    color: CAL_COLORS.includes(ev.color) ? ev.color : (cal.color || 'blue'),
    updated_at: new Date().toISOString(),
  };

  if (ev.id) {
    if (typeof ev.id !== 'string' || !UUIDISH.test(ev.id)) return bad(res, 400, 'id が不正です');
    const cur = (await sb(`events?id=eq.${encodeURIComponent(ev.id)}&select=id,owner_account_id,calendar_id`))[0];
    if (!cur) return bad(res, 404, '予定が見つかりません');
    // 編集権: 予定の作成者本人 / 所属カレンダーの所有者 / master
    const curCal = (cur.calendar_id === cal.id) ? cal
      : (await sb(`calendars?id=eq.${encodeURIComponent(cur.calendar_id)}&select=id,owner_account_id`))[0];
    const allowed = cur.owner_account_id === acc.id
      || (curCal && curCal.owner_account_id === acc.id)
      || tier === 'master';
    if (!allowed) return bad(res, 403, 'この予定を編集する権限がありません');
    const rows = await sb(`events?id=eq.${encodeURIComponent(ev.id)}`, { method: 'PATCH', body: JSON.stringify(record) });
    return res.status(200).json({ ok: true, rows });
  }

  record.owner_account_id = acc.id;
  record.owner_staff_id = acc.staff_id || null;
  record.owner_name = acc.name || null;
  const rows = await sb('events', { method: 'POST', body: JSON.stringify([record]) });
  return res.status(200).json({ ok: true, rows });
}

async function eventsDelete(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  const tier = await calendarEffectiveTier(payload);
  const id = body.id;
  if (typeof id !== 'string' || !UUIDISH.test(id)) return bad(res, 400, 'id が不正です');
  const cur = (await sb(`events?id=eq.${encodeURIComponent(id)}&select=id,owner_account_id,calendar_id`))[0];
  if (!cur) return res.status(200).json({ ok: true }); // 既に無い＝成功扱い
  const cal = (await sb(`calendars?id=eq.${encodeURIComponent(cur.calendar_id)}&select=id,owner_account_id`))[0];
  const allowed = cur.owner_account_id === acc.id
    || (cal && cal.owner_account_id === acc.id)
    || tier === 'master';
  if (!allowed) return bad(res, 403, 'この予定を削除する権限がありません');
  await sb(`events?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.status(200).json({ ok: true });
}

// ===== 外部カレンダー取り込み（Google等の非公開ICS URL・読み取り専用）=====
// 本人のアカウントにのみ表示する。ical.js のフィード（アプリ→外部）には含めない＝ループ防止。
const EXT_CAL_MAX = 3;
const EXT_FETCH_TTL_MS = 15 * 60 * 1000; // 取得キャッシュ15分
const EXT_MAX_BYTES = 5 * 1024 * 1024;
const EXT_MAX_EVENTS = 2000;

function extUrlOk(u) {
  let parsed;
  try { parsed = new URL(String(u)); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  const h = parsed.hostname.toLowerCase();
  // SSRF対策: IPリテラル・内部ホスト名は拒否
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.startsWith('[')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  return true;
}

const extMs = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const extYmd = (ms) => { const dt = new Date(ms); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`; };
const extAddDays = (ymd, n) => extYmd(extMs(ymd) + n * 86400000);
const extDiffDays = (a, b) => Math.round((extMs(b) - extMs(a)) / 86400000);

function icsUnescape(v) {
  return String(v).replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\');
}

// ICSの日時値をJSTの {date, time} に変換。
// UTC(Z)は+9時間。TZID付き・浮動時刻はそのまま採用（日本のGoogleカレンダーは Asia/Tokyo で出力）。
function icsToJst(val, params) {
  const v = String(val).trim();
  if ((params && params.VALUE === 'DATE') || /^\d{8}$/.test(v)) {
    if (!/^\d{8}/.test(v)) return null;
    return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, time: null };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  if (m[7] === 'Z') {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + 9 * 3600000;
    const dt = new Date(ms);
    return { date: extYmd(ms), time: `${String(dt.getUTCHours()).padStart(2, '0')}:${String(dt.getUTCMinutes()).padStart(2, '0')}` };
  }
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}

// ICSテキスト → VEVENT配列（行の折返し復元込み）
function parseIcsEvents(text) {
  const raw = text.split(/\r?\n/);
  const lines = [];
  for (const ln of raw) {
    if ((ln.startsWith(' ') || ln.startsWith('\t')) && lines.length) lines[lines.length - 1] += ln.slice(1);
    else lines.push(ln);
  }
  const events = [];
  let cur = null;
  for (const ln of lines) {
    if (ln === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (ln === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const ci = ln.indexOf(':');
    if (ci < 0) continue;
    const left = ln.slice(0, ci);
    const val = ln.slice(ci + 1);
    const parts = left.split(';');
    const prop = parts[0].toUpperCase();
    const params = {};
    for (let i = 1; i < parts.length; i++) {
      const eq = parts[i].indexOf('=');
      if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
    }
    if (prop === 'UID') cur.uid = val;
    else if (prop === 'SUMMARY') cur.title = icsUnescape(val);
    else if (prop === 'LOCATION') cur.location = icsUnescape(val);
    else if (prop === 'URL') cur.url = val;
    else if (prop === 'STATUS') cur.cancelled = /CANCELLED/i.test(val);
    else if (prop === 'RRULE') cur.rrule = val;
    else if (prop === 'DTSTART') cur.start = icsToJst(val, params);
    else if (prop === 'DTEND') cur.end = icsToJst(val, params);
    else if (prop === 'EXDATE') val.split(',').forEach(x => { const d = icsToJst(x, params); if (d) cur.exdates.push(d.date); });
    else if (prop === 'RECURRENCE-ID') { const d = icsToJst(val, params); cur.recurId = d ? d.date : null; }
  }
  return events;
}

// パース結果をキャッシュ用の最小形に変換（繰り返し以外は過去1年〜先2年に間引く）
function extDigest(events) {
  const today = extYmd(Date.now());
  const lo = extAddDays(today, -366);
  const hi = extAddDays(today, 731);
  const out = [];
  for (const e of events) {
    if (!e.start || !e.title) continue;
    const allday = !e.start.time;
    const sd = e.start.date;
    let ed = e.end ? e.end.date : sd;
    if (allday && e.end) ed = extAddDays(e.end.date, -1); // 終日DTENDは翌日日付（排他）→ 実終了日へ
    if (ed < sd) ed = sd;
    const rec = {
      uid: e.uid ? String(e.uid).slice(0, 200) : '',
      title: String(e.title).slice(0, 60),
      location: e.location ? String(e.location).slice(0, 100) : null,
      url: (e.url && /^https?:\/\/\S+$/i.test(e.url)) ? String(e.url).slice(0, 300) : null,
      sd, st: e.start.time || null, ed, et: (e.end && e.end.time) || null,
      rrule: e.rrule ? String(e.rrule).slice(0, 300) : null,
      ex: (e.exdates || []).slice(0, 100),
      rid: e.recurId || null,
      x: !!e.cancelled,
    };
    if (!rec.rrule && !rec.rid && (rec.ed < lo || rec.sd > hi)) continue;
    out.push(rec);
    if (out.length >= EXT_MAX_EVENTS) break;
  }
  return out;
}

function parseRrule(str) {
  const r = {};
  String(str).split(';').forEach(pp => { const i = pp.indexOf('='); if (i > 0) r[pp.slice(0, i).toUpperCase()] = pp.slice(i + 1); });
  return r;
}
const EXT_DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// 月内のn番目の曜日（n<0は末尾から）。該当なしは null
function extNthWeekday(y, mo, dowIdx, n) {
  const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const hits = [];
  for (let d = 1; d <= daysIn; d++) {
    if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === dowIdx) hits.push(d);
  }
  return (n > 0 ? hits[n - 1] : hits[hits.length + n]) || null;
}

// RRULE を [first..last] に展開。FREQ=DAILY/WEEKLY/MONTHLY/YEARLY、
// INTERVAL / BYDAY / BYMONTHDAY / COUNT / UNTIL に対応（EXDATEはCOUNTに数えたうえで除外＝RFC5545準拠）
function extOccurrences(m, first, last, skipSet) {
  const out = [];
  const r = parseRrule(m.rrule);
  const freq = r.FREQ;
  const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1);
  const count = r.COUNT ? (parseInt(r.COUNT, 10) || null) : null;
  let until = null;
  if (r.UNTIL && /^\d{8}/.test(r.UNTIL)) until = `${r.UNTIL.slice(0, 4)}-${r.UNTIL.slice(4, 6)}-${r.UNTIL.slice(6, 8)}`;
  const durDays = extDiffDays(m.sd, m.ed);
  let made = 0;
  const emit = (d) => {
    made++;
    if (skipSet.has(d) || (m.ex || []).includes(d)) return;
    const ed2 = extAddDays(d, durDays);
    if (d <= last && ed2 >= first) out.push({ ...m, sd: d, ed: ed2 });
  };

  if (freq === 'DAILY' || freq === 'WEEKLY') {
    const startMs = extMs(m.sd);
    const startDow = new Date(startMs).getUTCDay();
    const byday = (freq === 'WEEKLY' && r.BYDAY)
      ? r.BYDAY.split(',').map(x => x.slice(-2)) : [EXT_DOW[startDow]];
    for (let i = 0; i < 16000; i++) {
      const d = extYmd(startMs + i * 86400000);
      if (d > last || (until && d > until)) break;
      if (freq === 'DAILY') {
        if (i % interval === 0) emit(d);
      } else {
        const weekIdx = Math.floor((i + startDow) / 7);
        if (weekIdx % interval === 0 && byday.includes(EXT_DOW[(startDow + i) % 7])) emit(d);
      }
      if (count && made >= count) break;
    }
  } else if (freq === 'MONTHLY') {
    const sy = parseInt(m.sd.slice(0, 4), 10);
    const sm = parseInt(m.sd.slice(5, 7), 10);
    const sday = parseInt(m.sd.slice(8, 10), 10);
    const bydayM = r.BYDAY ? /^(-?\d)([A-Z]{2})$/.exec(r.BYDAY) : null;
    const bymd = r.BYMONTHDAY ? parseInt(r.BYMONTHDAY, 10) : null;
    for (let k = 0; k < 600; k++) {
      if (k % interval !== 0) continue;
      const total = (sm - 1) + k;
      const y = sy + Math.floor(total / 12);
      const mo = (total % 12) + 1;
      let day = null;
      if (bydayM) day = extNthWeekday(y, mo, EXT_DOW.indexOf(bydayM[2]), parseInt(bydayM[1], 10));
      else {
        const want = bymd || sday;
        const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        day = want <= daysIn ? want : null;
      }
      if (day == null) continue;
      const d = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (d < m.sd) continue;
      if (d > last || (until && d > until)) break;
      emit(d);
      if (count && made >= count) break;
    }
  } else if (freq === 'YEARLY') {
    const sy = parseInt(m.sd.slice(0, 4), 10);
    for (let k = 0; k < 100; k += interval) {
      const d = `${sy + k}${m.sd.slice(4)}`;
      if (d > last || (until && d > until)) break;
      emit(d);
      if (count && made >= count) break;
    }
  }
  return out;
}

// キャッシュを月範囲に展開（RECURRENCE-ID上書き・STATUS:CANCELLED対応）
function extExpand(cache, first, last) {
  const rows = [];
  const overr = {};
  for (const m of cache || []) if (m.rid && m.uid) (overr[m.uid] = overr[m.uid] || new Set()).add(m.rid);
  for (const m of cache || []) {
    if (m.x) continue; // キャンセル済み
    if (m.rid || !m.rrule) {
      if (m.sd <= last && m.ed >= first) rows.push(m);
      continue;
    }
    rows.push(...extOccurrences(m, first, last, overr[m.uid] || new Set()));
  }
  return rows;
}

async function extFetchAndDigest(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const resp = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!resp.ok) throw new Error(`取得失敗（HTTP ${resp.status}）`);
    const text = await resp.text();
    if (text.length > EXT_MAX_BYTES) throw new Error('カレンダーデータが大きすぎます');
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('iCal形式のURLではありません');
    return extDigest(parseIcsEvents(text));
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('取得がタイムアウトしました');
    throw e;
  } finally { clearTimeout(t); }
}

// キャッシュが15分より古ければ再取得（失敗時は旧キャッシュ維持＋エラー記録。次の再試行も15分後）
async function extRefresh(cal) {
  const stale = !cal.last_fetched_at || (Date.now() - new Date(cal.last_fetched_at).getTime() > EXT_FETCH_TTL_MS);
  if (!stale) return cal;
  try {
    const cache = await extFetchAndDigest(cal.ics_url);
    const upd = { cache, last_fetched_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() };
    await sb(`external_calendars?id=eq.${encodeURIComponent(cal.id)}`, { method: 'PATCH', body: JSON.stringify(upd) });
    return { ...cal, ...upd };
  } catch (e) {
    const upd = { last_fetched_at: new Date().toISOString(), last_error: String(e.message || e).slice(0, 200), updated_at: new Date().toISOString() };
    try { await sb(`external_calendars?id=eq.${encodeURIComponent(cal.id)}`, { method: 'PATCH', body: JSON.stringify(upd) }); } catch {}
    return { ...cal, ...upd };
  }
}

// 同一スタッフに紐付く全アカウントID（master/leader/staff の二重アカウント運用対応）。
// 取り込みカレンダーは「本人単位」で共有する＝スタッフ画面で登録したものが管理画面にも出る
async function extLinkedAccountIds(acc) {
  if (!acc.staff_id) return [acc.id];
  try {
    const linked = await sb(`accounts?staff_id=eq.${encodeURIComponent(acc.staff_id)}&select=id`);
    const ids = (linked || []).map(x => x.id);
    return ids.includes(acc.id) ? ids : ids.concat([acc.id]);
  } catch { return [acc.id]; }
}

// 取り込みカレンダーの一覧（本人の紐付きアカウント全体）
async function extCalList(res, payload) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  const linkedIds = await extLinkedAccountIds(acc);
  const externals = await sb(
    `external_calendars?account_id=in.(${inFilter(linkedIds)})&select=id,name,color,ics_url,last_error,last_fetched_at&order=created_at`);
  return res.status(200).json({ externals: externals || [] });
}

// 取り込みカレンダーの追加/更新（本人のみ・最大3件。保存時に即取得して検証する）
async function extCalSave(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  const name = String(body.name || '').trim().slice(0, 20) || 'Googleカレンダー';
  const color = CAL_COLORS.includes(body.color) ? body.color : 'teal';
  const icsUrl = String(body.ics_url || '').trim().slice(0, 500);
  if (!extUrlOk(icsUrl)) return bad(res, 400, 'URLが不正です（https:// のiCal URLを貼り付けてください）');
  let cache;
  try { cache = await extFetchAndDigest(icsUrl); }
  catch (e) { return bad(res, 400, `カレンダーを取得できません：${e.message || e}`); }
  const now = new Date().toISOString();

  const linkedIds = await extLinkedAccountIds(acc);
  if (body.id) {
    if (typeof body.id !== 'string' || !UUIDISH.test(body.id)) return bad(res, 400, 'id が不正です');
    const cur = (await sb(`external_calendars?id=eq.${encodeURIComponent(body.id)}&select=id,account_id`))[0];
    if (!cur || !linkedIds.includes(cur.account_id)) return bad(res, 404, '取り込みカレンダーが見つかりません');
    await sb(`external_calendars?id=eq.${encodeURIComponent(body.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, color, ics_url: icsUrl, cache, last_fetched_at: now, last_error: null, updated_at: now }),
    });
    return res.status(200).json({ ok: true, id: body.id, event_count: cache.length });
  }

  const mine = await sb(`external_calendars?account_id=in.(${inFilter(linkedIds)})&select=id`);
  if ((mine || []).length >= EXT_CAL_MAX) return bad(res, 400, `取り込みカレンダーは${EXT_CAL_MAX}件までです`);
  const rows = await sb('external_calendars', {
    method: 'POST',
    body: JSON.stringify([{ account_id: acc.id, name, color, ics_url: icsUrl, cache, last_fetched_at: now }]),
  });
  return res.status(200).json({ ok: true, id: rows && rows[0] ? rows[0].id : null, event_count: cache.length });
}

async function extCalDelete(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  const id = body.id;
  if (typeof id !== 'string' || !UUIDISH.test(id)) return bad(res, 400, 'id が不正です');
  const cur = (await sb(`external_calendars?id=eq.${encodeURIComponent(id)}&select=id,account_id`))[0];
  const linkedIds = await extLinkedAccountIds(acc);
  if (!cur || !linkedIds.includes(cur.account_id)) return res.status(200).json({ ok: true }); // 既に無い＝成功扱い
  await sb(`calendar_prefs?calendar_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  await sb(`external_calendars?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.status(200).json({ ok: true });
}

// ===== ICS購読フィード設定（本人分のみ）=====
function newFeedToken() { return crypto.randomBytes(32).toString('hex'); }

async function icalSettingsGet(res, payload) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc) return bad(res, 401, 'アカウントが見つかりません');
  if (!acc.staff_id) return res.status(200).json({ linked: false }); // スタッフ未紐付け → 連携不可の案内表示用
  let row = (await sb(`ical_feed_settings?staff_id=eq.${encodeURIComponent(acc.staff_id)}&select=*`))[0];
  if (!row) {
    // 初回アクセス時に自動生成
    row = (await sb('ical_feed_settings', {
      method: 'POST',
      body: JSON.stringify([{ staff_id: acc.staff_id, token: newFeedToken() }]),
    }))[0];
  }
  // フィード対象の選択UI用: 見えるカレンダー一覧と除外済みID
  const tier = await calendarEffectiveTier(payload);
  const cals = await fetchVisibleCalendars(acc, tier);
  const excl = await sb(`ical_feed_excludes?staff_id=eq.${encodeURIComponent(acc.staff_id)}&select=calendar_id`);
  const linkedIds2 = await extLinkedAccountIds(acc);
  const externals = await sb(
    `external_calendars?account_id=in.(${inFilter(linkedIds2)})&select=id,name,color,ics_url,last_error,last_fetched_at&order=created_at`);
  return res.status(200).json({
    linked: true, settings: row,
    calendars: cals.map(c => ({ id: c.id, name: c.name, color: c.color, visibility: c.visibility })),
    excluded: (excl || []).map(x => x.calendar_id),
    externals: externals || [],
  });
}

async function icalSettingsSave(res, payload, body) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc || !acc.staff_id) return bad(res, 400, 'スタッフ未紐付けのアカウントです');
  const upd = { updated_at: new Date().toISOString() };
  for (const k of ['include_shifts', 'enabled']) {
    if (typeof body[k] === 'boolean') upd[k] = body[k];
  }
  // フィードから除外するカレンダー（配列ごと置き換え。行がない = 送信する）
  if (Array.isArray(body.excluded_calendar_ids)) {
    const ids = body.excluded_calendar_ids;
    if (ids.length > 200) return bad(res, 400, '選択が多すぎます');
    for (const x of ids) {
      if (typeof x !== 'string' || !UUIDISH.test(x)) return bad(res, 400, 'calendar_id が不正です');
    }
    await sb(`ical_feed_excludes?staff_id=eq.${encodeURIComponent(acc.staff_id)}`, { method: 'DELETE' });
    if (ids.length) {
      await sb('ical_feed_excludes', { method: 'POST',
        body: JSON.stringify(ids.map(cid => ({ staff_id: acc.staff_id, calendar_id: cid }))) });
    }
  }
  const rows = await sb(`ical_feed_settings?staff_id=eq.${encodeURIComponent(acc.staff_id)}`, {
    method: 'PATCH', body: JSON.stringify(upd),
  });
  return res.status(200).json({ ok: true, settings: rows[0] || null });
}

// URL再発行: token を差し替え＝旧URLは即404
async function icalTokenRotate(res, payload) {
  if (!(await assertCalendarAccess(res, payload))) return;
  const acc = await resolveAccount(payload.accountId);
  if (!acc || !acc.staff_id) return bad(res, 400, 'スタッフ未紐付けのアカウントです');
  const rows = await sb(`ical_feed_settings?staff_id=eq.${encodeURIComponent(acc.staff_id)}`, {
    method: 'PATCH', body: JSON.stringify({ token: newFeedToken(), updated_at: new Date().toISOString() }),
  });
  return res.status(200).json({ ok: true, settings: rows[0] || null });
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
    // カレンダー機能（段階公開の判定は各関数内で実施）
    if (action === 'calendar-access') return await calendarAccess(res, payload);
    if (action === 'calendars-list') return await calendarsList(res, payload);
    if (action === 'calendar-save') return await calendarSave(res, payload, body);
    if (action === 'calendar-delete') return await calendarDelete(res, payload, body);
    if (action === 'calendar-trash-list') return await calendarTrashList(res, payload);
    if (action === 'calendar-admin-list') return await calendarAdminList(res, payload);
    if (action === 'calendar-admin-events') return await calendarAdminEvents(res, payload, body);
    if (action === 'calendar-restore') return await calendarRestore(res, payload, body);
    if (action === 'calendar-members-list') return await calendarMembersList(res, payload, body);
    if (action === 'calendar-pref-save') return await calendarPrefSave(res, payload, body);
    if (action === 'staff-directory') return await staffDirectory(res, payload);
    if (action === 'events-list') return await eventsList(res, payload, body);
    if (action === 'events-save') return await eventsSave(res, payload, body);
    if (action === 'events-delete') return await eventsDelete(res, payload, body);
    if (action === 'ical-settings-get') return await icalSettingsGet(res, payload);
    if (action === 'ical-settings-save') return await icalSettingsSave(res, payload, body);
    if (action === 'ical-token-rotate') return await icalTokenRotate(res, payload);
    if (action === 'ext-cal-list') return await extCalList(res, payload);
    if (action === 'ext-cal-save') return await extCalSave(res, payload, body);
    if (action === 'ext-cal-delete') return await extCalDelete(res, payload, body);

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
        // 退職者対応: スタッフ削除に連動してICS購読フィードを失効（行ごと削除＝購読URLは即404）。
        // 先にフィードを消す: 万一スタッフ削除が失敗してもフィードは再発行すればよいだけで害がない。
        if (table === 'staff') {
          try { await sb(`ical_feed_settings?staff_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }); }
          catch (e) { console.error('ical feed cascade delete:', e); }
          try { await sb(`ical_feed_excludes?staff_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }); }
          catch (e) { console.error('ical excludes cascade delete:', e); }
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

// /api/mcp.js
// kingyo-shift の MCP サーバー（AIエージェント接続口）
//   Meta の Muse などの AI エージェントが、カスタムコネクタ（リモートMCP / Streamable HTTP）として接続する。
//
// 方針（院内で決めた範囲：閲覧＋下書きまで）
//   - 閲覧: 部署・スタッフ・シフト表・希望／未提出者
//   - 書き込み: 希望の反映・シフトの個別変更（下書き＝未確定で保存）。確定・公開と削除系は行わない
//   - 書き込みは二段階。confirm:true が無い呼び出しは「変更予定」を返すだけで何も保存しない
//   - 確定済みの月・ロック中のセルには書き込まない。部署は毎回 dept_id で指定（1部署ずつ）
//   - 書き込み内容は Vercel のログに [mcp-write] として残す
//
// 認証: Authorization: Bearer <KINGYO_MCP_KEY>（Vercel 環境変数。32文字以上。未設定なら接続口ごと無効）
// 方式: ステートレスな Streamable HTTP（POST の JSON-RPC に JSON で応答。セッション・SSE なし）

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MCP_KEY = process.env.KINGYO_MCP_KEY || '';

const DEPT_NAMES = { 0: '医療事務', 1: '看護', 2: 'リハビリ', 3: '放射線' };
const OFF_SHIFTS = ['休み', '有休', '半有休', '個夏休', '希望休'];
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ===== Supabase =====
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`); }
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}
// 1000行上限対策の全件取得（data.js の sbAll と同じ考え方）
async function sbAll(path, order) {
  const sep = path.includes('?') ? '&' : '?';
  const out = [];
  let offset = 0;
  for (let i = 0; i < 50; i++) {
    const rows = await sb(`${path}${sep}order=${order}&limit=1000&offset=${offset}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  return out;
}
const inFilter = ids => ids.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');

// ===== 入力チェック =====
class UserError extends Error {}
function intArg(v, min, max, name) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${name} は ${min}〜${max} の整数で指定してください`);
  return n;
}
function ymdArgs(a) {
  return {
    dept: intArg(a.dept_id, 0, 3, 'dept_id'),
    year: intArg(a.year, 2020, 2100, 'year'),
    month: intArg(a.month, 1, 12, 'month'),
  };
}
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const dowJp = (y, m, d) => ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];

// ===== 共通データ =====
async function deptStaff(dept) {
  const rows = await sb(`staff?dept_id=eq.${dept}&select=id,name,staff_code,emp_type,display_order`);
  return (rows || []).sort((a, b) =>
    ((a.display_order ?? 99999) - (b.display_order ?? 99999)) || ((a.staff_code ?? 0) - (b.staff_code ?? 0)));
}
async function shiftTypes() {
  return (await sb('shift_types?select=id,label,is_off,is_active,start_time,end_time,work_hours')) || [];
}
async function monthState(staff, year, month) {
  if (!staff.length) return { shifts: [], locks: [], confirmed: false };
  const ids = inFilter(staff.map(s => s.id));
  const [shifts, locks] = await Promise.all([
    sbAll(`shifts?staff_id=in.(${ids})&year=eq.${year}&month=eq.${month}&select=staff_id,day,shift_type_id,is_locked,is_confirmed,cell_label`, 'staff_id,day'),
    sb(`cell_locks?staff_id=in.(${ids})&year=eq.${year}&month=eq.${month}&select=staff_id,day`).catch(() => []),
  ]);
  return { shifts, locks: locks || [], confirmed: shifts.some(s => s.is_confirmed === true) };
}
// 休診日（管理画面の一括埋めと同じ判定）：special_days.is_closed=true / 木曜は診療木曜の設定が無ければ休診
async function closedDays(year, month) {
  const [sp, th] = await Promise.all([
    sb(`special_days?year=eq.${year}&month=eq.${month}&select=day,is_closed`),
    sb(`thursday_types?year=eq.${year}&month=eq.${month}&select=day,is_open`),
  ]);
  const closed = new Set((sp || []).filter(s => s.is_closed).map(s => s.day));
  const openThu = new Set((th || []).filter(t => t.is_open).map(t => t.day));
  for (let d = 1; d <= daysIn(year, month); d++) {
    if (new Date(year, month - 1, d).getDay() === 4 && !openThu.has(d)) closed.add(d);
  }
  return closed;
}
function lockedSet(state) {
  const s = new Set(state.locks.map(l => `${l.staff_id}|${l.day}`));
  state.shifts.forEach(r => { if (r.is_locked) s.add(`${r.staff_id}|${r.day}`); });
  return s;
}

// ===== ツール定義 =====
const DEPT_PROP = { type: 'integer', minimum: 0, maximum: 3, description: '部署ID（0=医療事務, 1=看護, 2=リハビリ, 3=放射線）' };
const YM_PROPS = {
  dept_id: DEPT_PROP,
  year: { type: 'integer', description: '年（例: 2026）' },
  month: { type: 'integer', minimum: 1, maximum: 12, description: '月（1〜12）' },
};
const TOOLS = [
  {
    name: 'list_departments',
    description: '部署の一覧と、使えるシフト名（勤務・休み）の一覧を返す。最初に呼んで部署IDとシフト名を確認する。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_staff',
    description: '指定部署のスタッフ一覧（表示順）を返す。',
    inputSchema: { type: 'object', properties: { dept_id: DEPT_PROP }, required: ['dept_id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_shifts',
    description: '指定部署・年月のシフト表を返す。スタッフごとに日→シフト名、ロック中の日、月が確定済みかどうか。',
    inputSchema: { type: 'object', properties: YM_PROPS, required: ['dept_id', 'year', 'month'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_requests',
    description: '指定部署・年月のシフト希望（スタッフが提出したもの）と、未提出のスタッフを返す。',
    inputSchema: { type: 'object', properties: YM_PROPS, required: ['dept_id', 'year', 'month'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'apply_requests',
    description:
      '提出された希望をシフト表に反映する（下書き保存）。confirm を付けない呼び出しは変更予定を返すだけで保存しない。' +
      '内容を利用者に確認してから confirm:true で再度呼ぶこと。確定済みの月・ロック中のセル・休診日への勤務希望は対象外。' +
      '既に別のシフトが入っているセルは overwrite:true のときだけ上書きする。lock:true（既定）で反映したセルをロックする。',
    inputSchema: {
      type: 'object',
      properties: {
        ...YM_PROPS,
        overwrite: { type: 'boolean', description: '既に別のシフトが入っているセルも希望で上書きする（既定 false）' },
        lock: { type: 'boolean', description: '反映したセルと希望どおりのセルをロックする（既定 true）' },
        confirm: { type: 'boolean', description: 'true で実際に保存する。省略時は変更予定の確認のみ' },
      },
      required: ['dept_id', 'year', 'month'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'set_shifts',
    description:
      'シフト表のセルを個別に変更する（下書き保存）。confirm を付けない呼び出しは変更予定を返すだけで保存しない。' +
      '内容を利用者に確認してから confirm:true で再度呼ぶこと。確定済みの月・ロック中のセルは変更しない。shift に null を渡すとセルを空にする。',
    inputSchema: {
      type: 'object',
      properties: {
        ...YM_PROPS,
        changes: {
          type: 'array', minItems: 1, maxItems: 300,
          description: '変更内容の配列',
          items: {
            type: 'object',
            properties: {
              staff: { type: 'string', description: 'スタッフ名または staff_id（list_staff の値）' },
              day: { type: 'integer', minimum: 1, maximum: 31 },
              shift: { type: ['string', 'null'], description: 'シフト名（list_departments の id）。null でセルを空にする' },
            },
            required: ['staff', 'day', 'shift'], additionalProperties: false,
          },
        },
        lock: { type: 'boolean', description: '変更したセルをロックする（既定 false）' },
        confirm: { type: 'boolean', description: 'true で実際に保存する。省略時は変更予定の確認のみ' },
      },
      required: ['dept_id', 'year', 'month', 'changes'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
];

const INSTRUCTIONS =
  'やちよ総合診療クリニックのシフト管理アプリ「kingyo-shift」です。部署ごと（dept_id）・月ごとに操作します。\n' +
  '・書き込み（apply_requests / set_shifts）は必ず confirm なしで変更予定を出し、利用者の了承を得てから confirm:true で実行してください。\n' +
  '・保存は下書き（未確定）です。スタッフへの確定・公開は管理画面で人が行います。確定済みの月は変更できません。\n' +
  '・ロック中のセルは変更されません。シフト名は list_departments で確認してください。\n' +
  '・書き込み後は、管理画面でシフト表を開いている人に「再読み込み」を依頼してください（開いたままの画面から保存すると上書きされます）。';

// ===== ツール実装 =====
async function toolListDepartments() {
  const types = await shiftTypes();
  return {
    departments: Object.entries(DEPT_NAMES).map(([id, name]) => ({ dept_id: Number(id), name })),
    shift_types: types.filter(t => t.is_active !== false).map(t => ({
      id: t.id, label: t.label || t.id, kind: t.is_off ? '休み' : '勤務',
      time: (t.start_time && t.end_time) ? `${t.start_time}-${t.end_time}` : null,
    })),
  };
}

async function toolListStaff(a) {
  const dept = intArg(a.dept_id, 0, 3, 'dept_id');
  const staff = await deptStaff(dept);
  return { dept_id: dept, dept_name: DEPT_NAMES[dept], staff: staff.map(s => ({ staff_id: s.id, name: s.name, emp_type: s.emp_type })) };
}

async function toolGetShifts(a) {
  const { dept, year, month } = ymdArgs(a);
  const staff = await deptStaff(dept);
  const st = await monthState(staff, year, month);
  const locked = lockedSet(st);
  const byStaff = {};
  st.shifts.forEach(r => { (byStaff[r.staff_id] ||= {})[r.day] = r.shift_type_id || r.cell_label; });
  return {
    dept_name: DEPT_NAMES[dept], year, month, days: daysIn(year, month),
    confirmed: st.confirmed,
    note: st.confirmed ? 'この月は確定済み（スタッフに公開中）のため変更できません' : '下書き（未確定）です',
    staff: staff.map(s => ({
      staff_id: s.id, name: s.name,
      shifts: byStaff[s.id] || {},
      locked_days: [...locked].filter(k => k.startsWith(s.id + '|')).map(k => Number(k.split('|')[1])).sort((x, y) => x - y),
    })),
  };
}

async function toolGetRequests(a) {
  const { dept, year, month } = ymdArgs(a);
  const staff = await deptStaff(dept);
  if (!staff.length) return { dept_name: DEPT_NAMES[dept], year, month, staff: [], not_submitted: [] };
  const reqs = await sbAll(`shift_requests?staff_id=in.(${inFilter(staff.map(s => s.id))})&year=eq.${year}&month=eq.${month}&select=staff_id,day,request_type`, 'staff_id,day');
  const byStaff = {};
  reqs.forEach(r => { (byStaff[r.staff_id] ||= {})[r.day] = r.request_type; });
  return {
    dept_name: DEPT_NAMES[dept], year, month,
    staff: staff.filter(s => byStaff[s.id]).map(s => ({ staff_id: s.id, name: s.name, requests: byStaff[s.id] })),
    not_submitted: staff.filter(s => !byStaff[s.id]).map(s => s.name),
  };
}

// 書き込み共通：確定済みチェック・ロック・保存
async function writeCells({ dept, year, month, staff, cells, lockKeys, confirm, toolName, summary }) {
  if (!confirm) return { saved: false, ...summary, next: '内容を利用者に確認し、了承を得たら同じ引数に confirm:true を付けて再度呼んでください。' };
  if (!cells.length && !lockKeys.length) return { saved: false, ...summary, message: '保存する変更はありません' };

  // 保存直前にもう一度、確定済みでないか確認（確認〜実行の間に確定された場合の保護）
  const st = await monthState(staff, year, month);
  if (st.confirmed) throw new UserError('この月は確定済みになったため保存しませんでした。管理画面で確定を取り消してから再度お試しください');
  const locked = lockedSet(st);
  const curMap = new Map(st.shifts.map(r => [`${r.staff_id}|${r.day}`, r]));

  const upserts = [], deletes = [];
  for (const c of cells) {
    const key = `${c.staff_id}|${c.day}`;
    if (locked.has(key)) continue; // 確認後にロックされたセルは触らない
    const cur = curMap.get(key);
    const lock = lockKeys.includes(key);
    if (c.shift == null) { if (cur) deletes.push(key); continue; }
    upserts.push({ staff_id: c.staff_id, year, month, day: c.day, shift_type_id: c.shift,
                   is_locked: lock || !!(cur && cur.is_locked), is_confirmed: false, cell_label: cur ? cur.cell_label : null });
  }
  // 既に希望どおりでロックだけ付けるセル
  for (const key of lockKeys) {
    if (upserts.some(u => `${u.staff_id}|${u.day}` === key)) continue;
    const cur = curMap.get(key);
    if (cur && !cur.is_locked) upserts.push({ staff_id: cur.staff_id, year, month, day: cur.day, shift_type_id: cur.shift_type_id,
                                              is_locked: true, is_confirmed: false, cell_label: cur.cell_label });
  }
  if (upserts.length) {
    await sb('shifts?on_conflict=staff_id,year,month,day', {
      method: 'POST', headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(upserts),
    });
  }
  for (const key of deletes) {
    const [sid, d] = key.split('|');
    await sb(`shifts?staff_id=eq.${encodeURIComponent(sid)}&year=eq.${year}&month=eq.${month}&day=eq.${d}`, { method: 'DELETE' });
  }
  console.log(`[mcp-write] ${toolName} dept=${dept} ${year}-${month} upsert=${upserts.length} delete=${deletes.length}`,
    JSON.stringify(upserts.map(u => `${u.staff_id}|${u.day}=${u.shift_type_id}${u.is_locked ? '🔒' : ''}`).concat(deletes.map(k => `${k}=削除`))).slice(0, 4000));
  return { saved: true, ...summary, saved_cells: upserts.length, cleared_cells: deletes.length,
           message: '下書きとして保存しました。管理画面でシフト表を開いている人は再読み込みしてください。' };
}

async function toolApplyRequests(a) {
  const { dept, year, month } = ymdArgs(a);
  const overwrite = a.overwrite === true, lock = a.lock !== false, confirm = a.confirm === true;
  const staff = await deptStaff(dept);
  if (!staff.length) throw new UserError('この部署のスタッフがいません');
  const nameOf = Object.fromEntries(staff.map(s => [s.id, s.name]));
  const [st, reqs, types, closed] = await Promise.all([
    monthState(staff, year, month),
    sbAll(`shift_requests?staff_id=in.(${inFilter(staff.map(s => s.id))})&year=eq.${year}&month=eq.${month}&select=staff_id,day,request_type`, 'staff_id,day'),
    shiftTypes(),
    closedDays(year, month),
  ]);
  if (st.confirmed) throw new UserError(`${DEPT_NAMES[dept]} ${year}年${month}月は確定済みのため変更できません。管理画面で確定を取り消してください`);
  const valid = new Set(types.map(t => t.id).concat(OFF_SHIFTS));
  const locked = lockedSet(st);
  const cur = new Map(st.shifts.map(r => [`${r.staff_id}|${r.day}`, r.shift_type_id]));
  const nDays = daysIn(year, month);

  const toEmpty = [], toOverwrite = [], already = [], skipped = [];
  for (const r of reqs) {
    if (!r.request_type || r.day < 1 || r.day > nDays) continue;
    const key = `${r.staff_id}|${r.day}`;
    const label = `${nameOf[r.staff_id]} ${month}/${r.day}(${dowJp(year, month, r.day)}) ${r.request_type}`;
    if (!valid.has(r.request_type)) { skipped.push(`${label}（登録されていないシフト名）`); continue; }
    if (locked.has(key)) { skipped.push(`${label}（ロック中）`); continue; }
    if (!OFF_SHIFTS.includes(r.request_type) && closed.has(r.day)) { skipped.push(`${label}（休診日への勤務希望）`); continue; }
    const c = cur.get(key);
    if (c === r.request_type) { already.push(key); continue; }
    if (!c) toEmpty.push({ r, label }); else toOverwrite.push({ r, label: `${label}（現在: ${c}）` });
  }
  const targets = overwrite ? toEmpty.concat(toOverwrite) : toEmpty;
  const cells = targets.map(t => ({ staff_id: t.r.staff_id, day: t.r.day, shift: t.r.request_type }));
  const lockKeys = lock ? cells.map(c => `${c.staff_id}|${c.day}`).concat(already) : [];
  const summary = {
    dept_name: DEPT_NAMES[dept], year, month,
    fill_empty: toEmpty.map(t => t.label),
    overwrite_candidates: toOverwrite.map(t => t.label),
    overwrite_applied: overwrite,
    already_matching: already.length,
    skipped,
    lock,
  };
  return writeCells({ dept, year, month, staff, cells, lockKeys, confirm, toolName: 'apply_requests', summary });
}

async function toolSetShifts(a) {
  const { dept, year, month } = ymdArgs(a);
  const lock = a.lock === true, confirm = a.confirm === true;
  if (!Array.isArray(a.changes) || !a.changes.length) throw new UserError('changes を1件以上指定してください');
  if (a.changes.length > 300) throw new UserError('changes は1回300件までです');
  const staff = await deptStaff(dept);
  const [st, types] = await Promise.all([monthState(staff, year, month), shiftTypes()]);
  if (st.confirmed) throw new UserError(`${DEPT_NAMES[dept]} ${year}年${month}月は確定済みのため変更できません。管理画面で確定を取り消してください`);
  const valid = new Set(types.map(t => t.id).concat(OFF_SHIFTS));
  const locked = lockedSet(st);
  const cur = new Map(st.shifts.map(r => [`${r.staff_id}|${r.day}`, r.shift_type_id]));
  const nDays = daysIn(year, month);

  const cells = [], planned = [], rejected = [];
  for (const ch of a.changes) {
    const key0 = String(ch && ch.staff || '').trim();
    const hits = staff.filter(s => s.id === key0 || s.name === key0);
    const desc = `${key0} ${month}/${ch && ch.day}`;
    if (hits.length !== 1) { rejected.push(`${desc}（${hits.length ? '同名のスタッフが複数います。staff_id で指定してください' : 'この部署にいないスタッフです'}）`); continue; }
    const s = hits[0];
    const day = Number.isInteger(ch.day) ? ch.day : NaN;
    if (!(day >= 1 && day <= nDays)) { rejected.push(`${desc}（日付が不正です）`); continue; }
    const shift = ch.shift == null || ch.shift === '' ? null : String(ch.shift);
    if (shift && !valid.has(shift)) { rejected.push(`${desc}（登録されていないシフト名: ${shift}）`); continue; }
    const key = `${s.id}|${day}`;
    if (locked.has(key)) { rejected.push(`${s.name} ${month}/${day}（ロック中）`); continue; }
    const before = cur.get(key) || null;
    if (before === shift) continue;
    cells.push({ staff_id: s.id, day, shift });
    planned.push(`${s.name} ${month}/${day}(${dowJp(year, month, day)}): ${before || '空欄'} → ${shift || '空欄'}`);
  }
  const lockKeys = lock ? cells.filter(c => c.shift != null).map(c => `${c.staff_id}|${c.day}`) : [];
  const summary = { dept_name: DEPT_NAMES[dept], year, month, changes: planned, rejected, lock };
  return writeCells({ dept, year, month, staff, cells, lockKeys, confirm, toolName: 'set_shifts', summary });
}

const HANDLERS = {
  list_departments: toolListDepartments,
  list_staff: toolListStaff,
  get_shifts: toolGetShifts,
  get_requests: toolGetRequests,
  apply_requests: toolApplyRequests,
  set_shifts: toolSetShifts,
};

// ===== JSON-RPC =====
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg && msg.id, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined || msg.id === null;
  const { method, params = {} } = msg;

  if (isNotification) return null; // notifications/initialized など：応答不要
  try {
    if (method === 'initialize') {
      const want = params.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kingyo-shift', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === 'ping') return rpcResult(msg.id, {});
    if (method === 'tools/list') return rpcResult(msg.id, { tools: TOOLS });
    if (method === 'tools/call') {
      const fn = HANDLERS[params.name];
      if (!fn) return rpcError(msg.id, -32602, `Unknown tool: ${params.name}`);
      try {
        const out = await fn(params.arguments || {});
        return rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out, isError: false });
      } catch (e) {
        if (e instanceof UserError) return rpcResult(msg.id, { content: [{ type: 'text', text: e.message }], isError: true });
        console.error('mcp tool error:', params.name, e);
        return rpcResult(msg.id, { content: [{ type: 'text', text: '内部エラーが発生しました（Vercelのログを確認してください）' }], isError: true });
      }
    }
    if (method === 'resources/list') return rpcResult(msg.id, { resources: [] });
    if (method === 'prompts/list') return rpcResult(msg.id, { prompts: [] });
    return rpcError(msg.id, -32601, `Method not found: ${method}`);
  } catch (e) {
    console.error('mcp error:', e);
    return rpcError(msg.id, -32603, 'Internal error');
  }
}

function authorized(req) {
  if (MCP_KEY.length < 32) return false;
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(h) ? h[0] : h);
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1].trim()).digest();
  const b = crypto.createHash('sha256').update(MCP_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return res.status(500).json(rpcError(null, -32603, 'サーバー設定エラー'));
  if (MCP_KEY.length < 32) return res.status(503).json(rpcError(null, -32603, 'MCP接続口は無効です（KINGYO_MCP_KEY 未設定）'));
  if (!authorized(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="kingyo-shift"');
    return res.status(401).json(rpcError(null, -32001, '認証に失敗しました'));
  }
  if (req.method === 'GET' || req.method === 'DELETE') return res.status(405).setHeader('Allow', 'POST').end();
  if (req.method !== 'POST') return res.status(405).setHeader('Allow', 'POST').end();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json(rpcError(null, -32700, 'Parse error')); } }
  if (body == null) return res.status(400).json(rpcError(null, -32700, 'Parse error'));

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handleMessage))).filter(Boolean);
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  const out = await handleMessage(body);
  return out ? res.status(200).json(out) : res.status(202).end();
}

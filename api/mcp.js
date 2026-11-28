// /api/mcp.js
// kingyo-shift の MCP サーバー（AIエージェント接続口）
//   Meta の Muse などの AI エージェントが、カスタムコネクタ（リモートMCP / Streamable HTTP）として接続する。
//
// 方針（2026-11-28 に管理者が範囲を拡大：シフト運用＋マスタ・設定まで編集可）
//   - 閲覧: 部署・スタッフ・シフト表・希望／未提出者・実働/所定の集計・設定一式
//   - 通常の書き込み: 下書き系（セル変更・希望反映・ロック・特別日・曜日タイプ・メモ・休憩・固定シフト適用・希望の編集）
//     → 二段階。confirm:true が無い呼び出しは「変更予定」を返すだけで何も保存しない
//   - 重大な書き込み: 確定・公開/確定取消・月のクリア・固定シフト解除・スタッフ/シフト種別マスタ・
//     所定/必要人数/希望ルール/全体設定の変更
//     → プレビューが返す plan_hash（計画の照合コード）を confirm:true と一緒に渡さないと実行しない。
//       データが変わって計画が変われば照合コードも変わり、古い了承では実行できない
//   - 対象外: 管理者アカウント・招待・カレンダー連携・iCal（影響範囲が大きいため管理画面のみ）
//   - 確定済みの月・ロック中のセルには原則書き込まない。部署は毎回 dept_id で指定（1部署ずつ）
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
  const rows = await sb(`staff?dept_id=eq.${dept}&select=id,name,staff_code,emp_type,display_order,no_night,no_count,skill_level,fixed_shifts`);
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


// ===== 集計・設定ヘルパー（管理画面 admin.js の計算と一致させる） =====
// 日本の祝日（admin.js の getJapaneseHolidays と同じ。2026年のみ定義済み）
const JP_HOLIDAYS = {
  '2026-1': [1], '2026-2': [11, 23], '2026-3': [20], '2026-4': [29], '2026-5': [3, 4, 5, 6],
  '2026-7': [20], '2026-8': [11], '2026-9': [21, 22], '2026-10': [12], '2026-11': [3, 23], '2026-12': [],
};
const jpHolidays = (y, m) => new Set(JP_HOLIDAYS[`${y}-${m}`] || []);
const PAID_LEAVE_SHIFTS = ['有休', '個夏休'];
const yukyuHours = (dow, isHoliday) => (dow === 0 || dow === 6 || isHoliday) ? 9 : 8.5;

async function appSettingsMap() {
  const rows = await sb('app_settings?select=key,value').catch(() => []);
  const map = {};
  (rows || []).forEach(r => { map[r.key] = r.value; });
  return map;
}
function planConstants(settings) {
  let shortRatio = parseFloat(settings.short_ratio);
  if (isNaN(shortRatio)) shortRatio = 0.75;
  let def = parseFloat(settings.default_planned_hours);
  if (isNaN(def)) def = 171.4;
  const yearMap = {};
  for (const [k, v] of Object.entries(settings)) {
    const m = /^planned_hours_year_(\d{4})$/.exec(k || '');
    if (m && v != null && !isNaN(parseFloat(v))) yearMap[m[1]] = parseFloat(v);
  }
  return { shortRatio, defaultHours: def, yearMap };
}
function empTypeBaseHours(empType, base, shortRatio) {
  switch (empType) {
    case 'full': case 'fullpart': return base;
    case 'short': return Math.round(base * shortRatio * 10) / 10;
    case 'part': return 80;
    case 'arbeit': return 0;
    default: return base;
  }
}
async function monthlyHoursByMonth(year) {
  const rows = await sb(`monthly_hours?year=eq.${year}&dept_id=is.null&select=month,hours`).catch(() => []);
  const byMonth = {};
  (rows || []).forEach(r => { const h = parseFloat(r.hours); if (!isNaN(h)) byMonth[r.month] = h; });
  return byMonth;
}
function planBaseFor(year, month, byMonth, pc) {
  if (byMonth[month] != null) return { base: byMonth[month], source: 'monthly_hours（月別設定）' };
  if (pc.yearMap[year] != null) return { base: pc.yearMap[year], source: 'planned_hours_year（年の基準値）' };
  return { base: pc.defaultHours, source: 'default_planned_hours（全体既定）' };
}
async function staffSettingsMap(staffIds, year, month) {
  if (!staffIds.length) return {};
  const rows = await sb(`staff_settings?staff_id=in.(${inFilter(staffIds)})&year=eq.${year}&month=eq.${month}&select=staff_id,planned_hours,max_night_per_month,max_late_per_month,max_long_per_month,max_mid_per_month`).catch(() => []);
  const map = {};
  (rows || []).forEach(r => { map[r.staff_id] = r; });
  return map;
}
// 管理画面の右端列と同じ計算：実働（work_hours 合計＋有休加算。休診日は加算なし）／所定／日数
async function computeTotals(dept, year, month) {
  const staff = await deptStaff(dept);
  const [st, types, closed, settings, byMonth] = await Promise.all([
    monthState(staff, year, month), shiftTypes(), closedDays(year, month),
    appSettingsMap(), monthlyHoursByMonth(year),
  ]);
  const pc = planConstants(settings);
  const { base, source } = planBaseFor(year, month, byMonth, pc);
  const ssMap = await staffSettingsMap(staff.map(s => s.id), year, month);
  const hoursOf = {};
  types.forEach(t => { hoursOf[t.id] = parseFloat(t.work_hours) || 0; });
  const holidays = jpHolidays(year, month);
  const byStaff = {};
  st.shifts.forEach(r => { (byStaff[r.staff_id] ||= {})[r.day] = r.shift_type_id; });
  const round1 = v => Math.round(v * 10) / 10;
  return {
    dept_name: DEPT_NAMES[dept], year, month, confirmed: st.confirmed,
    base_hours: base, base_source: source,
    note: JP_HOLIDAYS[`${year}-${month}`] ? undefined : 'この年月の祝日表はアプリ側に定義がないため、有休加算は土日のみで計算しています',
    staff: staff.map(s => {
      let total = 0, days = 0;
      const cells = byStaff[s.id] || {};
      for (const [dStr, shift] of Object.entries(cells)) {
        const d = Number(dStr);
        if (!shift || closed.has(d)) continue;
        total += hoursOf[shift] || 0;
        if (!OFF_SHIFTS.includes(shift)) days++;
        const dow = new Date(year, month - 1, d).getDay();
        if (PAID_LEAVE_SHIFTS.includes(shift)) total += yukyuHours(dow, holidays.has(d));
        if (shift === '半有休') total += 5;
      }
      const setting = ssMap[s.id];
      const individual = setting && setting.planned_hours != null;
      const plan = individual ? parseFloat(setting.planned_hours) : empTypeBaseHours(s.emp_type, base, pc.shortRatio);
      const actual = round1(total);
      return {
        staff_id: s.id, name: s.name, emp_type: s.emp_type,
        actual_hours: actual, planned_hours: plan, diff_hours: round1(actual - plan),
        worked_days: days, planned_days: Math.floor(plan / 8.5),
        individual_planned: !!individual,
      };
    }),
  };
}

// ===== 重大変更の照合コード（プレビューした計画そのものを確認させる） =====
function planHash(toolName, payload) {
  return crypto.createHash('sha256').update(JSON.stringify({ t: toolName, p: payload })).digest('hex').slice(0, 16);
}
// 戻り値: プレビューで止める場合はその応答オブジェクト、実行してよい場合は null
function majorGate(toolName, payload, a, preview) {
  const hash = planHash(toolName, payload);
  if (a.confirm !== true) {
    return { saved: false, major: true, plan_hash: hash, ...preview,
      next: '重大な変更です。プレビューの内容を利用者に示して了承を得たら、confirm:true と plan_hash:"' + hash + '" を付けて再度呼んでください。' };
  }
  if (a.plan_hash !== hash) {
    throw new UserError(`plan_hash が一致しません（現在の計画の照合コード: ${hash}）。データが変わっている可能性があるため、プレビューを取り直してください`);
  }
  return null;
}
async function logWrite(toolName, detail) {
  console.log(`[mcp-write] ${toolName} ${detail}`.slice(0, 4000));
}
// 部署をまたいでスタッフを1人特定する（マスタ・個別設定用）
async function findStaffGlobal(key) {
  const k = String(key || '').trim();
  if (!k) throw new UserError('スタッフを指定してください');
  const cols = 'id,name,staff_code,emp_type,dept_id,display_order,no_night,no_count,skill_level,fixed_shifts';
  let rows = await sb(`staff?id=eq.${encodeURIComponent(k)}&select=${cols}`);
  if (!rows || !rows.length) rows = await sb(`staff?name=eq.${encodeURIComponent(k)}&select=${cols}`);
  if (!rows || rows.length !== 1) {
    throw new UserError(rows && rows.length ? '同名のスタッフが複数います。staff_id で指定してください' : 'スタッフが見つかりません');
  }
  return rows[0];
}
function resolveInDept(staff, key) {
  const k = String(key || '').trim();
  const hits = staff.filter(s => s.id === k || s.name === k);
  if (hits.length !== 1) throw new UserError(hits.length ? `同名のスタッフが複数います（${k}）。staff_id で指定してください` : `この部署にいないスタッフです（${k}）`);
  return hits[0];
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
{
name: 'get_totals',
description: '指定部署・年月の実働/所定（時間と日数）をスタッフごとに返す。管理画面と同じ計算（シフト種別の work_hours、有休は平日8.5H・土日祝9H、半有休5H、休診日は加算なし。所定は月別設定→年の基準値→全体既定の順、個別設定と雇用形態係数を適用）。時間の目安づくりには必ずこれを使うこと。',
inputSchema: { type: 'object', properties: YM_PROPS, required: ['dept_id', 'year', 'month'], additionalProperties: false},
annotations: { readOnlyHint: true},
},
{
name: 'get_settings',
description: '指定部署・年月の設定一式を返す（所定労働時間とその算出根拠、スタッフ個別設定、必要人数、新人上限、特別日、水曜・木曜タイプ、日付メモ、希望の期限・上限ルール）。',
inputSchema: { type: 'object', properties: YM_PROPS, required: ['dept_id', 'year', 'month'], additionalProperties: false},
annotations: { readOnlyHint: true},
},
{
name: 'set_locks',
description: 'セルのロック/解除を変更する（下書き）。confirm なしは変更予定のみ。確定済みの月は変更しない。シフトが入っていない空セルのロックも扱える。',
inputSchema: {
type: 'object',
properties: {
...YM_PROPS,
changes: { type: 'array', minItems: 1, maxItems: 300, items: { type: 'object', properties: {
staff: { type: 'string', description: 'スタッフ名または staff_id'},
day: { type: 'integer', minimum: 1, maximum: 31},
lock: { type: 'boolean', description: 'true でロック、false で解除'},
}, required: ['staff', 'day', 'lock'], additionalProperties: false}},
confirm: { type: 'boolean', description: 'true で実際に保存する。省略時は変更予定の確認のみ'},
},
required: ['dept_id', 'year', 'month', 'changes'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true},
},
{
name: 'set_requests',
description: '提出済みのシフト希望を管理者側で追加・変更・削除する。request_type に null を渡すとその日の希望を消す。confirm なしは変更予定のみ。',
inputSchema: {
type: 'object',
properties: {
...YM_PROPS,
items: { type: 'array', minItems: 1, maxItems: 300, items: { type: 'object', properties: {
staff: { type: 'string'}, day: { type: 'integer', minimum: 1, maximum: 31},
request_type: { type: ['string', 'null'], description: '希望するシフト名。null で希望を取り消す'},
}, required: ['staff', 'day', 'request_type'], additionalProperties: false}},
confirm: { type: 'boolean'},
},
required: ['dept_id', 'year', 'month', 'items'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true},
},
{
name: 'apply_fixed_shifts',
description: 'スタッフの曜日固定シフト設定（staff の fixed_shifts）を指定月に適用する（下書き）。休診日・ロック中のセルは対象外。with_lock（既定 true）で適用セルをロックする。confirm なしは変更予定のみ。',
inputSchema: {
type: 'object',
properties: {
...YM_PROPS,
staff: { type: 'string', description: 'スタッフ名または staff_id'},
with_lock: { type: 'boolean', description: '適用したセルをロックする（既定 true）'},
confirm: { type: 'boolean'},
},
required: ['dept_id', 'year', 'month', 'staff'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true},
},
{
name: 'set_special_days',
description: '特別日（休診日・祝日の扱い）を設定する。status: closed=任意休診日 / holiday_closed=祝日を休診にする / holiday_open=祝日を診療日にする / none=設定を取り消す。confirm なしは変更予定のみ。',
inputSchema: {
type: 'object',
properties: {
year: { type: 'integer'}, month: { type: 'integer', minimum: 1, maximum: 12},
entries: { type: 'array', minItems: 1, maxItems: 31, items: { type: 'object', properties: {
day: { type: 'integer', minimum: 1, maximum: 31},
status: { type: 'string', enum: ['closed', 'holiday_closed', 'holiday_open', 'none']},
label: { type: 'string', description: '表示ラベル（任意）'},
}, required: ['day', 'status'], additionalProperties: false}},
confirm: { type: 'boolean'},
},
required: ['year', 'month', 'entries'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true},
},
{
name: 'set_weekday_types',
description: '木曜の診療/休診（thursdays: is_open）と、水曜の種別（wednesdays: wed_type = cc / cho / normal）を設定する。confirm なしは変更予定のみ。',
inputSchema: {
type: 'object',
properties: {
year: { type: 'integer'}, month: { type: 'integer', minimum: 1, maximum: 12},
thursdays: { type: 'array', items: { type: 'object', properties: { day: { type: 'integer'}, is_open: { type: 'boolean'}}, required: ['day', 'is_open'], additionalProperties: false}},
wednesdays: { type: 'array', items: { type: 'object', properties: { day: { type: 'integer'}, wed_type: { type: ['string', 'null'], description: 'cc / cho / normal（通常に戻す）'}}, required: ['day', 'wed_type'], additionalProperties: false}},
confirm: { type: 'boolean'},
},
required: ['year', 'month'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true},
},
{
name: 'set_day_notes',
description: '日付メモ（部署×日ごと。タイトル10字・詳細500字まで）を設定する。title と detail が両方空ならその日のメモを削除。confirm なしは変更予定のみ。',
inputSchema: {
type: 'object',
properties: {
...YM_PROPS,
notes: { type: 'array', minItems: 1, maxItems: 31, items: { type: 'object', properties: {
day: { type: 'integer', minimum: 1, maximum: 31},
title: { type: ['string', 'null']}, detail: { type: ['string', 'null']},
}, required: ['day'], additionalProperties: false}},
confirm: { type: 'boolean'},
},
required: ['dept_id', 'year', 'month', 'notes'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true},
},
{
name: 'set_breaks',
description: '指定した日の休憩時間を設定する。その日の当該部署スタッフ分の休憩を、渡した rows で丸ごと置き換える（他部署には触れない）。confirm なしは変更予定のみ。',
inputSchema: {
type: 'object',
properties: {
...YM_PROPS,
day: { type: 'integer', minimum: 1, maximum: 31},
rows: { type: 'array', maxItems: 300, items: { type: 'object', properties: {
staff: { type: 'string'}, break_start: { type: 'string', description: 'HH:MM'}, break_end: { type: 'string', description: 'HH:MM'},
display_order: { type: 'integer'},
}, required: ['staff', 'break_start', 'break_end'], additionalProperties: false}},
confirm: { type: 'boolean'},
},
required: ['dept_id', 'year', 'month', 'day', 'rows'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true},
},
{
name: 'set_month_confirmed',
description: '月のシフトを確定・公開する（confirmed:true）、または確定を取り消す（confirmed:false）。confirm なしの呼び出しでプレビューと plan_hash が返るので、利用者の了承後に confirm:true と plan_hash を付けて実行すること。',
inputSchema: {
type: 'object',
properties: {
...YM_PROPS,
confirmed: { type: 'boolean', description: 'true で確定・公開、false で確定取消'},
confirm: { type: 'boolean'}, plan_hash: { type: 'string', description: 'プレビューで返された照合コード'},
},
required: ['dept_id', 'year', 'month', 'confirmed'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true},
},
{
name: 'clear_month_shifts',
description: '指定部署・月のシフト表（下書き）とセルロックをすべて削除する。確定済みの月は不可（先に確定取消が必要）。confirm + plan_hash が必須。',
inputSchema: {
type: 'object',
properties: {...YM_PROPS, confirm: { type: 'boolean'}, plan_hash: { type: 'string'}},
required: ['dept_id', 'year', 'month'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false},
},
{
name: 'remove_fixed_shifts',
description: '曜日固定シフトの解除。指定月から months か月分、曜日×シフトが完全一致するセルだけを削除する（ロック中でも削除。確定済みの月が含まれると中止）。clear_setting（既定 true）で曜日固定の設定自体もクリア。confirm + plan_hash が必須。',
inputSchema: {
type: 'object',
properties: {
dept_id: DEPT_PROP,
staff: { type: 'string'},
from_year: { type: 'integer'}, from_month: { type: 'integer', minimum: 1, maximum: 12},
months: { type: 'integer', minimum: 1, maximum: 12, description: '対象月数（既定1）'},
clear_setting: { type: 'boolean', description: '曜日固定の設定をクリアする（既定 true）'},
confirm: { type: 'boolean'}, plan_hash: { type: 'string'},
},
required: ['dept_id', 'staff', 'from_year', 'from_month'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false},
},
{
name: 'manage_staff',
description: 'スタッフマスタの追加・変更・削除。add は fields.name と fields.dept_id が必須。update/delete は staff（名前または staff_id）で対象を指定。fields で変更できるのは name / staff_code / emp_type（full・fullpart・short・part・arbeit）/ dept_id / display_order / no_night / no_count / skill_level / fixed_shifts（曜日→シフト名のオブジェクト）。confirm + plan_hash が必須。',
inputSchema: {
type: 'object',
properties: {
action: { type: 'string', enum: ['add', 'update', 'delete']},
staff: { type: 'string', description: 'update/delete の対象（名前または staff_id）'},
fields: { type: 'object', description: '追加・変更する値'},
confirm: { type: 'boolean'}, plan_hash: { type: 'string'},
},
required: ['action'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false},
},
{
name: 'manage_shift_types',
description: 'シフト種別マスタの追加・変更・無効化。既定シフト（is_default）は変更不可。add は fields.label（10字以内）と start_time / end_time / work_hours が必須で、削除済みの同名は復活扱い。deactivate は物理削除せず is_active=false（過去の表の表示・計算は残る）。confirm + plan_hash が必須。',
inputSchema: {
type: 'object',
properties: {
action: { type: 'string', enum: ['add', 'update', 'deactivate']},
id: { type: 'string', description: 'update/deactivate の対象（シフト名または id）'},
fields: { type: 'object', description: 'label / start_time / end_time / work_hours / covers_morning / covers_afternoon / covers_evening / is_night / is_late / is_long / is_mid_break / display_order'},
confirm: { type: 'boolean'}, plan_hash: { type: 'string'},
},
required: ['action'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false},
},
{
name: 'set_planned_hours',
description: '所定労働時間の設定。month_hours: 月別の全体所定（hours に null で未設定に戻す）。staff_hours: スタッフ個別設定（planned_hours と夜勤・遅番・長日・中抜けの月上限。planned_hours に null で個別設定を外す）。confirm + plan_hash が必須。',
inputSchema: {
type: 'object',
properties: {
month_hours: { type: 'array', items: { type: 'object', properties: {
year: { type: 'integer'}, month: { type: 'integer', minimum: 1, maximum: 12}, hours: { type: ['number', 'null']},
}, required: ['year', 'month', 'hours'], additionalProperties: false}},
staff_hours: { type: 'array', items: { type: 'object', properties: {
staff: { type: 'string'}, year: { type: 'integer'}, month: { type: 'integer', minimum: 1, maximum: 12},
planned_hours: { type: ['number', 'null']}, max_night_per_month: { type: ['integer', 'null']},
max_late_per_month: { type: ['integer', 'null']}, max_long_per_month: { type: ['integer', 'null']}, max_mid_per_month: { type: ['integer', 'null']},
}, required: ['staff', 'year', 'month'], additionalProperties: false}},
confirm: { type: 'boolean'}, plan_hash: { type: 'string'},
},
required: [], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true},
},
{
name: 'set_requirements',
description: '必要人数（staffing_requirements）と新人上限（beginner_limits）の設定。period_id は morning / afternoon / evening、day_type は weekday / weekend / wed_normal / wed_cc / wed_cho / thu_open / thu_closed / holiday_jp / holiday_closed / clinic_closed、または day_YYYY_M_D（日付個別）。値に null でその設定を削除。confirm + plan_hash が必須。',
inputSchema: {
type: 'object',
properties: {
dept_id: DEPT_PROP,
requirements: { type: 'array', items: { type: 'object', properties: {
period_id: { type: 'string'}, day_type: { type: 'string'}, min_count: { type: ['integer', 'null']},
}, required: ['period_id', 'day_type', 'min_count'], additionalProperties: false}},
beginner_limits: { type: 'array', items: { type: 'object', properties: {
period_id: { type: 'string'}, day_type: { type: 'string'}, max_beginners: { type: ['integer', 'null']},
}, required: ['period_id', 'day_type', 'max_beginners'], additionalProperties: false}},
confirm: { type: 'boolean'}, plan_hash: { type: 'string'},
},
required: ['dept_id'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true},
},
{
name: 'set_request_rules',
description: '希望提出のルール設定（部署ごと）。deadline: {days_before, hour, minute, months_before}、limits: {limit_kibou_kyu, limit_yukyu, limit_other}、enabled_patterns: 使用するシフトパターンの配列。null を渡した項目はその設定を削除。confirm + plan_hash が必須。',
inputSchema: {
type: 'object',
properties: {
dept_id: DEPT_PROP,
deadline: { type: ['object', 'null']}, limits: { type: ['object', 'null']},
enabled_patterns: { type: ['array', 'null'], items: { type: 'string'}},
confirm: { type: 'boolean'}, plan_hash: { type: 'string'},
},
required: ['dept_id'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false},
},
{
name: 'set_app_settings',
description: '全体設定 app_settings のうち所定の算出定数だけを変更する。変更できるキー: short_ratio（時短係数 0〜1）/ default_planned_hours / planned_hours_year_YYYY（年の基準値）。value に null でそのキーを削除。confirm + plan_hash が必須。',
inputSchema: {
type: 'object',
properties: {
entries: { type: 'array', minItems: 1, items: { type: 'object', properties: {
key: { type: 'string'}, value: { type: ['string', 'number', 'null']},
}, required: ['key', 'value'], additionalProperties: false}},
confirm: { type: 'boolean'}, plan_hash: { type: 'string'},
},
required: ['entries'], additionalProperties: false,
},
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true},
},
];

const INSTRUCTIONS =
  'やちよ総合診療クリニックのシフト管理アプリ「kingyo-shift」です。部署ごと（dept_id）・月ごとに操作します。\n' +
  '・通常の書き込み（apply_requests / set_shifts / set_locks / set_requests / apply_fixed_shifts / set_special_days / set_weekday_types / set_day_notes / set_breaks）は、必ず confirm なしで変更予定を出し、利用者の了承を得てから confirm:true で実行してください。保存は原則下書き（未確定）です。\n' +
  '・重大な書き込み（set_month_confirmed / clear_month_shifts / remove_fixed_shifts / manage_staff / manage_shift_types / set_planned_hours / set_requirements / set_request_rules / set_app_settings）は、プレビューで返る plan_hash を利用者に内容を示して了承を得たうえで、confirm:true と plan_hash を一緒に渡さないと実行できません。\n' +
  '・実働/所定の確認には get_totals を使ってください（時刻の長さから推測しないこと）。設定の確認には get_settings を使ってください。\n' +
  '・確定済みの月・ロック中のセルは原則変更されません。シフト名は list_departments で確認してください（work_hours がアプリの実働時間です）。\n' +
  '・書き込み後は、管理画面でシフト表を開いている人に「再読み込み」を依頼してください（開いたままの画面から保存すると上書きされます）。';

// ===== ツール実装 =====
async function toolListDepartments() {
  const types = await shiftTypes();
  return {
    departments: Object.entries(DEPT_NAMES).map(([id, name]) => ({ dept_id: Number(id), name })),
    shift_types: types.map(t => ({
      id: t.id, label: t.label || t.id, kind: t.is_off ? '休み' : '勤務',
      time: (t.start_time && t.end_time) ? `${t.start_time}-${t.end_time}` : null,
      work_hours: parseFloat(t.work_hours) || 0,
      covers: [t.covers_morning && 'morning', t.covers_afternoon && 'afternoon', t.covers_evening && 'evening'].filter(Boolean),
      is_default: !!t.is_default, is_active: t.is_active !== false,
    })),
  };
}

async function toolListStaff(a) {
  const dept = intArg(a.dept_id, 0, 3, 'dept_id');
  const staff = await deptStaff(dept);
  return { dept_id: dept, dept_name: DEPT_NAMES[dept], staff: staff.map(s => ({ staff_id: s.id, name: s.name, staff_code: s.staff_code, emp_type: s.emp_type, display_order: s.display_order, no_night: !!s.no_night, no_count: !!s.no_count, skill_level: s.skill_level, fixed_shifts: s.fixed_shifts || {} })) };
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


async function toolGetTotals(a) {
  const { dept, year, month } = ymdArgs(a);
  return computeTotals(dept, year, month);
}

async function toolGetSettings(a) {
  const { dept, year, month } = ymdArgs(a);
  const staff = await deptStaff(dept);
  const ids = staff.map(s => s.id);
  const [settings, byMonth, ssMap, reqs, beginners, special, wed, thu, notes, deadlines, limits, patterns] = await Promise.all([
    appSettingsMap(), monthlyHoursByMonth(year),
    staffSettingsMap(ids, year, month),
    sb(`staffing_requirements?dept_id=eq.${dept}&select=period_id,day_type,min_count`).catch(() => []),
    sb(`beginner_limits?dept_id=eq.${dept}&select=period_id,day_type,max_beginners`).catch(() => []),
    sb(`special_days?year=eq.${year}&month=eq.${month}&select=day,day_type,is_closed,is_holiday,label`).catch(() => []),
    sb(`wednesday_types?year=eq.${year}&month=eq.${month}&select=day,wed_type`).catch(() => []),
    sb(`thursday_types?year=eq.${year}&month=eq.${month}&select=day,is_open`).catch(() => []),
    sb(`day_notes?dept_id=eq.${dept}&year=eq.${year}&month=eq.${month}&select=day,title,detail`).catch(() => []),
    sb(`shift_request_deadline_rules?dept_id=eq.${dept}&select=days_before,hour,minute,months_before`).catch(() => []),
    sb(`shift_request_limits_default?dept_id=eq.${dept}&select=limit_kibou_kyu,limit_yukyu,limit_other`).catch(() => []),
    sb(`dept_shift_pattern_settings?dept_id=eq.${dept}&select=enabled_patterns`).catch(() => []),
  ]);
  const pc = planConstants(settings);
  const { base, source } = planBaseFor(year, month, byMonth, pc);
  return {
    dept_id: dept, dept_name: DEPT_NAMES[dept], year, month,
    planned_hours: {
      base_hours: base, base_source: source,
      year_all_months: byMonth,
      constants: { short_ratio: pc.shortRatio, default_planned_hours: pc.defaultHours, planned_hours_year: pc.yearMap },
      staff_overrides: staff.filter(s => ssMap[s.id]).map(s => ({ name: s.name, ...ssMap[s.id] })),
    },
    staffing_requirements: reqs || [],
    beginner_limits: beginners || [],
    special_days: special || [],
    wednesday_types: wed || [],
    thursday_types: thu || [],
    day_notes: notes || [],
    request_deadline_rules: deadlines || [],
    request_limits_default: limits || [],
    dept_shift_pattern_settings: patterns || [],
  };
}

// ===== 通常の書き込み（下書き系：従来どおり二段階 confirm） =====
async function toolSetLocks(a) {
  const { dept, year, month } = ymdArgs(a);
  const confirm = a.confirm === true;
  if (!Array.isArray(a.changes) || !a.changes.length) throw new UserError('changes を1件以上指定してください');
  if (a.changes.length > 300) throw new UserError('changes は1回300件までです');
  const staff = await deptStaff(dept);
  const st = await monthState(staff, year, month);
  if (st.confirmed) throw new UserError(`${DEPT_NAMES[dept]} ${year}年${month}月は確定済みのため変更できません`);
  const locked = lockedSet(st);
  const curMap = new Map(st.shifts.map(r => [`${r.staff_id}|${r.day}`, r]));
  const nDays = daysIn(year, month);
  const planned = [], rejected = [], patchCells = [], addLocks = [], delLocks = [];
  for (const ch of a.changes) {
    let s;
    try { s = resolveInDept(staff, ch && ch.staff); } catch (e) { rejected.push(`${ch && ch.staff}（${e.message}）`); continue; }
    const day = Number.isInteger(ch.day) ? ch.day : NaN;
    if (!(day >= 1 && day <= nDays)) { rejected.push(`${s.name} ${month}/${ch.day}（日付が不正です）`); continue; }
    const want = ch.lock === true;
    const key = `${s.id}|${day}`;
    if (locked.has(key) === want) continue;
    planned.push(`${s.name} ${month}/${day}(${dowJp(year, month, day)}): ロック${want ? 'する' : '解除'}`);
    if (curMap.has(key)) patchCells.push({ staff_id: s.id, day, lock: want });
    else if (want) addLocks.push({ staff_id: s.id, day });
    else delLocks.push({ staff_id: s.id, day });
  }
  const summary = { dept_name: DEPT_NAMES[dept], year, month, changes: planned, rejected };
  if (!confirm) return { saved: false, ...summary, next: '内容を利用者に確認し、了承を得たら同じ引数に confirm:true を付けて再度呼んでください。' };
  const st2 = await monthState(staff, year, month);
  if (st2.confirmed) throw new UserError('この月は確定済みになったため保存しませんでした');
  for (const c of patchCells) {
    await sb(`shifts?staff_id=eq.${encodeURIComponent(c.staff_id)}&year=eq.${year}&month=eq.${month}&day=eq.${c.day}`,
      { method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ is_locked: c.lock }) });
  }
  if (addLocks.length) {
    const have = new Set((st2.locks || []).map(l => `${l.staff_id}|${l.day}`));
    const rows = addLocks.filter(c => !have.has(`${c.staff_id}|${c.day}`)).map(c => ({ staff_id: c.staff_id, year, month, day: c.day }));
    if (rows.length) await sb('cell_locks', { method: 'POST', body: JSON.stringify(rows) });
  }
  for (const c of delLocks) {
    await sb(`cell_locks?staff_id=eq.${encodeURIComponent(c.staff_id)}&year=eq.${year}&month=eq.${month}&day=eq.${c.day}`, { method: 'DELETE' });
  }
  await logWrite('set_locks', `dept=${dept} ${year}-${month} ` + JSON.stringify(planned));
  return { saved: true, ...summary, message: 'ロック状態を保存しました。管理画面でシフト表を開いている人は再読み込みしてください。' };
}

async function toolSetRequests(a) {
  const { dept, year, month } = ymdArgs(a);
  const confirm = a.confirm === true;
  if (!Array.isArray(a.items) || !a.items.length) throw new UserError('items を1件以上指定してください');
  if (a.items.length > 300) throw new UserError('items は1回300件までです');
  const staff = await deptStaff(dept);
  const types = await shiftTypes();
  const valid = new Set(types.map(t => t.id).concat(OFF_SHIFTS));
  const reqs = await sbAll(`shift_requests?staff_id=in.(${inFilter(staff.map(s => s.id))})&year=eq.${year}&month=eq.${month}&select=staff_id,day,request_type`, 'staff_id,day');
  const cur = new Map(reqs.map(r => [`${r.staff_id}|${r.day}`, r.request_type]));
  const nDays = daysIn(year, month);
  const planned = [], rejected = [], ops = [];
  for (const it of a.items) {
    let s;
    try { s = resolveInDept(staff, it && it.staff); } catch (e) { rejected.push(`${it && it.staff}（${e.message}）`); continue; }
    const day = Number.isInteger(it.day) ? it.day : NaN;
    if (!(day >= 1 && day <= nDays)) { rejected.push(`${s.name} ${month}/${it.day}（日付が不正です）`); continue; }
    const rt = it.request_type == null || it.request_type === '' ? null : String(it.request_type);
    if (rt && !valid.has(rt)) { rejected.push(`${s.name} ${month}/${day}（登録されていないシフト名: ${rt}）`); continue; }
    const key = `${s.id}|${day}`;
    const before = cur.get(key) || null;
    if (before === rt) continue;
    ops.push({ staff_id: s.id, day, request_type: rt });
    planned.push(`${s.name} ${month}/${day}(${dowJp(year, month, day)}): 希望 ${before || 'なし'} → ${rt || 'なし'}`);
  }
  const summary = { dept_name: DEPT_NAMES[dept], year, month, changes: planned, rejected };
  if (!confirm) return { saved: false, ...summary, next: '内容を利用者に確認し、了承を得たら同じ引数に confirm:true を付けて再度呼んでください。' };
  for (const op of ops) {
    await sb(`shift_requests?staff_id=eq.${encodeURIComponent(op.staff_id)}&year=eq.${year}&month=eq.${month}&day=eq.${op.day}`, { method: 'DELETE' });
    if (op.request_type) {
      await sb('shift_requests', { method: 'POST', body: JSON.stringify([{ staff_id: op.staff_id, year, month, day: op.day, request_type: op.request_type }]) });
    }
  }
  await logWrite('set_requests', `dept=${dept} ${year}-${month} ` + JSON.stringify(planned));
  return { saved: true, ...summary, message: '希望を保存しました。' };
}

async function toolApplyFixedShifts(a) {
  const { dept, year, month } = ymdArgs(a);
  const confirm = a.confirm === true;
  const withLock = a.with_lock !== false;
  const staff = await deptStaff(dept);
  const s = resolveInDept(staff, a.staff);
  const fixed = s.fixed_shifts && typeof s.fixed_shifts === 'object' ? s.fixed_shifts : {};
  const entries = Object.entries(fixed).filter(([, v]) => v);
  if (!entries.length) throw new UserError(`${s.name} には曜日固定シフトが設定されていません`);
  const [st, closed, types] = await Promise.all([monthState(staff, year, month), closedDays(year, month), shiftTypes()]);
  if (st.confirmed) throw new UserError(`${DEPT_NAMES[dept]} ${year}年${month}月は確定済みのため変更できません`);
  const valid = new Set(types.map(t => t.id).concat(OFF_SHIFTS));
  const locked = lockedSet(st);
  const cur = new Map(st.shifts.map(r => [`${r.staff_id}|${r.day}`, r.shift_type_id]));
  const nDays = daysIn(year, month);
  const rows = [], planned = [], skipped = [];
  for (let d = 1; d <= nDays; d++) {
    const shift = fixed[new Date(year, month - 1, d).getDay()];
    if (!shift) continue;
    const label = `${s.name} ${month}/${d}(${dowJp(year, month, d)}) ${shift}`;
    if (!valid.has(shift)) { skipped.push(`${label}（登録されていないシフト名）`); continue; }
    if (closed.has(d)) { skipped.push(`${label}（休診日）`); continue; }
    if (locked.has(`${s.id}|${d}`)) { skipped.push(`${label}（ロック中）`); continue; }
    const before = cur.get(d) || null;
    if (before === shift) continue;
    rows.push({ staff_id: s.id, year, month, day: d, shift_type_id: shift,
                is_locked: withLock, is_confirmed: false, cell_label: null, lock_type: withLock ? 'fixed_shift' : null });
    planned.push(`${label}（現在: ${before || '空欄'}）`);
  }
  const summary = { dept_name: DEPT_NAMES[dept], year, month, staff: s.name, fixed_pattern: Object.fromEntries(entries), changes: planned, skipped, with_lock: withLock };
  if (!confirm) return { saved: false, ...summary, next: '内容を利用者に確認し、了承を得たら同じ引数に confirm:true を付けて再度呼んでください。' };
  const st2 = await monthState(staff, year, month);
  if (st2.confirmed) throw new UserError('この月は確定済みになったため保存しませんでした');
  const locked2 = lockedSet(st2);
  const safeRows = rows.filter(r => !locked2.has(`${r.staff_id}|${r.day}`));
  if (safeRows.length) {
    await sb('shifts?on_conflict=staff_id,year,month,day', {
      method: 'POST', headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(safeRows),
    });
  }
  await logWrite('apply_fixed_shifts', `dept=${dept} ${year}-${month} staff=${s.name} rows=${safeRows.length}`);
  return { saved: true, ...summary, saved_cells: safeRows.length, message: '曜日固定シフトを適用しました（下書き）。管理画面でシフト表を開いている人は再読み込みしてください。' };
}

async function toolSetSpecialDays(a) {
  const year = intArg(a.year, 2020, 2100, 'year');
  const month = intArg(a.month, 1, 12, 'month');
  const confirm = a.confirm === true;
  if (!Array.isArray(a.entries) || !a.entries.length) throw new UserError('entries を1件以上指定してください');
  const nDays = daysIn(year, month);
  const existing = await sb(`special_days?year=eq.${year}&month=eq.${month}&select=day,day_type,is_closed,is_holiday,label`).catch(() => []);
  const cur = new Map((existing || []).map(r => [r.day, r]));
  const planned = [], rejected = [], ops = [];
  const MAP = {
    closed:        { day_type: 'clinic_closed', is_holiday: false, is_closed: true,  label: '休診' },
    holiday_closed:{ day_type: 'holiday_closed', is_holiday: true, is_closed: true,  label: '休診' },
    holiday_open:  { day_type: 'holiday_jp',    is_holiday: true, is_closed: false, label: '診療日' },
    none: null,
  };
  for (const e of a.entries) {
    const day = Number.isInteger(e && e.day) ? e.day : NaN;
    if (!(day >= 1 && day <= nDays)) { rejected.push(`${month}/${e && e.day}（日付が不正です）`); continue; }
    if (!(e.status in MAP)) { rejected.push(`${month}/${day}（status は closed / holiday_closed / holiday_open / none のいずれか）`); continue; }
    const row = MAP[e.status] ? { year, month, day, ...MAP[e.status], label: (e.label && String(e.label).slice(0, 40)) || MAP[e.status].label } : null;
    const before = cur.get(day) || null;
    const same = JSON.stringify(before && { day_type: before.day_type, is_holiday: before.is_holiday, is_closed: before.is_closed, label: before.label })
      === JSON.stringify(row && { day_type: row.day_type, is_holiday: row.is_holiday, is_closed: row.is_closed, label: row.label });
    if (same) continue;
    ops.push({ day, row });
    planned.push(`${month}/${day}(${dowJp(year, month, day)}): ${before ? before.day_type : '通常'} → ${row ? row.day_type : '通常'}`);
  }
  const summary = { year, month, changes: planned, rejected };
  if (!confirm) return { saved: false, ...summary, next: '内容を利用者に確認し、了承を得たら同じ引数に confirm:true を付けて再度呼んでください。' };
  for (const op of ops) {
    await sb(`special_days?year=eq.${year}&month=eq.${month}&day=eq.${op.day}`, { method: 'DELETE' });
    if (op.row) await sb('special_days', { method: 'POST', body: JSON.stringify([op.row]) });
  }
  await logWrite('set_special_days', `${year}-${month} ` + JSON.stringify(planned));
  return { saved: true, ...summary, message: '特別日（休診・祝日扱い）を保存しました。' };
}

async function toolSetWeekdayTypes(a) {
  const year = intArg(a.year, 2020, 2100, 'year');
  const month = intArg(a.month, 1, 12, 'month');
  const confirm = a.confirm === true;
  const thursdays = Array.isArray(a.thursdays) ? a.thursdays : [];
  const wednesdays = Array.isArray(a.wednesdays) ? a.wednesdays : [];
  if (!thursdays.length && !wednesdays.length) throw new UserError('thursdays か wednesdays を1件以上指定してください');
  const nDays = daysIn(year, month);
  const planned = [], rejected = [], thuOps = [], wedOps = [];
  for (const t of thursdays) {
    const day = Number.isInteger(t && t.day) ? t.day : NaN;
    if (!(day >= 1 && day <= nDays) || new Date(year, month - 1, day).getDay() !== 4) { rejected.push(`${month}/${t && t.day}（木曜日ではありません）`); continue; }
    thuOps.push({ day, is_open: t.is_open === true });
    planned.push(`${month}/${day}(木): ${t.is_open === true ? '診療日' : '休診'}`);
  }
  for (const w of wednesdays) {
    const day = Number.isInteger(w && w.day) ? w.day : NaN;
    if (!(day >= 1 && day <= nDays) || new Date(year, month - 1, day).getDay() !== 3) { rejected.push(`${month}/${w && w.day}（水曜日ではありません）`); continue; }
    const wt = w.wed_type == null || w.wed_type === 'normal' ? null : String(w.wed_type);
    if (wt && !['cc', 'cho'].includes(wt)) { rejected.push(`${month}/${day}（wed_type は cc / cho / normal のいずれか）`); continue; }
    wedOps.push({ day, wed_type: wt });
    planned.push(`${month}/${day}(水): ${wt ? wt.toUpperCase() : '通常'}`);
  }
  const summary = { year, month, changes: planned, rejected };
  if (!confirm) return { saved: false, ...summary, next: '内容を利用者に確認し、了承を得たら同じ引数に confirm:true を付けて再度呼んでください。' };
  for (const op of thuOps) {
    await sb(`thursday_types?year=eq.${year}&month=eq.${month}&day=eq.${op.day}`, { method: 'DELETE' });
    await sb('thursday_types', { method: 'POST', body: JSON.stringify([{ year, month, day: op.day, is_open: op.is_open }]) });
  }
  for (const op of wedOps) {
    await sb(`wednesday_types?year=eq.${year}&month=eq.${month}&day=eq.${op.day}`, { method: 'DELETE' });
    if (op.wed_type) await sb('wednesday_types', { method: 'POST', body: JSON.stringify([{ year, month, day: op.day, wed_type: op.wed_type }]) });
  }
  await logWrite('set_weekday_types', `${year}-${month} ` + JSON.stringify(planned));
  return { saved: true, ...summary, message: '木曜・水曜の診療タイプを保存しました。' };
}

async function toolSetDayNotes(a) {
  const { dept, year, month } = ymdArgs(a);
  const confirm = a.confirm === true;
  if (!Array.isArray(a.notes) || !a.notes.length) throw new UserError('notes を1件以上指定してください');
  const nDays = daysIn(year, month);
  const planned = [], rejected = [], ops = [];
  for (const n of a.notes) {
    const day = Number.isInteger(n && n.day) ? n.day : NaN;
    if (!(day >= 1 && day <= nDays)) { rejected.push(`${month}/${n && n.day}（日付が不正です）`); continue; }
    const title = n.title == null ? '' : String(n.title).slice(0, 10);
    const detail = n.detail == null ? '' : String(n.detail).slice(0, 500);
    ops.push({ day, title, detail });
    planned.push(`${month}/${day}: ${title || detail ? `メモ「${title}」` : 'メモ削除'}`);
  }
  const summary = { dept_name: DEPT_NAMES[dept], year, month, changes: planned, rejected };
  if (!confirm) return { saved: false, ...summary, next: '内容を利用者に確認し、了承を得たら同じ引数に confirm:true を付けて再度呼んでください。' };
  for (const op of ops) {
    await sb(`day_notes?dept_id=eq.${dept}&year=eq.${year}&month=eq.${month}&day=eq.${op.day}`, { method: 'DELETE' });
    if (op.title || op.detail) {
      await sb('day_notes', { method: 'POST', body: JSON.stringify([{ dept_id: dept, year, month, day: op.day, title: op.title, detail: op.detail }]) });
    }
  }
  await logWrite('set_day_notes', `dept=${dept} ${year}-${month} ` + JSON.stringify(planned));
  return { saved: true, ...summary, message: '日付メモを保存しました。' };
}

async function toolSetBreaks(a) {
  const { dept, year, month } = ymdArgs(a);
  const day = intArg(a.day, 1, 31, 'day');
  const confirm = a.confirm === true;
  if (!Array.isArray(a.rows)) throw new UserError('rows を配列で指定してください');
  const staff = await deptStaff(dept);
  const TIME_RE = /^\d{1,2}:\d{2}$/;
  const planned = [], rejected = [], rows = [];
  for (const r of a.rows) {
    let s;
    try { s = resolveInDept(staff, r && r.staff); } catch (e) { rejected.push(`${r && r.staff}（${e.message}）`); continue; }
    const bs = String((r && r.break_start) || '').slice(0, 5);
    const be = String((r && r.break_end) || '').slice(0, 5);
    if (!TIME_RE.test(bs) || !TIME_RE.test(be)) { rejected.push(`${s.name}（時刻は HH:MM で指定してください）`); continue; }
    const ord = Number.isInteger(r.display_order) ? Math.max(0, Math.min(100, r.display_order)) : 0;
    rows.push({ staff_id: s.id, year, month, day, break_start: bs, break_end: be, display_order: ord });
    planned.push(`${s.name}: 休憩 ${bs}-${be}`);
  }
  const summary = { dept_name: DEPT_NAMES[dept], year, month, day, changes: planned, rejected,
    note: 'この部署のスタッフ分だけ、その日の休憩を丸ごと置き換えます（他部署の休憩には触れません）' };
  if (!confirm) return { saved: false, ...summary, next: '内容を利用者に確認し、了承を得たら同じ引数に confirm:true を付けて再度呼んでください。' };
  const ids = inFilter(staff.map(s => s.id));
  await sb(`shift_breaks?staff_id=in.(${ids})&year=eq.${year}&month=eq.${month}&day=eq.${day}`, { method: 'DELETE' });
  if (rows.length) await sb('shift_breaks', { method: 'POST', body: JSON.stringify(rows) });
  await logWrite('set_breaks', `dept=${dept} ${year}-${month}-${day} rows=${rows.length}`);
  return { saved: true, ...summary, message: '休憩を保存しました。' };
}


// ===== 重大な書き込み（confirm + plan_hash の照合が必須） =====
async function toolSetMonthConfirmed(a) {
  const { dept, year, month } = ymdArgs(a);
  const staff = await deptStaff(dept);
  if (!staff.length) throw new UserError('この部署のスタッフがいません');
  const st = await monthState(staff, year, month);
  const target = a.confirmed === true;
  const payload = { dept, year, month, confirmed: target, current_confirmed: st.confirmed, cell_count: st.shifts.length };
  const gate = majorGate('set_month_confirmed', payload, a, {
    dept_name: DEPT_NAMES[dept], year, month,
    action: target ? '確定・公開する' : '確定を取り消す（下書きに戻す）',
    current_confirmed: st.confirmed, cell_count: st.shifts.length,
    warning: target ? '確定するとスタッフ全員にこの月のシフトが公開されます' : '確定を取り消すとスタッフ側では下書き扱いに戻ります',
  });
  if (gate) return gate;
  if (st.confirmed === target) return { saved: false, message: target ? '既に確定済みです' : '既に下書き（未確定）です' };
  const ids = inFilter(staff.map(s => s.id));
  const extra = target ? '' : '&is_confirmed=eq.true';
  await sb(`shifts?staff_id=in.(${ids})&year=eq.${year}&month=eq.${month}${extra}`, {
    method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ is_confirmed: target }),
  });
  await logWrite('set_month_confirmed', `dept=${dept} ${year}-${month} confirmed=${target} cells=${st.shifts.length}`);
  return { saved: true, dept_name: DEPT_NAMES[dept], year, month, confirmed: target,
    message: target ? '確定しました。スタッフに公開されています。' : '確定を取り消しました（下書きに戻りました）。' };
}

async function toolClearMonthShifts(a) {
  const { dept, year, month } = ymdArgs(a);
  const staff = await deptStaff(dept);
  const st = await monthState(staff, year, month);
  if (st.confirmed) throw new UserError('確定済みの月はクリアできません。先に set_month_confirmed で確定を取り消してください');
  const payload = { dept, year, month, cell_count: st.shifts.length, lock_count: (st.locks || []).length };
  const gate = majorGate('clear_month_shifts', payload, a, {
    dept_name: DEPT_NAMES[dept], year, month, ...payload,
    warning: 'この部署・この月のシフト表（下書き）とセルロックをすべて削除します。元に戻せません',
  });
  if (gate) return gate;
  const ids = inFilter(staff.map(s => s.id));
  await sb(`shifts?staff_id=in.(${ids})&year=eq.${year}&month=eq.${month}`, { method: 'DELETE' });
  await sb(`cell_locks?staff_id=in.(${ids})&year=eq.${year}&month=eq.${month}`, { method: 'DELETE' }).catch(() => []);
  await logWrite('clear_month_shifts', `dept=${dept} ${year}-${month} cells=${payload.cell_count}`);
  return { saved: true, dept_name: DEPT_NAMES[dept], year, month, cleared_cells: payload.cell_count, message: 'シフト表をクリアしました。' };
}

async function toolRemoveFixedShifts(a) {
  const staff = await deptStaff(intArg(a.dept_id, 0, 3, 'dept_id'));
  const dept = intArg(a.dept_id, 0, 3, 'dept_id');
  const s = resolveInDept(staff, a.staff);
  const fromYear = intArg(a.from_year, 2020, 2100, 'from_year');
  const fromMonth = intArg(a.from_month, 1, 12, 'from_month');
  const months = a.months == null ? 1 : intArg(a.months, 1, 12, 'months');
  const clearSetting = a.clear_setting !== false;
  const fixed = s.fixed_shifts && typeof s.fixed_shifts === 'object' ? s.fixed_shifts : {};
  if (!Object.values(fixed).some(v => v)) throw new UserError(`${s.name} には曜日固定シフトが設定されていません`);
  const targets = [];
  let y = fromYear, m = fromMonth;
  for (let i = 0; i < months; i++) {
    const rows = await sb(`shifts?staff_id=eq.${encodeURIComponent(s.id)}&year=eq.${y}&month=eq.${m}&select=day,shift_type_id,is_confirmed`);
    for (const r of rows || []) {
      if (r.is_confirmed) throw new UserError(`${y}年${m}月は確定済みのため解除できません`);
      const want = fixed[new Date(y, m - 1, r.day).getDay()];
      if (want && r.shift_type_id === want) targets.push({ year: y, month: m, day: r.day, shift_type_id: r.shift_type_id });
    }
    m++; if (m > 12) { m = 1; y++; }
  }
  const payload = { staff_id: s.id, from: `${fromYear}-${fromMonth}`, months, clear_setting: clearSetting, targets };
  const gate = majorGate('remove_fixed_shifts', payload, a, {
    dept_name: DEPT_NAMES[dept], staff: s.name, from_year: fromYear, from_month: fromMonth, months,
    delete_cells: targets.map(t => `${t.year}/${t.month}/${t.day} ${t.shift_type_id}`),
    clear_setting: clearSetting,
    warning: '曜日×シフトが完全一致するセルだけを削除します（ロック中でも削除）。曜日固定の設定自体もクリアします（clear_setting:false で保持）',
  });
  if (gate) return gate;
  let deleted = 0;
  for (const t of targets) {
    const url = `shifts?staff_id=eq.${encodeURIComponent(s.id)}&year=eq.${t.year}&month=eq.${t.month}&day=eq.${t.day}&shift_type_id=eq.${encodeURIComponent(t.shift_type_id)}`;
    const before = await sb(`${url}&select=id`);
    if (before && before.length) { await sb(url, { method: 'DELETE' }); deleted += before.length; }
  }
  if (clearSetting) {
    await sb(`staff?id=eq.${encodeURIComponent(s.id)}`, { method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ fixed_shifts: {} }) });
  }
  await logWrite('remove_fixed_shifts', `staff=${s.name} deleted=${deleted} clear_setting=${clearSetting}`);
  return { saved: true, staff: s.name, deleted_cells: deleted, clear_setting: clearSetting, message: '曜日固定シフトを解除しました。' };
}

const STAFF_EDITABLE = ['name', 'staff_code', 'emp_type', 'dept_id', 'display_order', 'no_night', 'no_count', 'skill_level', 'fixed_shifts'];
const EMP_TYPES = ['full', 'fullpart', 'short', 'part', 'arbeit'];
async function toolManageStaff(a) {
  const action = String(a.action || '');
  if (!['add', 'update', 'delete'].includes(action)) throw new UserError('action は add / update / delete のいずれかです');
  const fields = a.fields && typeof a.fields === 'object' ? a.fields : {};
  const values = {};
  for (const k of STAFF_EDITABLE) if (Object.prototype.hasOwnProperty.call(fields, k)) values[k] = fields[k];
  if (values.emp_type != null && !EMP_TYPES.includes(values.emp_type)) throw new UserError(`emp_type は ${EMP_TYPES.join(' / ')} のいずれかです`);
  if (values.dept_id != null) values.dept_id = intArg(values.dept_id, 0, 3, 'dept_id');
  let target = null;
  if (action === 'add') {
    if (!values.name || typeof values.name !== 'string') throw new UserError('add には fields.name が必要です');
    if (values.dept_id == null) throw new UserError('add には fields.dept_id が必要です');
  } else {
    target = await findStaffGlobal(a.staff);
    if (action === 'update' && !Object.keys(values).length) throw new UserError('update には fields に変更項目が必要です');
  }
  const payload = { action, staff_id: target ? target.id : null, name: target ? target.name : values.name, dept_id: target ? target.dept_id : values.dept_id, values };
  const gate = majorGate('manage_staff', payload, a, {
    action, target: target ? { staff_id: target.id, name: target.name, dept_name: DEPT_NAMES[target.dept_id], emp_type: target.emp_type } : null,
    new_values: values,
    warning: action === 'delete' ? 'スタッフを削除します。紐付くiCal購読フィード等も失効します' : 'スタッフのマスタ情報を変更します',
  });
  if (gate) return gate;
  if (action === 'add') {
    const rows = await sb('staff', { method: 'POST', body: JSON.stringify([values]) });
    await logWrite('manage_staff', `add ${JSON.stringify(values)}`);
    return { saved: true, action, created: rows && rows[0] ? { staff_id: rows[0].id, name: rows[0].name } : { name: values.name }, message: 'スタッフを追加しました。' };
  }
  if (action === 'update') {
    await sb(`staff?id=eq.${encodeURIComponent(target.id)}`, { method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify(values) });
    await logWrite('manage_staff', `update ${target.name} ${JSON.stringify(values)}`);
    return { saved: true, action, staff: target.name, applied: values, message: 'スタッフ情報を更新しました。' };
  }
  for (const t of ['ical_feed_settings', 'ical_feed_excludes', 'event_participants']) {
    try { await sb(`${t}?staff_id=eq.${encodeURIComponent(target.id)}`, { method: 'DELETE' }); } catch (e) { console.error('cascade delete:', t, e.message); }
  }
  await sb(`staff?id=eq.${encodeURIComponent(target.id)}`, { method: 'DELETE' });
  await logWrite('manage_staff', `delete ${target.name} (${target.id})`);
  return { saved: true, action, staff: target.name, message: 'スタッフを削除しました。' };
}

async function toolManageShiftTypes(a) {
  const action = String(a.action || '');
  if (!['add', 'update', 'deactivate'].includes(action)) throw new UserError('action は add / update / deactivate のいずれかです');
  const fields = a.fields && typeof a.fields === 'object' ? a.fields : {};
  const types = await shiftTypesAll();
  let target = null;
  if (action !== 'add') {
    const k = String(a.id || '').trim();
    target = types.find(t => t.id === k || t.label === k) || null;
    if (!target) throw new UserError(`シフト種別が見つかりません（${k}）`);
    if (target.is_default) throw new UserError('既定シフトは編集・削除できません（管理画面でも不可）');
  }
  const values = {};
  const BOOLS = ['covers_morning', 'covers_afternoon', 'covers_evening', 'is_night', 'is_late', 'is_long', 'is_mid_break'];
  for (const k of BOOLS) if (typeof fields[k] === 'boolean') values[k] = fields[k];
  if (fields.start_time != null) { if (!/^\d{1,2}:\d{2}$/.test(String(fields.start_time))) throw new UserError('start_time は HH:MM で指定してください'); values.start_time = String(fields.start_time); }
  if (fields.end_time != null) { if (!/^\d{1,2}:\d{2}$/.test(String(fields.end_time))) throw new UserError('end_time は HH:MM で指定してください'); values.end_time = String(fields.end_time); }
  if (fields.work_hours != null) { const h = parseFloat(fields.work_hours); if (isNaN(h) || h < 0 || h > 24) throw new UserError('work_hours は0〜24で指定してください'); values.work_hours = h; }
  if (fields.display_order != null && Number.isInteger(fields.display_order)) values.display_order = fields.display_order;
  let addName = null, revive = null;
  if (action === 'add') {
    addName = String(fields.label || '').trim();
    if (!addName) throw new UserError('add には fields.label（シフト名）が必要です');
    if (addName.length > 10) throw new UserError('シフト名は10文字以内です');
    const dup = types.find(t => t.id === addName || t.label === addName);
    if (dup && dup.is_active !== false) throw new UserError('同じ名前のシフトが既に存在します');
    if (dup) revive = dup;
    if (!values.start_time || !values.end_time || values.work_hours == null) throw new UserError('add には start_time / end_time / work_hours が必要です');
  }
  const payload = { action, id: target ? target.id : addName, revive: revive ? revive.id : null, values };
  const gate = majorGate('manage_shift_types', payload, a, {
    action, target: target ? { id: target.id, label: target.label, work_hours: target.work_hours } : (revive ? { revive: revive.id } : { new_name: addName }),
    new_values: values,
    warning: 'シフト種別（マスタ）を変更します。work_hours は全月の実働計算に影響します',
  });
  if (gate) return gate;
  if (action === 'add') {
    const row = { label: addName, short_label: addName, is_off: false, is_default: false, is_active: true, ...values };
    if (revive) {
      await sb(`shift_types?id=eq.${encodeURIComponent(revive.id)}`, { method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify(row) });
      await logWrite('manage_shift_types', `revive ${revive.id} ${JSON.stringify(values)}`);
      return { saved: true, action, id: revive.id, message: '削除済みの同名シフトを新しい内容で復活させました。' };
    }
    const rows = await sb('shift_types', { method: 'POST', body: JSON.stringify([{ id: addName, ...row }]) });
    await logWrite('manage_shift_types', `add ${addName} ${JSON.stringify(values)}`);
    return { saved: true, action, id: rows && rows[0] ? rows[0].id : addName, message: 'シフト種別を追加しました。' };
  }
  if (action === 'update') {
    if (!Object.keys(values).length) throw new UserError('update には fields に変更項目が必要です');
    await sb(`shift_types?id=eq.${encodeURIComponent(target.id)}`, { method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify(values) });
    await logWrite('manage_shift_types', `update ${target.id} ${JSON.stringify(values)}`);
    return { saved: true, action, id: target.id, applied: values, message: 'シフト種別を更新しました。' };
  }
  await sb(`shift_types?id=eq.${encodeURIComponent(target.id)}`, { method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ is_active: false }) });
  await logWrite('manage_shift_types', `deactivate ${target.id}`);
  return { saved: true, action, id: target.id, message: 'シフト種別を無効化しました（過去のシフト表の表示・計算はそのまま残ります）。' };
}
async function shiftTypesAll() {
  return (await sb('shift_types?select=id,label,is_off,is_active,is_default,start_time,end_time,work_hours,covers_morning,covers_afternoon,covers_evening,is_night,is_late,is_long,is_mid_break,display_order')) || [];
}

async function toolSetPlannedHours(a) {
  const monthHours = Array.isArray(a.month_hours) ? a.month_hours : [];
  const staffHours = Array.isArray(a.staff_hours) ? a.staff_hours : [];
  if (!monthHours.length && !staffHours.length) throw new UserError('month_hours か staff_hours を1件以上指定してください');
  const mhOps = [], shOps = [], preview = [];
  for (const mh of monthHours) {
    const year = intArg(mh && mh.year, 2020, 2100, 'year');
    const month = intArg(mh && mh.month, 1, 12, 'month');
    const hours = mh.hours == null ? null : parseFloat(mh.hours);
    if (hours != null && (isNaN(hours) || hours < 0 || hours > 400)) throw new UserError('hours は0〜400で指定してください');
    const curRows = await sb(`monthly_hours?year=eq.${year}&month=eq.${month}&dept_id=is.null&select=hours`);
    const cur = curRows && curRows.length ? parseFloat(curRows[0].hours) : null;
    mhOps.push({ year, month, hours });
    preview.push(`${year}年${month}月の所定（全体）: ${cur == null ? '未設定' : cur + 'H'} → ${hours == null ? '未設定に戻す' : hours + 'H'}`);
  }
  const LIMIT_KEYS = ['planned_hours', 'max_night_per_month', 'max_late_per_month', 'max_long_per_month', 'max_mid_per_month'];
  for (const sh of staffHours) {
    const s = await findStaffGlobal(sh && sh.staff);
    const year = intArg(sh.year, 2020, 2100, 'year');
    const month = intArg(sh.month, 1, 12, 'month');
    const vals = {};
    for (const k of LIMIT_KEYS) if (Object.prototype.hasOwnProperty.call(sh, k)) {
      if (sh[k] == null) vals[k] = null;
      else { const n = k === 'planned_hours' ? parseFloat(sh[k]) : parseInt(sh[k], 10); if (isNaN(n) || n < 0) throw new UserError(`${k} が不正です`); vals[k] = n; }
    }
    if (!Object.keys(vals).length) throw new UserError('staff_hours には planned_hours 等の項目が必要です');
    const curRows = await sb(`staff_settings?staff_id=eq.${encodeURIComponent(s.id)}&year=eq.${year}&month=eq.${month}&select=planned_hours,max_night_per_month,max_late_per_month,max_long_per_month,max_mid_per_month`);
    shOps.push({ staff_id: s.id, name: s.name, year, month, vals, cur: (curRows && curRows[0]) || null });
    preview.push(`${s.name} ${year}年${month}月 個別設定: ${JSON.stringify((curRows && curRows[0]) || null)} → ${JSON.stringify(vals)}`);
  }
  const payload = { month_hours: mhOps, staff_hours: shOps.map(o => ({ staff_id: o.staff_id, year: o.year, month: o.month, vals: o.vals, cur: o.cur })) };
  const gate = majorGate('set_planned_hours', payload, a, { changes: preview, warning: '所定労働時間の設定を変更します。全スタッフの実働/所定の判定に影響します' });
  if (gate) return gate;
  for (const op of mhOps) {
    await sb(`monthly_hours?year=eq.${op.year}&month=eq.${op.month}&dept_id=is.null`, { method: 'DELETE' });
    if (op.hours != null) await sb('monthly_hours', { method: 'POST', body: JSON.stringify([{ year: op.year, month: op.month, dept_id: null, hours: op.hours }]) });
  }
  for (const op of shOps) {
    const merged = { ...(op.cur || {}), ...op.vals };
    await sb(`staff_settings?staff_id=eq.${encodeURIComponent(op.staff_id)}&year=eq.${op.year}&month=eq.${op.month}`, { method: 'DELETE' });
    const hasAny = LIMIT_KEYS.some(k => merged[k] != null);
    if (hasAny) {
      const row = { staff_id: op.staff_id, year: op.year, month: op.month };
      for (const k of LIMIT_KEYS) row[k] = merged[k] != null ? merged[k] : null;
      await sb('staff_settings', { method: 'POST', body: JSON.stringify([row]) });
    }
  }
  await logWrite('set_planned_hours', JSON.stringify(preview));
  return { saved: true, changes: preview, message: '所定労働時間の設定を保存しました。' };
}

const DAY_TYPE_RE = /^(weekday|weekend|wed_normal|wed_cc|wed_cho|thu_open|thu_closed|holiday_jp|holiday_closed|clinic_closed|day_\d{4}_\d{1,2}_\d{1,2})$/;
async function toolSetRequirements(a) {
  const dept = intArg(a.dept_id, 0, 3, 'dept_id');
  const reqs = Array.isArray(a.requirements) ? a.requirements : [];
  const beginners = Array.isArray(a.beginner_limits) ? a.beginner_limits : [];
  if (!reqs.length && !beginners.length) throw new UserError('requirements か beginner_limits を1件以上指定してください');
  const preview = [], rOps = [], bOps = [];
  const checkEntry = (e, key) => {
    if (!['morning', 'afternoon', 'evening'].includes(e && e.period_id)) throw new UserError('period_id は morning / afternoon / evening のいずれかです');
    if (!DAY_TYPE_RE.test(String((e && e.day_type) || ''))) throw new UserError(`day_type が不正です: ${e && e.day_type}`);
    const v = e[key] == null ? null : parseInt(e[key], 10);
    if (v != null && (isNaN(v) || v < 0 || v > 50)) throw new UserError(`${key} は0〜50で指定してください`);
    return v;
  };
  for (const e of reqs) { const v = checkEntry(e, 'min_count'); rOps.push({ period_id: e.period_id, day_type: e.day_type, min_count: v }); preview.push(`必要人数 ${e.period_id}/${e.day_type}: → ${v == null ? '削除' : v + '人'}`); }
  for (const e of beginners) { const v = checkEntry(e, 'max_beginners'); bOps.push({ period_id: e.period_id, day_type: e.day_type, max_beginners: v }); preview.push(`新人上限 ${e.period_id}/${e.day_type}: → ${v == null ? '削除' : v + '人'}`); }
  const payload = { dept, requirements: rOps, beginner_limits: bOps };
  const gate = majorGate('set_requirements', payload, a, { dept_name: DEPT_NAMES[dept], changes: preview, warning: '必要人数・新人上限の設定を変更します。シフト表の充足判定に影響します' });
  if (gate) return gate;
  for (const op of rOps) {
    await sb(`staffing_requirements?dept_id=eq.${dept}&period_id=eq.${op.period_id}&day_type=eq.${encodeURIComponent(op.day_type)}`, { method: 'DELETE' });
    if (op.min_count != null) await sb('staffing_requirements', { method: 'POST', body: JSON.stringify([{ dept_id: dept, ...op }]) });
  }
  for (const op of bOps) {
    await sb(`beginner_limits?dept_id=eq.${dept}&period_id=eq.${op.period_id}&day_type=eq.${encodeURIComponent(op.day_type)}`, { method: 'DELETE' });
    if (op.max_beginners != null) await sb('beginner_limits', { method: 'POST', body: JSON.stringify([{ dept_id: dept, ...op }]) });
  }
  await logWrite('set_requirements', `dept=${dept} ` + JSON.stringify(preview));
  return { saved: true, dept_name: DEPT_NAMES[dept], changes: preview, message: '必要人数・新人上限を保存しました。' };
}

async function toolSetRequestRules(a) {
  const dept = intArg(a.dept_id, 0, 3, 'dept_id');
  const hasDeadline = a.deadline != null, hasLimits = a.limits != null, hasPatterns = a.enabled_patterns != null;
  if (!hasDeadline && !hasLimits && !hasPatterns) throw new UserError('deadline / limits / enabled_patterns のいずれかを指定してください');
  const payload = { dept, deadline: hasDeadline ? a.deadline : undefined, limits: hasLimits ? a.limits : undefined, enabled_patterns: hasPatterns ? a.enabled_patterns : undefined };
  const gate = majorGate('set_request_rules', payload, a, {
    dept_name: DEPT_NAMES[dept], new_values: payload,
    warning: '希望の提出期限・上限・使用パターンの設定を変更します。スタッフの希望提出に影響します',
  });
  if (gate) return gate;
  if (hasDeadline) {
    await sb(`shift_request_deadline_rules?dept_id=eq.${dept}`, { method: 'DELETE' });
    if (a.deadline) await sb('shift_request_deadline_rules', { method: 'POST', body: JSON.stringify([{ dept_id: dept, days_before: a.deadline.days_before ?? null, hour: a.deadline.hour ?? null, minute: a.deadline.minute ?? null, months_before: a.deadline.months_before ?? null }]) });
  }
  if (hasLimits) {
    await sb(`shift_request_limits_default?dept_id=eq.${dept}`, { method: 'DELETE' });
    if (a.limits) await sb('shift_request_limits_default', { method: 'POST', body: JSON.stringify([{ dept_id: dept, limit_kibou_kyu: a.limits.limit_kibou_kyu ?? null, limit_yukyu: a.limits.limit_yukyu ?? null, limit_other: a.limits.limit_other ?? null }]) });
  }
  if (hasPatterns) {
    await sb(`dept_shift_pattern_settings?dept_id=eq.${dept}`, { method: 'DELETE' });
    if (a.enabled_patterns) await sb('dept_shift_pattern_settings', { method: 'POST', body: JSON.stringify([{ dept_id: dept, enabled_patterns: a.enabled_patterns }]) });
  }
  await logWrite('set_request_rules', `dept=${dept} ` + JSON.stringify(payload));
  return { saved: true, dept_name: DEPT_NAMES[dept], message: '希望ルールの設定を保存しました。' };
}

async function toolSetAppSettings(a) {
  if (!Array.isArray(a.entries) || !a.entries.length) throw new UserError('entries を1件以上指定してください');
  const ops = [], preview = [];
  const settings = await appSettingsMap();
  for (const e of a.entries) {
    const key = String((e && e.key) || '');
    const okKey = key === 'short_ratio' || key === 'default_planned_hours' || /^planned_hours_year_\d{4}$/.test(key);
    if (!okKey) throw new UserError(`変更できるキーは short_ratio / default_planned_hours / planned_hours_year_YYYY です（${key}）`);
    const value = e.value == null ? null : String(e.value);
    if (value != null) {
      const n = parseFloat(value);
      if (isNaN(n) || n < 0 || n > 400) throw new UserError(`${key} は0〜400の数値で指定してください`);
      if (key === 'short_ratio' && n > 1) throw new UserError('short_ratio は0〜1で指定してください');
    }
    ops.push({ key, value });
    preview.push(`${key}: ${settings[key] ?? '未設定'} → ${value ?? '削除'}`);
  }
  const payload = { entries: ops, current: Object.fromEntries(ops.map(o => [o.key, settings[o.key] ?? null])) };
  const gate = majorGate('set_app_settings', payload, a, { changes: preview, warning: '全体設定（所定の算出定数）を変更します。全部署・全月の所定計算に影響します' });
  if (gate) return gate;
  for (const op of ops) {
    await sb(`app_settings?key=eq.${encodeURIComponent(op.key)}`, { method: 'DELETE' });
    if (op.value != null) await sb('app_settings', { method: 'POST', body: JSON.stringify([{ key: op.key, value: op.value }]) });
  }
  await logWrite('set_app_settings', JSON.stringify(preview));
  return { saved: true, changes: preview, message: '全体設定を保存しました。' };
}

const HANDLERS = {
  list_departments: toolListDepartments,
  list_staff: toolListStaff,
  get_shifts: toolGetShifts,
  get_requests: toolGetRequests,
  get_totals: toolGetTotals,
  get_settings: toolGetSettings,
  apply_requests: toolApplyRequests,
  set_shifts: toolSetShifts,
  set_locks: toolSetLocks,
  set_requests: toolSetRequests,
  apply_fixed_shifts: toolApplyFixedShifts,
  set_special_days: toolSetSpecialDays,
  set_weekday_types: toolSetWeekdayTypes,
  set_day_notes: toolSetDayNotes,
  set_breaks: toolSetBreaks,
  set_month_confirmed: toolSetMonthConfirmed,
  clear_month_shifts: toolClearMonthShifts,
  remove_fixed_shifts: toolRemoveFixedShifts,
  manage_staff: toolManageStaff,
  manage_shift_types: toolManageShiftTypes,
  set_planned_hours: toolSetPlannedHours,
  set_requirements: toolSetRequirements,
  set_request_rules: toolSetRequestRules,
  set_app_settings: toolSetAppSettings,
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

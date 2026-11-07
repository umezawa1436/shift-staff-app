// /api/hr-link.js — やちよ人事（別アプリ）向けの読み取り専用・集計API
//
// ・人事ツールのサーバーだけが呼ぶ（ブラウザからは呼ばない）。共有シークレット HR_LINK_SECRET による HMAC 署名必須
// ・返すのは「設定値」と「集計値」だけ。氏名・アカウント・希望・メモ・予定などの個人情報は返さない
//   - staff は staff_code / dept_id / emp_type / no_count のみ（部署の対応づけと人数計算に使う）
//   - シフトは「部署×日×時間帯ごとの配置人数」と「部署×雇用形態ごとのシフト時間合計」に集計して返す
// ・書き込みは一切しない
//
// 署名: x-hr-ts = UNIX秒, x-hr-sig = base64url(HMAC-SHA256(HR_LINK_SECRET, `${ts}.${year}-${month}`))
//       時刻のずれ ±300秒まで
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LINK_SECRET = process.env.HR_LINK_SECRET;

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}
// 1000行上限対策（data.js と同じ考え方）
async function sbAll(path, order) {
  const sep = path.includes('?') ? '&' : '?';
  const out = [];
  for (let offset = 0, i = 0; i < 50; i++) {
    const rows = await sb(`${path}${sep}order=${order}&limit=1000&offset=${offset}`);
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  return out;
}
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function verify(req, year, month) {
  if (!LINK_SECRET || LINK_SECRET.length < 32) return false;
  const ts = Number(req.headers['x-hr-ts']);
  const sig = String(req.headers['x-hr-sig'] || '');
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const exp = b64u(crypto.createHmac('sha256', LINK_SECRET).update(`${ts}.${year}-${month}`).digest());
  const a = Buffer.from(sig), b = Buffer.from(exp);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return res.status(500).json({ error: 'server not configured' });
  const url = new URL(req.url, 'http://x');
  const year = Number(url.searchParams.get('year')), month = Number(url.searchParams.get('month'));
  if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year/month が不正です' });
  }
  if (!verify(req, year, month)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const ym = `year=eq.${year}&month=eq.${month}`;
    const [departments, requirements, shiftTypes, staff, specialDays, thursdays, wednesdays, monthlyHours, shifts] = await Promise.all([
      sb('departments?select=id,name&order=id'),
      sb('staffing_requirements?select=dept_id,period_id,day_type,min_count'),
      sb('shift_types?select=id,work_hours,covers_morning,covers_afternoon,covers_evening,is_off,is_active'),
      sbAll('staff?select=id,staff_code,dept_id,emp_type,no_count,skill_level', 'id'),
      sb(`special_days?${ym}&select=day,day_type,is_closed,is_holiday`),
      sb(`thursday_types?${ym}&select=day,is_open`),
      sb(`wednesday_types?${ym}&select=day,wed_type`),
      sb(`monthly_hours?${ym}&select=dept_id,hours`),
      sbAll(`shifts?${ym}&is_confirmed=eq.true&select=staff_id,day,shift_type_id`, 'staff_id,day'),
    ]);

    const typeMap = new Map(shiftTypes.map((t) => [t.id, t]));
    const staffMap = new Map(staff.map((s) => [s.id, s]));
    // 部署×日×時間帯の配置人数（金魚の自動作成と同じく「必要人数に数えない」スタッフは除外）
    const coverage = {}; // dept -> day -> {morning, afternoon, evening}
    const hours = {};    // dept -> emp_type -> 時間合計
    for (const sh of shifts) {
      const s = staffMap.get(sh.staff_id), t = typeMap.get(sh.shift_type_id);
      if (!s || !t || t.is_off) continue;
      const dept = String(s.dept_id);
      const emp = s.emp_type || '未設定';
      hours[dept] = hours[dept] || {};
      hours[dept][emp] = (hours[dept][emp] || 0) + (Number(t.work_hours) || 0);
      if (s.no_count === true || s.skill_level === 'no_count') continue;
      const c = ((coverage[dept] = coverage[dept] || {})[sh.day] = coverage[dept][sh.day] || { morning: 0, afternoon: 0, evening: 0 });
      if (t.covers_morning) c.morning++;
      if (t.covers_afternoon) c.afternoon++;
      if (t.covers_evening) c.evening++;
    }
    return res.status(200).json({
      year, month, departments, requirements, specialDays, thursdays, wednesdays, monthlyHours,
      staff: staff.filter((s) => s.staff_code != null).map((s) => ({ staff_code: String(s.staff_code), dept_id: s.dept_id, emp_type: s.emp_type })),
      coverage, hours, confirmedCount: shifts.length,
    });
  } catch (e) {
    console.error('hr-link', e.message);
    return res.status(500).json({ error: 'internal error' });
  }
}

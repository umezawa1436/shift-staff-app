// /api/ical.js
// ICS購読フィード（Googleカレンダー / iPhone標準カレンダーの「照会カレンダー」用）
//
// 仕様:
//   GET /api/ical?token=<64桁hex>
//   - token は ical_feed_settings 発行のシークレット（URLがパスワード相当）。
//     購読アプリは認証ヘッダを付けられないため、トークンをURLで受ける設計。
//   - 配信範囲は本人の設定（include_shifts / include_private / include_dept / include_all）に従う
//   - 期間: 先月1日 〜 3ヶ月後の月末
//   - 退職者対応の二重防御: フィード行が消えていなくても staff が存在しなければ 404
//   - 段階公開（app_settings.calendar_release）未満のロールのフィードは 404
//
// 反映は Google/Apple 側のポーリング周期に依存（数時間かかることがある）。

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function envOk() { return SUPABASE_URL && SERVICE_ROLE_KEY; }

async function sb(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Supabase ${res.status}: ${text}`); }
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

// ===== 日付ユーティリティ =====
const pad2 = (n) => String(n).padStart(2, '0');
const dateStr = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
// 'YYYY-MM-DD' に n 日加算して 'YYYYMMDD' で返す（ICSの終日DTENDは翌日日付＝仕様）
function addDaysCompact(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}`;
}
const compact = (ymd) => ymd.replace(/-/g, '');

// ===== ICSエスケープ（RFC5545: バックスラッシュ・カンマ・セミコロン・改行）=====
function esc(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  if (!envOk()) return res.status(500).send('Server configuration error');

  const token = String((req.query && req.query.token) || '');
  if (!/^[0-9a-f]{64}$/.test(token)) return res.status(404).send('Not found');

  try {
    // ① フィード設定
    const feed = (await sb(`ical_feed_settings?token=eq.${token}&select=*`))[0];
    if (!feed || feed.enabled === false) return res.status(404).send('Not found');

    // ② 二重防御: スタッフが存在しない（退職済み）なら配信しない
    const staff = (await sb(`staff?id=eq.${encodeURIComponent(feed.staff_id)}&select=id,name,dept_id`))[0];
    if (!staff) return res.status(404).send('Not found');

    // ③ 段階公開の判定: このスタッフに紐づくアカウントのロールで判定
    const relRows = await sb(`app_settings?key=eq.calendar_release&select=value`);
    const level = relRows && relRows[0] ? (parseFloat(relRows[0].value) || 0) : 0;
    if (level < 2) {
      const accs = await sb(`accounts?staff_id=eq.${encodeURIComponent(feed.staff_id)}&select=role`);
      const roles = (accs || []).map(a => a.role);
      const ok = roles.includes('master') || (level >= 1 && roles.includes('leader'));
      if (!ok) return res.status(404).send('Not found');
    }

    // ④ 期間: 先月1日 〜 3ヶ月後の月末（JSTで判定）
    const now = new Date(Date.now() + 9 * 3600 * 1000); // UTC→JST
    const baseY = now.getUTCFullYear(), baseM = now.getUTCMonth() + 1;
    const months = []; // {y, m} × 5ヶ月（-1〜+3）
    for (let i = -1; i <= 3; i++) {
      const d = new Date(Date.UTC(baseY, baseM - 1 + i, 1));
      months.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
    }
    const rangeStart = dateStr(months[0].y, months[0].m, 1);
    const lastM = months[months.length - 1];
    const rangeEnd = dateStr(lastM.y, lastM.m, new Date(lastM.y, lastM.m, 0).getDate());

    const lines = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//kingyo-shift//JP');
    lines.push('CALSCALE:GREGORIAN');
    lines.push(`X-WR-CALNAME:${esc(`kingyo-shift（${staff.name}）`)}`);
    lines.push('X-WR-TIMEZONE:Asia/Tokyo');
    // Asia/Tokyo は夏時間なしの固定オフセット
    lines.push('BEGIN:VTIMEZONE');
    lines.push('TZID:Asia/Tokyo');
    lines.push('BEGIN:STANDARD');
    lines.push('DTSTART:19700101T000000');
    lines.push('TZOFFSETFROM:+0900');
    lines.push('TZOFFSETTO:+0900');
    lines.push('TZNAME:JST');
    lines.push('END:STANDARD');
    lines.push('END:VTIMEZONE');

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // DTSTAMP用 UTC

    // ⑤ 確定シフト（休み系は配信しない）
    if (feed.include_shifts !== false) {
      const types = await sb(`shift_types?select=id,label,start_time,end_time,is_off`);
      const typeMap = {};
      (types || []).forEach(t => { typeMap[t.id] = t; });

      const monthOr = months.map(mm => `and(year.eq.${mm.y},month.eq.${mm.m})`).join(',');
      const shifts = await sb(
        `shifts?staff_id=eq.${encodeURIComponent(feed.staff_id)}&is_confirmed=eq.true&or=(${monthOr})` +
        `&select=id,year,month,day,shift_type_id&order=year,month,day&limit=1000`
      );
      for (const s of shifts || []) {
        const t = typeMap[s.shift_type_id];
        if (!t || t.is_off) continue;
        const ymd = dateStr(s.year, s.month, s.day);
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:shift-${s.id}@kingyo-shift`);
        lines.push(`DTSTAMP:${stamp}`);
        lines.push(`SUMMARY:${esc(t.label || s.shift_type_id)}`);
        if (t.start_time && t.end_time) {
          const st = t.start_time.replace(':', '') + '00';
          const en = t.end_time.replace(':', '') + '00';
          lines.push(`DTSTART;TZID=Asia/Tokyo:${compact(ymd)}T${st}`);
          // 夜勤など日跨ぎ（終了<=開始）は翌日終了
          const endDay = (t.end_time <= t.start_time) ? addDaysCompact(ymd, 1) : compact(ymd);
          lines.push(`DTEND;TZID=Asia/Tokyo:${endDay}T${en}`);
        } else {
          lines.push(`DTSTART;VALUE=DATE:${compact(ymd)}`);
          lines.push(`DTEND;VALUE=DATE:${addDaysCompact(ymd, 1)}`);
        }
        lines.push('END:VEVENT');
      }
    }

    // ⑥ カレンダー予定（本人設定の反映範囲に従う）
    const conds = [];
    if (feed.include_private !== false) conds.push(`and(scope.eq.private,owner_staff_id.eq.${encodeURIComponent(feed.staff_id)})`);
    if (feed.include_dept === true && staff.dept_id != null) conds.push(`and(scope.eq.dept,dept_id.eq.${staff.dept_id})`);
    if (feed.include_all !== false) conds.push('scope.eq.all');

    if (conds.length) {
      const events = await sb(
        `events?start_date=lte.${rangeEnd}&end_date=gte.${rangeStart}&or=(${conds.join(',')})` +
        `&select=id,title,start_date,end_date,start_time,end_time,location,memo&order=start_date,id&limit=1000`
      );
      for (const ev of events || []) {
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:event-${ev.id}@kingyo-shift`);
        lines.push(`DTSTAMP:${stamp}`);
        lines.push(`SUMMARY:${esc(ev.title)}`);
        if (ev.location) lines.push(`LOCATION:${esc(ev.location)}`);
        if (ev.memo) lines.push(`DESCRIPTION:${esc(ev.memo)}`);
        if (ev.start_time) {
          lines.push(`DTSTART;TZID=Asia/Tokyo:${compact(ev.start_date)}T${ev.start_time.replace(':', '')}00`);
          const endT = ev.end_time || ev.start_time;
          let endDayYmd = ev.end_date || ev.start_date;
          // 単日で終了<=開始は終了時刻を開始と同じ扱い（長さ0）にして壊れないことを優先
          lines.push(`DTEND;TZID=Asia/Tokyo:${compact(endDayYmd)}T${endT.replace(':', '')}00`);
        } else {
          lines.push(`DTSTART;VALUE=DATE:${compact(ev.start_date)}`);
          lines.push(`DTEND;VALUE=DATE:${addDaysCompact(ev.end_date || ev.start_date, 1)}`);
        }
        lines.push('END:VEVENT');
      }
    }

    lines.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', 'inline; filename="kingyo-shift.ics"');
    return res.status(200).send(lines.join('\r\n') + '\r\n');
  } catch (e) {
    console.error('ical error:', e);
    return res.status(500).send('Internal error');
  }
}

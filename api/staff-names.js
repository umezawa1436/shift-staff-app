// /api/staff-names.js
// スタッフアプリのログイン画面用：部門ごとの氏名リストを返す（認証前に必要）。
// staff テーブルを RLS で閉じた後も、ログインのドロップダウンを成立させるための最小公開API。
// 返すのは staff_code / name / dept_id のみ（UUIDや属性は返さない＝従来のanon直読みより露出減）。

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function envOk() { return SUPABASE_URL && SERVICE_ROLE_KEY; }

async function sb(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Supabase ${res.status}: ${text}`); }
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!envOk()) return res.status(500).json({ error: 'サーバー設定エラー' });
  try {
    const rows = await sb('staff?select=staff_code,name,dept_id&order=dept_id,display_order.asc.nullslast,staff_code');
    return res.status(200).json({ staff: rows || [] });
  } catch (e) {
    console.error('staff-names error:', e);
    return res.status(500).json({ error: '内部エラー' });
  }
}

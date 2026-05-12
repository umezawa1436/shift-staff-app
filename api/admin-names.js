// /api/admin-names.js
// ログイン画面のドロップダウン用：管理者の名前リストを認証なしで返す
// 仕様:
//   - deptId が null → master 全員の名前
//   - deptId が数値 → その部門の leader 全員の名前
//   - スタッフ(role=staff) は含まない（スタッフ画面は staff テーブルから取得済み）
//
// セキュリティ注意:
//   - 名前（姓のみ運用）は staff テーブルでも anon 経由で取得可能なため、
//     管理者の名前も公開してログインUI改善を優先する設計判断。
//   - パスワードハッシュやその他のフィールドは一切返さない。

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

function bad(res, status, message) { return res.status(status).json({ error: message }); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');
  if (!envOk()) return bad(res, 500, 'サーバー設定エラー');
  const body = req.body || {};
  const deptId = body.deptId;

  try {
    let query;
    if (deptId === null || deptId === undefined) {
      // master 全員
      query = `accounts?role=eq.master&dept_id=is.null&select=name&order=name`;
    } else {
      const deptIdNum = parseInt(deptId);
      if (isNaN(deptIdNum)) return bad(res, 400, 'deptIdが不正です');
      // 指定部門の leader 全員
      query = `accounts?role=eq.leader&dept_id=eq.${deptIdNum}&select=name&order=name`;
    }
    const rows = await sb(query);
    const names = (rows || []).map(r => r.name).filter(Boolean);
    return res.status(200).json({ names });
  } catch (e) {
    console.error('admin-names error:', e);
    return bad(res, 500, '内部エラー');
  }
}

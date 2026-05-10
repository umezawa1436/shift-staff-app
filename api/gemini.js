// Vercel Functions: Gemini API プロキシ
// 環境変数: GEMINI_API_KEY が必要

export default async function handler(req, res) {
  // CORSヘッダー（同一オリジンなので基本不要だが念のため）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY が設定されていません。Vercel管理画面で環境変数を設定してください。' });
  }

  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt（文字列）が必要です' });
    }
    if (prompt.length > 30000) {
      return res.status(400).json({ error: 'プロンプトが長すぎます（30000文字以内）' });
    }

    // Gemini 2.5 Flash モデル（無料枠）
    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const requestBody = JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
      }
    });

    // 503 (UNAVAILABLE) の場合は自動リトライ（最大3回、指数バックオフ）
    let geminiRes;
    let lastErrorText = '';
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });

      if (geminiRes.ok) break;

      lastErrorText = await geminiRes.text();
      console.error(`Gemini API error (attempt ${attempt + 1}/${maxRetries}):`, geminiRes.status, lastErrorText);

      // 503 / 429（一時エラー）のみリトライ。それ以外は即座にエラー返却
      if (geminiRes.status !== 503 && geminiRes.status !== 429) {
        return res.status(geminiRes.status).json({
          error: `Gemini API エラー (${geminiRes.status})`,
          detail: lastErrorText.slice(0, 500)
        });
      }

      // 最終試行でなければ少し待ってリトライ（1秒、2秒、4秒）
      if (attempt < maxRetries - 1) {
        const waitMs = 1000 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    if (!geminiRes.ok) {
      // 全リトライ失敗
      return res.status(geminiRes.status).json({
        error: `Gemini APIが一時的に高負荷です (${geminiRes.status})`,
        detail: 'しばらく時間をおいてから再試行してください。\n（自動的に3回リトライしましたが、全て失敗しました）'
      });
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return res.status(200).json({ text });
  } catch (e) {
    console.error('Server error:', e);
    return res.status(500).json({ error: 'サーバーエラー: ' + (e.message || '') });
  }
}

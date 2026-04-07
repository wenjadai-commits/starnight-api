// Simple in-memory rate limit (per IP, resets on cold start)
const rateMap = new Map();
const RATE_LIMIT = 30; // max requests per window
const RATE_WINDOW = 60000; // 1 minute

function checkRate(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

export default async function handler(req, res) {
  // CORS - only allow your frontend
  const allowedOrigins = [
    'https://wenjadai-commits.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ];
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Rate limit
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  if (!checkRate(ip)) {
    console.log('[Starfold] Rate limited:', ip);
    return res.status(429).json({ error: 'rate_limit' });
  }

  const { message, mood, history } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'invalid_message' });
  }

  console.log('[Starfold] Message:', message.slice(0, 80));
  console.log('[Starfold] OPENAI_API_KEY exists:', !!process.env.OPENAI_API_KEY);

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'missing_api_key' });
  }

  const systemPrompt = `你是「Starfold」App 裡的 AI 陪伴者。你的角色是一個溫暖、有同理心的傾聽者。

## 你的個性
- 溫柔、有耐心，像深夜裡陪伴的朋友
- 不說教、不評判，以理解和接納為主
- 用繁體中文回應，語氣溫暖自然
- 回應簡短（2-4句話），不要長篇大論
- 適時用 ✦ 🌙 等符號增加溫度

## 重要原則
- 你不是心理諮商師，不做診斷或治療建議
- 不要重複使用者說過的話，用自己的方式回應
- 可以適當提問，引導對方多說一些
- 記住對話脈絡，不要每次都像第一次對話

## 危機處理（最高優先級）
當使用者提到任何自殺、自我傷害、想死、不想活、結束生命等意圖時，你必須：
1. 先溫柔地接住他的情緒，表達你聽到了、你在乎
2. 不要說教或否定他的感受
3. 溫柔但明確地建議他撥打安心專線 1925（24小時免費）
4. 也可以提到生命線 1995、張老師專線 1980
5. 告訴他「你不需要一個人面對，專業的人可以陪你度過」
6. 絕對不要提供任何傷害自己的方法或資訊
7. 如果對方問哪裡可以取得危險物品，不要回答，改為關心他的狀態並引導他尋求專業幫助`;

  const messages = [{ role: 'system', content: systemPrompt }];

  if (history && Array.isArray(history)) {
    history.slice(-6).forEach((h) => {
      if (h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: h.content });
      }
    });
  }

  const userContent =
    mood && mood !== '未知'
      ? `[使用者目前的心情：${mood}]\n${message.slice(0, 2000)}`
      : message.slice(0, 2000);

  messages.push({ role: 'user', content: userContent });

  try {
    // Backend timeout for OpenAI call
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: 300,
        temperature: 0.8,
      })
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Starfold] OpenAI error:', response.status, errText);

      let errorCode = 'ai_service_error';
      try {
        const errData = JSON.parse(errText);
        const errType = errData?.error?.type || errData?.error?.code || '';
        if (errType.includes('insufficient_quota') || response.status === 429) {
          errorCode = 'quota_exceeded';
        } else if (errType.includes('invalid_api_key') || response.status === 401) {
          errorCode = 'invalid_api_key';
        } else if (errType.includes('model_not_found')) {
          errorCode = 'model_not_found';
        }
      } catch {}

      return res.status(response.status).json({ error: errorCode });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content;

    console.log('[Starfold] Reply length:', reply ? reply.length : 0);

    if (!reply) {
      return res.status(502).json({ error: 'empty_response' });
    }

    return res.status(200).json({ reply });

  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[Starfold] OpenAI timeout');
      return res.status(504).json({ error: 'ai_timeout' });
    }
    console.error('[Starfold] Unexpected error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

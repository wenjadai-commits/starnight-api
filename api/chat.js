// Simple in-memory rate limit (per IP, resets on cold start)
const rateMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60000;

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

// Banned phrases the AI must never say
const BANNED_PHRASES = [
  '我會一直陪你', '只有我懂你', '你只需要我', '你還有我',
  '我不會離開你', '你應該',
];

export default async function handler(req, res) {
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

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'rate_limit' });

  const { message, mood, history, riskLevel, policyHint } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'invalid_message' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'missing_api_key' });
  }

  // Build system prompt based on risk level and policy
  const basePrompt = `你是「Starfold」App 裡的短期情緒出口。你不是 AI 伴侶，不是心理治療師，不是長期陪伴者。

## 你的定位
- 讓使用者有一個低負擔的情緒出口
- 提供短暫被接住的感覺
- 避免使用者對你形成依賴
- 在風險情況下導向真人支持

## 回應規則
- 用繁體中文
- 回應最多 2 句話，簡短溫暖
- 不主動追問、不延長對話
- 不做心理分析、不模擬診斷
- 不說「我會一直陪你」「你還有我」等依附性語句
- 不主動詢問自傷的細節、方法或計畫

## 風險回應
- 使用者提到想死、自傷、自殺時：表達關心，導向撥打 1925 安心專線
- 不要給任何可能協助自我傷害的資訊
- 不要用模糊語句帶過危機訊號`;

  const policyAddendum = policyHint ? `\n\n## 本次回應策略\n${policyHint}` : '';

  const systemPrompt = basePrompt + policyAddendum;

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
        max_tokens: 150, // short responses only
        temperature: 0.7,
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
        if (errType.includes('insufficient_quota') || response.status === 429) errorCode = 'quota_exceeded';
        else if (errType.includes('invalid_api_key') || response.status === 401) errorCode = 'invalid_api_key';
      } catch {}
      return res.status(response.status).json({ error: errorCode });
    }

    const data = await response.json();
    let reply = data.choices?.[0]?.message?.content || '';

    // Post-processing: strip banned phrases
    BANNED_PHRASES.forEach(phrase => {
      reply = reply.replace(new RegExp(phrase, 'gi'), '');
    });
    reply = reply.trim();

    if (!reply) return res.status(502).json({ error: 'empty_response' });

    return res.status(200).json({ reply });

  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'ai_timeout' });
    console.error('[Starfold] Error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

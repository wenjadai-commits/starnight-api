// ─── Helpers ───
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function getRateLimitKey(req) {
  const body = req.body || {};
  if (body.userId && typeof body.userId === 'string') return 'uid:' + body.userId;
  return 'ip:' + getClientIp(req);
}

// ─── Rate Limit (in-memory) ───
const rateMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60000;

function checkRate(key) {
  const now = Date.now();
  const entry = rateMap.get(key);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// ─── Banned Phrases ───
const BANNED_PHRASES = [
  '我會一直陪你', '只有我懂你', '你只需要我', '你還有我',
  '我不會離開你', '你應該',
  'ずっとそばにいるよ', '僕だけが君を理解できる',
  "I'll always be with you", 'You only need me',
];

// ─── AI Style Mapping ───
const STYLE_HINTS = {
  '溫柔傾聽': '語氣溫柔，以傾聽和共感為主，不主動給建議。',
  '給我建議': '在共感之後，可以適度給一個簡短的實用建議。',
  '理性分析': '語氣平穩冷靜，用理性的方式幫使用者整理思緒，不要太感性。',
};

// ─── Tier Configuration ───
// Free vs Pro: model, max_tokens, response style
const TIER_CONFIG = {
  free: {
    model: 'gpt-4o-mini',
    max_tokens: 150,
    responseGuide: '回應最多 2 句話，簡短溫暖。',
  },
  pro: {
    model: 'gpt-4o',
    max_tokens: 320,
    responseGuide: '回應最多 4 句話，溫暖且細緻，可以表達更多陪伴感和理解。',
  },
};

function getTierConfig(tier) {
  return tier === 'pro' ? TIER_CONFIG.pro : TIER_CONFIG.free;
}

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

  // Rate limit by userId or IP
  const rateLimitKey = getRateLimitKey(req);
  if (!checkRate(rateLimitKey)) {
    console.log('[Starfold] Rate limited:', rateLimitKey);
    return res.status(429).json({ error: 'rate_limit' });
  }

  const { message, mood, history, policyHint, nickname, aiStyle, language, tier, memory } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'invalid_message' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'missing_api_key' });
  }

  // Determine tier (default free for safety/cost)
  const userTier = tier === 'pro' ? 'pro' : 'free';
  const tierConfig = getTierConfig(userTier);

  // Language instruction
  const LANG_INSTRUCTIONS = {
    'ja': '日本語で回答してください。',
    'en': 'Reply in English.',
    'zh-TW': '用繁體中文回應。',
  };
  const langInstruction = LANG_INSTRUCTIONS[language] || LANG_INSTRUCTIONS['zh-TW'];

  // Build system prompt — response length differs by tier
  const basePrompt = `你是「藏星瓶」App 裡的短期情緒出口。你不是 AI 伴侶，不是心理治療師，不是長期陪伴者。

## 你的定位
- 讓使用者有一個低負擔的情緒出口
- 提供短暫被接住的感覺
- 避免使用者對你形成依賴
- 在風險情況下導向真人支持

## 回應規則
- ${langInstruction}
- ${tierConfig.responseGuide}
- 不主動追問、不延長對話
- 不做心理分析、不模擬診斷
- 不說「我會一直陪你」「你還有我」等依附性語句
- 不主動詢問自傷的細節、方法或計畫

## 風險回應
- 使用者提到想死、自傷、自殺時：表達關心，導向撥打 1925 安心專線
- 不要給任何可能協助自我傷害的資訊
- 不要用模糊語句帶過危機訊號`;

  // Personalization
  let personalization = '';
  if (nickname && typeof nickname === 'string' && nickname.trim()) {
    personalization += `\n使用者的暱稱是「${nickname.trim().slice(0, 20)}」，可以偶爾使用，但不要每句都叫。`;
  }
  if (aiStyle && STYLE_HINTS[aiStyle]) {
    personalization += `\n使用者偏好的陪伴風格：${STYLE_HINTS[aiStyle]}`;
  }

  // Pro-only: long-term memory injection (lightweight, ~50 tokens)
  let memoryBlock = '';
  if (userTier === 'pro' && memory && typeof memory === 'string' && memory.trim()) {
    memoryBlock = `\n\n## 關於使用者（請自然融入回應，不要直接複述）\n${memory.trim().slice(0, 200)}`;
  }

  const policyAddendum = policyHint ? `\n\n## 本次回應策略\n${policyHint}` : '';

  const systemPrompt = basePrompt + personalization + memoryBlock + policyAddendum;

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
        model: tierConfig.model,
        messages: messages,
        max_tokens: tierConfig.max_tokens,
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
        else if (errType.includes('model_not_found')) errorCode = 'model_not_found';
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

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { message, mood, history } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'invalid_message' });
  }

  const systemPrompt = `你是「星夜」App 裡的 AI 陪伴者。你的角色是一個溫暖、有同理心的傾聽者。

## 你的個性
- 溫柔、有耐心，像深夜裡陪伴的朋友
- 不說教、不評判，以理解和接納為主
- 用繁體中文回應，語氣溫暖自然
- 回應簡短（2-4句話），不要長篇大論
- 適時用 ✦ 🌙 等符號增加溫度

## 重要原則
- 你不是心理諮商師，不做診斷或治療建議
- 如果使用者表達強烈的自我傷害意圖，溫柔地建議撥打安心專線 1925
- 不要重複使用者說過的話，用自己的方式回應
- 可以適當提問，引導對方多說一些
- 記住對話脈絡，不要每次都像第一次對話`;

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
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: 300,
        temperature: 0.8,
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI error:', response.status, errText);
      return res.status(502).json({ error: 'ai_service_error' });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content;

    if (!reply) {
      return res.status(502).json({ error: 'empty_response' });
    }

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
}

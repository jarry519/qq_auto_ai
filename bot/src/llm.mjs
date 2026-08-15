import { log } from './config.mjs';
import { fetchWeather } from './weather.mjs';

/**
 * DeepSeek(OpenAI 兼容)客户端,支持 AI 自主决定调用工具
 * 工具:web_search(联网搜索)、get_weather(天气)、get_current_time(时间)
 */
export function createLLM(config) {
  const { baseUrl, model, temperature, maxTokens } = config.llm;
  const webEnabled = config.llm.webSearch !== false;

  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          '搜索互联网获取最新资料。当问题涉及最新信息、事实查证、新闻、教程、资料查阅,或你不确定答案时使用。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '搜索关键词,简洁明确' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询某个城市的实时天气和未来3天预报。用户问天气/气温/下雨/湿度/台风时使用。',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市中文名,如 北京、广州' } },
          required: ['city'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_current_time',
        description:
          '获取当前日期和时间(北京时间)。用户问几点、几号、星期几、日期时必须调用本工具获取准确时间,不要使用你内部的时间或时钟。',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];

  async function completion(messages, maxTokensOverride, tools) {
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokensOverride ?? maxTokens,
      stream: false,
    };
    if (tools?.length) body.tools = tools;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 执行工具调用 */
  async function execTool(call) {
    const name = call.function?.name;
    try {
      const args = JSON.parse(call.function?.arguments || '{}');
      if (name === 'web_search') {
        if (!webEnabled) return '联网搜索已禁用。';
        log(`[工具] web_search: ${args.query}`);
        return (await webSearch(args.query)) || '搜索无结果。';
      }
      if (name === 'get_weather') {
        const city = args.city || config.defaultCity || '广州';
        log(`[工具] get_weather: ${city}`);
        return (await fetchWeather(city)) || `天气查询失败(城市:${city})。`;
      }
      if (name === 'get_current_time') {
        log('[工具] get_current_time');
        return formatNowZh();
      }
    } catch (e) {
      return `工具参数解析失败: ${e.message}`;
    }
    return '未知工具';
  }

  /**
   * 对话。opts: { extraSystem, maxTokens, tools }
   * tools=true 时 AI 可自主调用工具(最多 3 次,之后强制作答)
   */
  async function chat(messages, { extraSystem = '', maxTokens: mt, tools = false } = {}) {
    const msgs = [];
    if (extraSystem) msgs.push({ role: 'system', content: extraSystem });
    msgs.push(...messages);
    const MAX_TOOL_ROUNDS = 3;

    let lastErr;
    let toolRounds = 0;
    for (let round = 0; round < 8; round++) {
      try {
        const allowTools = toolRounds < MAX_TOOL_ROUNDS;
        const data = await completion(msgs, mt, allowTools ? TOOLS : undefined);
        const msg = data.choices?.[0]?.message;
        if (!msg) throw new Error('LLM 返回为空');

        // 1) 标准 JSON 工具调用
        const calls = allowTools ? msg.tool_calls || [] : [];
        if (calls.length) {
          const call = calls[0];
          msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: [call] });
          msgs.push({ role: 'tool', tool_call_id: call.id, content: await execTool(call) });
          toolRounds++;
          continue;
        }

        // 2) 兜底:模型用 XML 文本形式假装调用 → 解析并执行
        const xml = msg.content?.match(/<tool_calls>([\s\S]*?)<\s*[\/＼⁄∕]{0,3}\s*tool_calls\s*>/i);
        if (xml && allowTools) {
          const toolName = xml[1].match(/name="(web_search|get_weather|get_current_time)"/)?.[1];
          const q = xml[1].match(/<parameter name="(?:query|city)"[^>]*>([\s\S]*?)<\s*[\/＼⁄∕]{0,2}\s*parameter\s*>/i)?.[1];
          if (toolName) {
            log(`[工具(兜底)] ${toolName}`);
            const content =
              toolName === 'web_search'
                ? await webSearch(q || '')
                : toolName === 'get_weather'
                  ? await fetchWeather(q || config.defaultCity || '广州')
                  : formatNowZh();
            msgs.push({ role: 'user', content: `【工具结果】\n${content || '无结果'}` });
            toolRounds++;
            continue;
          }
        }

        // 3) 正常回答
        let content = cleanContent(msg.content || '');
        if (!content) {
          if (toolRounds >= MAX_TOOL_ROUNDS) {
            msgs.push({ role: 'system', content: '请直接输出最终回答正文,不要再发起工具调用。' });
            continue;
          }
          throw new Error('LLM 返回空内容');
        }
        return content;
      } catch (e) {
        lastErr = e;
        log(`LLM 调用失败(第${round + 1}次): ${e.message}`);
        await sleep(3000);
      }
    }
    throw lastErr ?? new Error('LLM 调用失败');
  }

  return { chat };
}

/** 当前时间(北京时间)字符串 */
export function formatNowZh() {
  const now = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `现在是北京时间 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())} 星期${week}`
  );
}

/** 测试 API Key 是否可用 */
export async function probeLLM(config) {
  const llm = createLLM(config);
  const reply = await llm.chat([{ role: 'user', content: '请只回复两个字:正常' }], { maxTokens: 10 });
  log(`DeepSeek API 连通,模型回复: ${reply}`);
  return reply;
}

/* ---------------- 联网搜索(Bing RSS 优先,DuckDuckGo 兜底) ---------------- */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchBing(query) {
  const xml = await get(`https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&mkt=zh-CN`);
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 8) {
    const it = m[1];
    const t = it.match(/<title>(.*?)<\/title>/s);
    const l = it.match(/<link>(.*?)<\/link>/s);
    const d = it.match(/<description>(.*?)<\/description>/s);
    if (!t || !l) continue;
    items.push(`- ${stripHtml(t[1])}\n  ${d ? stripHtml(d[1]) : ''}\n  ${l[1].replace(/&amp;/g, '&')}`);
  }
  return items;
}

async function searchDuckDuckGo(query) {
  const html = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const items = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && items.length < 8) {
    items.push(`- ${stripHtml(m[2])}\n  ${stripHtml(m[3])}\n  ${m[1]}`);
  }
  return items;
}

async function fetchPageText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 900);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 执行一次搜索(结果+前3个页面正文) */
export async function webSearch(query) {
  let items = [];
  try {
    items = await searchBing(query);
  } catch (e) {
    log(`Bing 搜索失败: ${e.message}`);
  }
  if (!items.length) {
    try {
      items = await searchDuckDuckGo(query);
    } catch (e) {
      log(`DuckDuckGo 搜索失败: ${e.message}`);
    }
  }
  if (!items.length) return null;
  const parts = [`搜索结果 ${items.length} 条:`, ...items];
  const urlRe = /https?:\/\/[^\s\n]+/;
  for (const url of items.map((it) => it.match(urlRe)?.[0]).filter(Boolean).slice(0, 3)) {
    const pageText = await fetchPageText(url);
    if (pageText && pageText.length > 100) parts.push(`\n【页面正文: ${url}】\n${pageText}`);
  }
  return parts.join('\n');
}

/** 保留兼容:向 system 注入搜索资料的旧接口(brain 不再直接使用) */
export async function fetchSearchContext(text, config) {
  if (config.llm.webSearch === false) return '';
  const query = text
    .replace(/@\d+/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[，。？！,.?!\s]/g, ' ')
    .trim()
    .slice(0, 40);
  if (!query || query.length < 4) return '';
  const result = await webSearch(query);
  if (!result) return '';
  return `\n【以下是刚搜索到的互联网资料,可参考,但不要编造资料里没有的内容】\n${result}\n`;
}

function cleanContent(s) {
  let r = String(s)
    .replace(/<\s*tool_calls[\s\S]*?<\s*[\/＼⁄∕]{0,3}\s*tool_calls\s*>/gi, '')
    .replace(/<\|tool_call\|>[\s\S]*?<\/\|tool_call\|>/g, '')
    .replace(/<search[\s\S]*?<\/search>/gi, '')
    .replace(/```(?:xml|json)?\s*[\s\S]*?```/g, '')
    .trim();
  const lt = r.indexOf('<');
  if (lt >= 0) r = r.slice(0, lt).trim();
  return r;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

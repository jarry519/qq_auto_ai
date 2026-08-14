import { log } from './config.mjs';

/**
 * DeepSeek(OpenAI 兼容)客户端。
 * 联网方案:由调用方决定是否需要搜索(brain 对提问/技术问题自动搜索),
 * 把搜索结果作为上下文注入提示词,模型无需函数调用,稳定可靠。
 */
export function createLLM(config) {
  const { baseUrl, model, temperature, maxTokens } = config.llm;

  async function completion(messages, maxTokensOverride) {
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokensOverride ?? maxTokens,
      stream: false,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('LLM 返回空内容');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  async function chat(messages, { extraSystem = '', maxTokens: mt } = {}) {
    const msgs = [];
    if (extraSystem) msgs.push({ role: 'system', content: extraSystem });
    msgs.push(...messages);

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(3000);
      try {
        return await completion(msgs, mt);
      } catch (e) {
        lastErr = e;
        log(`LLM 调用失败(第${attempt + 1}次): ${e.message}`);
      }
    }
    throw lastErr ?? new Error('LLM 调用失败');
  }

  return { chat };
}

/** 测试 API Key 是否可用 */
export async function probeLLM(config) {
  const llm = createLLM(config);
  const reply = await llm.chat([{ role: 'user', content: '请只回复两个字:正常' }], {
    maxTokens: 10,
  });
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

/** Bing RSS 搜索(稳定、国内可访问) */
async function searchBing(query) {
  const xml = await get(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&mkt=zh-CN`
  );
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 8) {
    const it = m[1];
    const t = it.match(/<title>(.*?)<\/title>/s);
    const l = it.match(/<link>(.*?)<\/link>/s);
    const d = it.match(/<description>(.*?)<\/description>/s);
    if (!t || !l) continue;
    const title = stripHtml(t[1]);
    const desc = d ? stripHtml(d[1]) : '';
    const link = l[1].replace(/&amp;/g, '&');
    items.push(`- ${title}\n  ${desc}\n  ${link}`);
  }
  return items;
}

async function searchDuckDuckGo(query) {
  const html = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const items = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && items.length < 5) {
    items.push(`- ${stripHtml(m[2])}\n  ${stripHtml(m[3])}\n  ${m[1]}`);
  }
  return items;
}

/** 执行一次搜索,返回格式化结果(失败返回 null) */
export async function webSearch(query) {
  try {
    const items = await searchBing(query);
    if (items.length) return '搜索结果:\n' + items.join('\n');
    log('Bing 无结果,尝试 DuckDuckGo');
  } catch (e) {
    log(`Bing 搜索失败: ${e.message}`);
  }
  try {
    const items = await searchDuckDuckGo(query);
    if (items.length) return '搜索结果:\n' + items.join('\n');
  } catch (e) {
    log(`DuckDuckGo 搜索失败: ${e.message}`);
  }
  return null;
}

/**
 * 为一条群消息生成联网资料上下文。
 * 返回可直接拼进 system 提示词的字符串;失败或未启用返回空串。
 */
export async function fetchSearchContext(text, config) {
  if (config.llm.webSearch === false) return '';
  const query = text
    .replace(/@\d+/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[，。？！,.?!\s]/g, ' ')
    .trim()
    .slice(0, 40);
  if (!query || query.length < 4) return '';

  // 1) 搜结果(最多 8 条)
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
  if (!items.length) return '';

  const parts = [`【搜索结果 ${items.length} 条】`, ...items];

  // 2) 抓取前 3 个页面的正文,补足细节
  const urlRe = /https?:\/\/[^\s\n]+/;
  const pageUrls = items
    .map((it) => it.match(urlRe)?.[0])
    .filter(Boolean)
    .slice(0, 3);
  for (const url of pageUrls) {
    const pageText = await fetchPageText(url);
    if (pageText && pageText.length > 100) {
      parts.push(`\n【页面正文: ${url}】\n${pageText}`);
    }
  }

  return `\n【以下是刚搜索到的互联网资料,可参考,但不要编造资料里没有的内容】\n${parts.join('\n')}\n`;
}

/** 抓取网页正文(去标签,截断) */
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
    const clean = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return clean.slice(0, 900);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

/** 专业技术问题特征 */
const TECH_RE =
  /代码|编程|报错|错误|bug|函数|接口|算法|编译|调试|配置|安装|部署|电路|单片机|传感器|嵌入式|C语言|C\+\+|python|Python|java|Java|javascript|js|JSON|API|数据库|SQL|Linux|linux|Ubuntu|docker|Docker|npm|node|Node|前端|后端|框架|数据结构|计算机网络|操作系统|硬件|软件|公式|数学|物理|模电|数电|git|Git|终端|命令行|依赖|模块|库|进程|线程|正则/;

/** 回复不完整特征(以这些结尾视为没答完) */
const INCOMPLETE_RE = /(…|\.\.\.|待续|未完|下回|下次再说|先写这么多|暂时先这样|后面补|以后再|下一条)$/;

/** 纯客套/预告话(没有实际内容) */
const STALL_RE = /^(好的?|好嘞|收到|嗯|稍等|等(我|一下)|让我|我来|我先|可以|行|没问题|OK|ok)[，。!！~～\s]*$/;

/** 把回复清洗成适合 QQ 群消息的纯文本(QQ 不渲染 Markdown) */
function cleanReplyText(text) {
  let t = String(text)
    // 代码块:去掉围栏但保留代码内容
    .replace(/```[\s\S]*?```/g, (m) => {
      const inner = m.replace(/^```.*$/gm, '').trim();
      return inner ? '\n' + inner + '\n' : '';
    })
    // 行内代码
    .replace(/`([^`]*)`/g, '$1')
    // 标题符
    .replace(/^#{1,6}\s*/gm, '')
    // 加粗/斜体
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    // 引用
    .replace(/^\s*>\s?/gm, '')
    // 列表符 → ·
    .replace(/^\s*[-*+]\s+/gm, '· ')
    // 占位符 ××、某某
    .replace(/[×✕✖][×✕✖]+/g, '……')
    // 动作/表情描述(全角括号包裹的短句)
    .replace(/[（(][^（）()]{1,14}[)）]/g, '')
    // 多余空行
    .replace(/\n{2,}/g, '\n')
    .trim();
  return t;
}

/**
 * 大脑:每个群一个会话,维护上下文、决定何时发言、控制频率
 */
export function createBrain(config, llm, api) {
  const sessions = new Map();
  let selfId = null;

  function histFile(groupId) {
    return path.join(DATA_DIR, `history_${groupId}.jsonl`);
  }

  /** 持久化:追加一条历史记录 */
  function appendHistory(s, entry) {
    s.history.push(entry);
    trimHistory(s);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(histFile(s.groupId), JSON.stringify(entry) + '\n');
    } catch (e) {
      log(`写入历史失败: ${e.message}`);
    }
  }

  /** 持久化:加载历史(重启后回忆) */
  function loadHistory(s) {
    try {
      const lines = fs
        .readFileSync(histFile(s.groupId), 'utf8')
        .split('\n')
        .filter(Boolean);
      for (const line of lines.slice(-config.behavior.historySize)) {
        const h = JSON.parse(line);
        if (h && h.content) s.history.push({ role: h.role, name: h.name, content: h.content });
      }
    } catch {
      /* 无历史文件,忽略 */
    }
  }

  function getSession(groupId) {
    let s = sessions.get(groupId);
    if (!s) {
      s = {
        groupId,
        history: [],        // [{role:'user'|'assistant', name, content}]
        lastBotAt: 0,       // 上次发言时间
        consecutiveBot: 0,  // 连续机器人发言数
        lastBotMsgIds: [],  // 机器人最近发出的消息id(用于识别"回复我"的消息)
        windowStart: 0,     // 每分钟计数窗口
        windowCount: 0,
        lastActivity: 0,    // 群内最近一次活跃(任意消息)
        proactiveTimer: null,
        processing: Promise.resolve(), // 串行队列,避免并发
      };
      sessions.set(groupId, s);
      loadHistory(s);
      scheduleProactive(s);
    }
    return s;
  }

  function setSelfId(id) {
    selfId = id;
  }

  function inQuietHours() {
    const now = new Date();
    for (const [start, end] of config.behavior.quietHours) {
      const h = now.getHours() + now.getMinutes() / 60;
      if (h >= start && h < end) return true;
    }
    return false;
  }

  function rateLimited(s, now = Date.now()) {
    const b = config.behavior;
    if (inQuietHours()) return true;
    if (now - s.lastBotAt < b.minIntervalSec * 1000) return true;
    if (now - s.windowStart > 60000) {
      s.windowStart = now;
      s.windowCount = 0;
    }
    if (s.windowCount >= b.maxPerMinute) return true;
    return false;
  }

  /** 中文提问特征 */
  const QUESTION_RE = /[？?]$|[吗呢嘛]$|什么|怎么|为什么|为啥|多少|哪|谁|几[点个位]|是不是|能不能|有没有|可否|咋|如何|啥|请教|求教|帮忙|帮个忙/;

  /** 要求具体作答的特征(提问/命令式要求) */
  const REQUEST_RE = /排名|排个名|锐评|点评|评一下|介绍|解释|讲一下|说说|告诉我|评价|对比|比较|分析|推荐|总结|怎么写|怎么用|怎么实现|怎么做|写个|写一|教我|帮我|来一个|列一下|有哪些|是什么|区别|原理|教程|步骤|方法|方案|代码/;

  /** 决定是否回复,返回原因或 null */
  function decide(ev, s) {
    const b = config.behavior;
    const isMention = ev.mentions.includes(String(selfId));
    const nameHit =
      b.replyToBotName &&
      (ev.text.includes(config.botName) || ev.text.includes(String(selfId)));
    // 有人回复了机器人的消息 → 接话
    const replyOnBot =
      b.replyToReplyOnBot &&
      s.lastBotMsgIds.length > 0 &&
      (ev.raw || []).some(
        (seg) => seg.type === 'reply' && s.lastBotMsgIds.includes(String(seg.data?.id))
      );
    // 疑似提问
    const isQuestion = b.replyToQuestion && QUESTION_RE.test(ev.text);

    // —— 上下文判断:这条消息是不是冲着机器人来的 ——
    const hist = s.history;
    // 上一条消息是机器人发的(对方紧跟着接话)
    const prevIsBot = hist.length > 0 && hist[hist.length - 1].role === 'assistant';
    // 机器人最近 5 分钟内发过言(还在对话状态)
    const botSpokeRecently = s.lastBotAt > 0 && Date.now() - s.lastBotAt < 5 * 60000;
    // 对方复读/引用了机器人说过的话(取机器人最后一条发言的前 8 字比对)
    const lastBotText = [...hist].reverse().find((h) => h.role === 'assistant')?.content || '';
    const echoesBot = lastBotText.length >= 8 && ev.text.includes(lastBotText.slice(0, 8));
    const directed = prevIsBot || echoesBot;

    if (b.replyWhenMentioned && isMention) return 'mention';
    // 别人 @ 了其他人(没 @ 机器人)→ 不插嘴
    if (b.ignoreWhenOthersMentioned && ev.mentions.length > 0 && !isMention && !nameHit) {
      return null;
    }
    if (b.replyToBotName && nameHit) return 'name';
    if (replyOnBot) return 'reply';

    if (isQuestion) {
      // 上下文明确在跟机器人说话 → 直接答
      if (directed) return 'question';
      // 机器人最近聊过,但不一定是问它 → 概率性回答
      if (botSpokeRecently) {
        if (Math.random() < b.questionWhenActiveProbability) return 'question';
        return null;
      }
      // 拿不准 → 小概率发一句确认试探
      if (b.probeWhenUnclear && Math.random() < b.probeProbability) return 'probe';
      // 大概率不是问机器人 → 不打扰
      return null;
    }

    // 非提问:紧跟在机器人发言后面的短消息,多半是回应机器人 → 接上(需开启)
    if (
      b.replyToFollowup &&
      directed &&
      Array.from(ev.text).length <= 25 &&
      s.consecutiveBot < b.maxConsecutiveReplies
    ) {
      return 'followup';
    }

    // 连续回复太多时,只响应 @、点名、回复和提问
    if (s.consecutiveBot >= b.maxConsecutiveReplies) return null;
    if (Math.random() < b.replyProbability) return 'random';
    return null;
  }

  async function onGroupMessage(ev, rawSegments) {
    const s = getSession(ev.group_id);
    s.lastActivity = Date.now();
    ev.raw = rawSegments;
    s.processing = s.processing.then(() => handleMessage(s, ev, rawSegments)).catch((e) => log(`处理消息出错: ${e.message}`));
  }

  async function handleMessage(s, ev, rawSegments) {
    const reason = decide(ev, s);
    pushHistory(s, ev, rawSegments);
    if (!reason) return;

    if (rateLimited(s)) {
      log(`[群${s.groupId}] 跳过回复(${reason}):频率受限`);
      return;
    }

    const isMention = ev.mentions.includes(String(selfId));
    // 对方在直接跟机器人说话,且是在提问/要求具体内容 → 强制正面具体回答
    const addressed = isMention || ['name', 'reply', 'question', 'probe'].includes(reason);
    const isRequest = REQUEST_RE.test(ev.text);
    // 被@但消息很短/无文字 → 简单应一声即可,不要猜话题
    const bareAtHint =
      addressed && Array.from(ev.text).length <= 2
        ? `\n对方@了你但没有附文字,简单、自然地回应一句即可(比如「在的,怎么了?」「有什么可以帮你?」),保持简短,不要自己猜测话题长篇大论。`
        : '';
    const directHint =
      addressed && isRequest
        ? `\n重要:对方正在对你说话,并在要求具体内容(提问/排名/解释/比较/分析/写东西等),你必须正面、具体地回答,直接给出答案,不要转移话题、不要反问别的事情、不要用玩笑或猜测搪塞,拿不准就明说并给思路。`
        : bareAtHint;
    // 按对方消息长度决定自己回复的长度
    const targetLen = Array.from(ev.text).length;
    let lengthHint;
    if (targetLen <= 4) {
      lengthHint = '对方只说了几个字,你的回复也要极短(10字以内),别话痨。';
    } else if (targetLen <= 15) {
      lengthHint = '对方说得简短,你也简短回应,一二十字即可。';
    } else if (targetLen <= 40) {
      lengthHint = '对方说了一段话,你的回应也可以稍长些,一两句话(30~50字)。';
    } else {
      lengthHint = '对方发了长文,你可以回应得充分些,两三句话(50~100字),但别啰嗦。';
    }
    const extra =
      (isMention
        ? `用户 @了你,请直接回应 ta。`
        : reason === 'name'
          ? `有人在群里提到你,自然接话。`
          : reason === 'reply'
            ? `有人回复了你的上一条消息,请回应 ta。`
            : reason === 'probe'
              ? `这条消息没有明确@你,但可能是在问你。先发一句简短的确认(比如「是在问我吗?」)并给出你的初步看法,一句话左右即可;若对方确认,再详细展开。`
              : reason === 'question'
                ? `根据上下文判断,这条提问是在问你。要求:正面、具体地回答对方的问题本身,直接给答案/方案/步骤,不要转移话题、不要反问别的事情、不要用玩笑或客套话回避;拿不准就明说并给思路。`
                : reason === 'followup'
                  ? `对方紧跟着你的发言说了句话,多半是在回应你,顺着自然接上,简短点。`
                  : `你决定参与聊天,顺着话题礼貌地接一句,简短得体,语气温和。`) +
      `\n回复长度要求:${lengthHint}${directHint}`;

    // 专业技术问题:允许较长,且必须一次性给出完整解答
    const isTech = TECH_RE.test(ev.text);
    const techHint = isTech
      ? `\n【这是专业技术问题】可以比平时长一些(几十到几百字都行):分点说明、给出步骤或代码示例,务必把解答写完整,不要省略关键部分、不要写到一半就停。\n重要:只能发一条消息!直接输出完整解答正文,绝对不要先说客套话或预告(如「好的」「收到」「让我看看」「稍等」「我先查一下」),也不要拆成多条消息发送。`
      : '';

    try {
      log(`[trace][群${s.groupId}] 开始生成回复 reason=${reason} 历史${s.history.length}条`);
      const msgs = buildMessages(s);
      // 时间类问题:把准确时间钉进最后一条消息(模型对最后消息服从度最高),并提示可用工具
      let timeDirective = '';
      if (/几点|几点了|现在时间|当前时间|什么时间|日期|几月几号|星期几|今天周几|今天几号|什么日子/.test(ev.text)) {
        const now = new Date();
        const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
        const pad = (n) => String(n).padStart(2, '0');
        const t = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())} 星期${week}`;
        timeDirective = `\n重要:现在是北京时间 ${t}。对方在问时间/日期,直接按这个时间回答,不要推算、不要使用内部时钟。`;
        msgs[msgs.length - 1].content += timeDirective;
      }
      // 对方直接跟机器人说话时,AI 可自主决定调用工具(搜索/天气/时间)
      let reply = await llm.chat(msgs, {
        extraSystem: extra + techHint,
        maxTokens: isTech ? 1500 : undefined,
        tools: addressed,
      });
      log(`[trace][群${s.groupId}] LLM完成: ${reply.slice(0, 40)}`);
      // 完整解答校验:技术问题若只发了客套话/预告,或明显没写完,重新生成
      if (
        isTech &&
        (INCOMPLETE_RE.test(reply) ||
          STALL_RE.test(reply) ||
          (reply.length <= 60 && /^(让我|我来|我先|等我|稍等|我去|给我|好的|好嘞|收到)/.test(reply)))
      ) {
        log(`[群${s.groupId}] 回复是客套话/不完整(${reply.slice(0, 30)}),重新生成...`);
        reply = await llm.chat(buildMessages(s), {
          extraSystem:
            extra +
            techHint +
            `\n注意:你刚才只发了客套话或预告,没有给出解答。请把完整解答一次性发完,开头直接进入正题。`,
          maxTokens: 1500,
          tools: addressed,
        });
      }
      await sendReply(s, ev, reply, true);
      log(`[trace][群${s.groupId}] 回复已发送`);
    } catch (e) {
      log(`[群${s.groupId}] 生成回复失败: ${e.message}`);
    }
  }

  function pushHistory(s, ev, rawSegments) {
    const name = ev.sender?.card || ev.sender?.nickname || `QQ${ev.user_id}`;
    appendHistory(s, {
      role: 'user',
      name: `${name}(${ev.user_id})`,
      content: ev.text,
    });
  }

  function pushBotHistory(s, content) {
    appendHistory(s, { role: 'assistant', name: config.botName, content });
  }

  function trimHistory(s) {
    while (s.history.length > config.behavior.historySize) s.history.shift();
  }

  function buildMessages(s) {    const sys = [config.persona];
    // 附上群信息(如有)
    if (s.groupName) sys.push(`当前群:「${s.groupName}」`);
    if (selfId) sys.push(`你是 ${config.botName},你的QQ号是 ${selfId}。`);
    // 当前时间(北京时间)
    const now = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    const pad = (n) => String(n).padStart(2, '0');
    sys.push(
      `现在是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ` +
        `${pad(now.getHours())}:${pad(now.getMinutes())} 星期${week}(北京时间),问时间/日期/星期就按这个回答。`
    );
    sys.push(
      '你有工具可用:web_search(联网搜索资料)、get_weather(查天气)、get_current_time(获取准确时间)。' +
        '当问题涉及实时信息(时间、日期、天气、最新新闻、教程资料等)时,必须主动调用对应工具,根据工具返回的结果回答,不要凭内部知识或内部时钟作答。'
    );
    sys.push('以下是最近聊天记录(每条前面是说话人):');

    const msgs = [
      {
        role: 'system',
        content: sys.join('\n'),
      },
    ];
    for (const h of s.history) {
      if (h.role === 'assistant') {
        msgs.push({ role: 'assistant', content: h.content });
      } else {
        msgs.push({ role: 'user', content: `${h.name}: ${h.content}` });
      }
    }
    msgs.push({
      role: 'user',
      content: `(现在轮到你「${config.botName}」说话,直接输出你的发言内容,不要加前缀)`,
    });
    return msgs;
  }

  async function sendReply(s, ev, text, withAt = true) {
    const clean = cleanReplyText(text);
    // 回复时 @ 目标(主动发言或 @ 自己除外)
    const shouldAt = withAt && ev.user_id && String(ev.user_id) !== String(selfId);
    const message = shouldAt
      ? [
          { type: 'at', data: { qq: String(ev.user_id) } },
          { type: 'text', data: { text: ' ' + clean } },
        ]
      : [{ type: 'text', data: { text: clean } }];
    const res = await api.sendGroupMsg(s.groupId, message);
    if (res?.message_id) {
      s.lastBotMsgIds.push(String(res.message_id));
      if (s.lastBotMsgIds.length > 6) s.lastBotMsgIds.shift();
    }
    s.lastBotAt = Date.now();
    s.windowCount++;
    s.consecutiveBot++;
    pushBotHistory(s, clean);
    log(`[群${s.groupId}] ${config.botName} 说: ${clean.slice(0, 60)}`);
  }

  /** 主动发言调度 */
  function scheduleProactive(s) {
    const b = config.behavior;
    if (!b.proactive) return;
    const min = b.proactiveMinMin * 60000;
    const max = b.proactiveMaxMin * 60000;
    const delay = min + Math.random() * (max - min);
    s.proactiveTimer = setTimeout(() => proactiveTick(s), delay);
  }

  async function proactiveTick(s) {
    const b = config.behavior;
    try {
      const now = Date.now();
      const groupActive =
        now - s.lastActivity < b.proactiveOnlyWhenActiveMin * 60000;
      if (groupActive && Math.random() < b.proactiveProbability && !rateLimited(s)) {
        s.processing = s.processing
          .then(async () => {
            const extra = `群里最近比较活跃,你现在主动说点什么:可以抛个话题、问大家一个问题、分享个小趣事,1~3句话,自然一点。`;
            const reply = await llm.chat(buildMessages(s), { extraSystem: extra });
            await sendReply(s, { group_id: s.groupId, user_id: selfId, mentions: [] }, reply, false);
          })
          .catch((e) => log(`[群${s.groupId}] 主动发言失败: ${e.message}`));
      } else if (!groupActive) {
        log(`[群${s.groupId}] 群已冷清,跳过主动发言`);
      }
    } finally {
      scheduleProactive(s);
    }
  }

  /** 缓存群名称 */
  async function refreshGroupInfo(groupId) {
    try {
      const info = await api.getGroupInfo(groupId);
      const s = getSession(groupId);
      s.groupName = info?.group_name || info?.name || undefined;
      if (s.groupName) log(`[群${groupId}] 群名: ${s.groupName}`);
    } catch {
      /* 忽略 */
    }
  }

  return {
    setSelfId,
    onGroupMessage,
    refreshGroupInfo,
    get sessionCount() {
      return sessions.size;
    },
  };
}

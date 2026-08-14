import { loadConfig, log } from './config.mjs';
import { createLLM, probeLLM } from './llm.mjs';
import { createBrain } from './brain.mjs';
import { segmentsToText } from './format.mjs';

const config = loadConfig();
const llm = createLLM(config);

let ws = null;
let selfId = null;
let seq = 0;
const pending = new Map();
let reconnectDelay = 3000;

const api = {
  sendGroupMsg(groupId, message) {
    return call('send_group_msg', { group_id: groupId, message });
  },
  getGroupInfo(groupId) {
    return call('get_group_info', { group_id: groupId });
  },
};

const brain = createBrain(config, llm, api);

function call(action, params) {
  return new Promise((resolve, reject) => {
    const echo = `req_${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(echo);
      reject(new Error(`API 超时: ${action}`));
    }, 15000);
    pending.set(echo, { resolve, reject, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

function connect() {
  let retried = false;
  const scheduleReconnect = () => {
    if (retried) return;
    retried = true;
    log(`连接失败/断开,${reconnectDelay / 1000}秒后重连...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  ws = new WebSocket(config.onebot.wsUrl);
  ws.onopen = () => {
    retried = false;
    log(`已连接 NapCat: ${config.onebot.wsUrl}`);
    reconnectDelay = 3000;
  };
  ws.onmessage = (ev) => {
    try {
      handleMessage(JSON.parse(ev.data));
    } catch (e) {
      log('解析消息失败:', e.message);
    }
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => scheduleReconnect();
}

function handleMessage(msg) {
  // API 响应
  if (msg.echo && pending.has(msg.echo)) {
    const p = pending.get(msg.echo);
    pending.delete(msg.echo);
    clearTimeout(p.timer);
    if (msg.status === 'ok' && !msg.retcode) p.resolve(msg.data);
    else p.reject(new Error(`OneBot 错误 retcode=${msg.retcode}: ${JSON.stringify(msg).slice(0, 200)}`));
    return;
  }

  // 生命周期事件:拿到自己的 QQ 号
  if (msg.post_type === 'meta_event' && msg.meta_event_type === 'lifecycle') {
    selfId = msg.self_id;
    brain.setSelfId(String(selfId));
    log(`登录成功,机器人 QQ: ${selfId}`);
    initGroups();
    return;
  }

  // 群消息
  if (msg.post_type === 'message' && msg.message_type === 'group') {
    const groupId = msg.group_id;
    if (!config.groups.includes(groupId)) return;

    const { text, mentions } = segmentsToText(msg.message);
    if (!text && mentions.length === 0) return; // 纯图片等,暂不处理

    // 自己的消息:只有 @自己 时才处理(方便手机端@自己调试),否则忽略,防止回声循环
    if (selfId && String(msg.user_id) === String(selfId)) {
      if (!mentions.includes(String(selfId))) return;
      log(`[群${groupId}] (自己@自己)`);
    }

    log(`[群${groupId}] ${msg.sender?.card || msg.sender?.nickname || msg.user_id}: ${text.slice(0, 50)}`);
    brain.onGroupMessage({ ...msg, text, mentions }, msg.message);
    return;
  }

  // 入群通知:欢迎新成员(可配置开关)
  if (msg.post_type === 'notice' && msg.notice_type === 'group_increase') {
    const groupId = msg.group_id;
    if (!config.groups.includes(groupId)) return;
    if (!config.behavior.welcomeNewMembers) return;
    api
      .sendGroupMsg(groupId, [
        { type: 'at', data: { qq: String(msg.user_id) } },
        { type: 'text', data: { text: ` 欢迎加入!我是${config.botName}~` } },
      ])
      .catch(() => {});
  }
}

function initGroups() {
  for (const gid of config.groups) {
    brain.refreshGroupInfo(gid);
  }
}

async function main() {
  log('==== QQ AI 机器人启动 ====');
  log(`监听群: ${config.groups.length ? config.groups.join(', ') : '(未配置,请编辑 bot/config.json 的 groups)'}`);
  if (!config.groups.length) {
    log('提示: 在 bot/config.json 里填入群号后重启即可生效');
  }

  // 先验证 DeepSeek key
  try {
    await probeLLM(config);
  } catch (e) {
    log(`DeepSeek API 测试失败: ${e.message}`);
    log('请检查 bot/.env 中的 DEEPSEEK_API_KEY');
    process.exit(1);
  }

  connect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

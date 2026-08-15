/**
 * 反应模块(reactor):AI 大脑,可随时重启(改代码/配置只需重启本进程)。
 * 通过本地 HTTP 与常驻网关(gateway.mjs)通信,不直接连接 NapCat,
 * 因此重启不会影响 QQ 登录态。
 */
import { loadConfig, log } from './config.mjs';
import { createLLM, probeLLM } from './llm.mjs';
import { createBrain } from './brain.mjs';

const config = loadConfig();
const GATEWAY = `http://127.0.0.1:${process.env.GATEWAY_PORT || 3211}`;

const llm = createLLM(config);

/** 经网关发送群消息 */
const api = {
  sendGroupMsg(groupId, message) {
    return fetch(`${GATEWAY}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: groupId, message }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) throw new Error(d.error || '发送失败');
        return { message_id: d.message_id };
      });
  },
  getGroupInfo() {
    return Promise.resolve({});
  },
};

const brain = createBrain(config, llm, api);

async function getSelfId() {
  try {
    const r = await fetch(`${GATEWAY}/health`);
    const d = await r.json();
    return d.selfId;
  } catch {
    return null;
  }
}

/** 长轮询拉取事件并处理 */
async function poll() {
  while (true) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(`${GATEWAY}/poll`, { signal: ctrl.signal });
      clearTimeout(timer);
      const { events } = await res.json();
      for (const ev of events || []) {
        if (ev.type === 'group_message') {
          brain.onGroupMessage(ev, ev.raw);
        }
      }
    } catch {
      // 网关暂不可用,等 3 秒重试
      await sleep(3000);
    }
  }
}

async function main() {
  log('==== 反应模块启动(可随时重启) ====');
  log(`监听群: ${config.groups.join(', ')}`);

  try {
    await probeLLM(config);
  } catch (e) {
    log(`DeepSeek API 测试失败: ${e.message}`);
    process.exit(1);
  }

  // 等待网关就绪
  let selfId = null;
  for (let i = 0; i < 20 && !selfId; i++) {
    selfId = await getSelfId();
    if (!selfId) await sleep(3000);
  }
  if (selfId) {
    brain.setSelfId(selfId);
    log(`已连接网关,机器人 QQ: ${selfId}`);
  } else {
    log('警告: 未能从网关获取 selfId,请确认 gateway.mjs 在运行');
  }

  poll();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

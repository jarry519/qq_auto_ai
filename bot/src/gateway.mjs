/**
 * 常驻网关(gateway):连接 NapCat OneBot WebSocket,永不重启。
 * - 接收群消息 → 推送给反应模块(reactor,本地 HTTP 长轮询)
 * - 代反应模块发送消息(OneBot API)
 * 反应模块(index.mjs)可随时重启改代码,不影响本进程与 QQ 登录态。
 */
import http from 'node:http';
import { loadConfig, log } from './config.mjs';
import { segmentsToText } from './format.mjs';

const config = loadConfig();
const PORT = 3211;

let ws = null;
let selfId = null;
let seq = 0;
const pending = new Map();
let reconnectDelay = 3000;

/** 事件队列(长轮询用) */
const events = [];
const waiters = [];
let nextEventId = 1;

/* ---------------- NapCat WebSocket ---------------- */

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
    log(`[网关] NapCat 连接失败/断开,${reconnectDelay / 1000}秒后重连...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  ws = new WebSocket(config.onebot.wsUrl);
  ws.onopen = () => {
    retried = false;
    log(`[网关] 已连接 NapCat: ${config.onebot.wsUrl}`);
    reconnectDelay = 3000;
  };
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data));
    } catch (e) {
      log(`[网关] 解析消息失败: ${e.message}`);
    }
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => scheduleReconnect();
}

function handle(msg) {
  if (msg.echo && pending.has(msg.echo)) {
    const p = pending.get(msg.echo);
    pending.delete(msg.echo);
    clearTimeout(p.timer);
    if (msg.status === 'ok' && !msg.retcode) p.resolve(msg.data);
    else p.reject(new Error(`OneBot 错误 retcode=${msg.retcode}`));
    return;
  }

  if (msg.post_type === 'meta_event' && msg.meta_event_type === 'lifecycle') {
    selfId = msg.self_id;
    log(`[网关] 登录成功,机器人 QQ: ${selfId}`);
    return;
  }

  // 群消息 → 推送给反应模块
  if (msg.post_type === 'message' && msg.message_type === 'group') {
    const groupId = msg.group_id;
    if (!config.groups.includes(groupId)) return;
    const { text, mentions } = segmentsToText(msg.message);
    if (!text && mentions.length === 0) return;
    // 自己的消息:只有 @自己 才转发
    if (selfId && String(msg.user_id) === String(selfId)) {
      if (!mentions.includes(String(selfId))) return;
      log(`[网关] (自己@自己)`);
    }
    const ev = {
      id: nextEventId++,
      type: 'group_message',
      group_id: groupId,
      user_id: msg.user_id,
      sender: msg.sender || {},
      text,
      mentions,
      raw: msg.message,
      time: msg.time,
    };
    pushEvent(ev);
    log(`[网关] 转发[群${groupId}] ${msg.sender?.card || msg.sender?.nickname || msg.user_id}: ${text.slice(0, 40)}`);
    return;
  }

  // 通知事件(入群等)也转发,供反应模块决定
  if (msg.post_type === 'notice') {
    pushEvent({ id: nextEventId++, type: 'notice', ...msg });
  }
}

/* ---------------- 本地 HTTP 服务(与反应模块通信) ---------------- */

function pushEvent(ev) {
  events.push(ev);
  // 唤醒一个长轮询
  const w = waiters.shift();
  if (w) w(events.splice(0, events.length));
}

function getBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // 长轮询:反应模块等待新事件(最多 25 秒)
    if (req.method === 'GET' && url.pathname === '/poll') {
      if (events.length) {
        res.end(JSON.stringify({ events: events.splice(0, events.length) }));
        return;
      }
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(finish);
        if (idx >= 0) waiters.splice(idx, 1);
        res.end(JSON.stringify({ events: [] }));
      }, 25000);
      const finish = (evs) => {
        clearTimeout(timer);
        res.end(JSON.stringify({ events: evs }));
      };
      waiters.push(finish);
      return;
    }

    // 发送消息(反应模块经此代发)
    if (req.method === 'POST' && url.pathname === '/send') {
      const body = await getBody(req);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        res.end(JSON.stringify({ ok: false, error: '未连接 NapCat' }));
        return;
      }
      try {
        const data = await call('send_group_msg', {
          group_id: body.group_id,
          message: body.message,
        });
        res.end(JSON.stringify({ ok: true, message_id: data?.message_id }));
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // 健康检查
    if (req.method === 'GET' && url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, selfId: selfId ? String(selfId) : null, wsConnected: !!ws && ws.readyState === WebSocket.OPEN }));
      return;
    }

    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`[网关] 本地服务已启动: http://127.0.0.1:${PORT} (反应模块经此连接)`);
});

process.on('uncaughtException', (e) => log(`[网关] 未捕获异常: ${e.message}`));

connect();
log('==== QQ 网关启动(常驻,勿重启) ====');

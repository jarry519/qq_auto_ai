/**
 * 离线告警监控:检测 QQ 账号掉线/被踢,弹桌面通知提醒扫码。
 * 用法: node src/watchdog.mjs (后台常驻,或加入 start.sh)
 *
 * 检测原理:
 *  - 网关 /health 的 wsConnected(OneBot WS 连接)
 *  - NapCat 日志中的「账号状态变更为离线」「KickedOffLine」
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadConfig, log } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const config = loadConfig();
const GATEWAY = `http://127.0.0.1:${process.env.GATEWAY_PORT || 3211}`;
const LOG_FILE = process.env.NAPCAT_LOG || path.join(PROJECT_ROOT, 'napcat-run.log');
const ALERT_FILE = path.join(PROJECT_ROOT, 'offline-alert.log');

let offlineSince = null;   // 开始离线的时间戳
let notifiedAt = 0;        // 上次通知时间
let lastLogSize = 0;

const CHECK_MS = 15000;        // 每 15 秒检查一次
const NOTIFY_COOLDOWN_MS = 10 * 60000; // 同一轮离线至少 10 分钟才重复通知
const NOTIFY_DELAY_MS = 20 * 1000;     // 离线持续 20 秒后才判定(避免瞬时抖动误报)

function notify(title, body) {
  try {
    execSync(`notify-send -u critical "${title}" "${body}"`, { timeout: 5000 });
    log(`[告警] ${title} ${body}`);
  } catch {
    // notify-send 不可用时,降级为写告警文件
    try {
      fs.appendFileSync(ALERT_FILE, `${new Date().toLocaleString('zh-CN', { hour12: false })} ${title} ${body}\n`);
      log(`[告警(降级为日志)] ${title} ${body}`);
    } catch (e) {
      log(`[告警失败] ${e.message}`);
    }
  }
}

/** 从 NapCat 日志判断账号是否离线(增量扫描尾部) */
function checkNapcatLog() {
  try {
    const size = fs.statSync(LOG_FILE).size;
    if (size < lastLogSize) lastLogSize = 0; // 日志被轮转/重写
    if (size === lastLogSize) return null;
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(size - lastLogSize);
    fs.readSync(fd, buf, 0, buf.length, lastLogSize);
    fs.closeSync(fd);
    lastLogSize = size;
    const text = buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
    if (/KickedOffLine|账号状态变更为离线/.test(text)) return '账号被踢下线或离线';
    // 发送失败(网络连接异常)= 会话半死状态(能收不能发),同样视为离线
    if (/发送 -> .*?发生错误[\s\S]*?网络连接异常|EventChecker Failed[\s\S]*?1006514/.test(text)) {
      return '会话异常(能收不能发,网络连接异常)';
    }
    if (/登录成功|账号状态变更为在线/.test(text)) return 'online';
    return null;
  } catch {
    return null;
  }
}

async function check() {
  const now = Date.now();

  // 真实在线探测:get_group_list(需真实网络通道;WS连接在≠在线)
  let online = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${GATEWAY}/login`, { signal: ctrl.signal });
    clearTimeout(timer);
    const d = await r.json();
    online = !!(d.ok && typeof d.groups === 'number');
  } catch {
    online = false;
  }

  // 2) NapCat 日志事件
  const logEvent = checkNapcatLog();
  if (logEvent === 'online') {
    online = true;
    if (offlineSince) {
      log(`[监控] 账号已恢复在线(离线了 ${Math.round((now - offlineSince) / 60000)} 分钟)`);
      notify('QQ 机器人已恢复在线', '账号重新登录成功,消息通道已恢复');
    }
    offlineSince = null;
  }
  if (logEvent && logEvent !== 'online') {
    log(`[监控] 检测到:${logEvent}`);
    online = false;
  }

  // 3) 判定离线
  if (online) {
    offlineSince = null;
    return;
  }
  if (!offlineSince) offlineSince = now;

  const lasted = now - offlineSince;
  if (lasted < NOTIFY_DELAY_MS) return; // 抖动窗口
  if (now - notifiedAt < NOTIFY_COOLDOWN_MS) return;

  notifiedAt = now;
  const minutes = Math.round(lasted / 60000);
  notify(
    '⚠️ QQ 机器人掉线了!',
    `账号可能被风控踢下线,已离线约 ${minutes} 分钟。请扫码重新登录:\n浏览器打开 http://127.0.0.1:6099 扫码,或查看桌面二维码。`
  );
}

async function main() {
  log('==== 离线告警监控启动 ====');
  log(`检查网关: ${GATEWAY} | 日志: ${LOG_FILE}`);
  // 初始化日志偏移
  try {
    lastLogSize = fs.statSync(LOG_FILE).size;
  } catch { /* 忽略 */ }
  setInterval(check, CHECK_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

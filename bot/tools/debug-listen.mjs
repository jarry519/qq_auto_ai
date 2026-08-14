// 调试工具:监听 NapCat 事件,打印原始 JSON 和 @ 判断过程
// 用法: node tools/debug-listen.mjs
import { segmentsToText } from '../src/format.mjs';

const WS_URL = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001';
let selfId = null;

const ws = new WebSocket(WS_URL);
ws.onopen = () => console.log('[debug] 已连接,等待事件...');
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  // 生命周期事件:记录 self_id
  if (msg.post_type === 'meta_event') {
    selfId = msg.self_id;
    console.log('[debug] lifecycle self_id =', selfId, typeof selfId);
    return;
  }
  // API 响应
  if (msg.echo) {
    console.log('[debug] API响应:', msg.status, msg.retcode);
    return;
  }
  if (msg.post_type === 'message' && msg.message_type === 'group') {
    const { text, mentions } = segmentsToText(msg.message);
    console.log('========================================');
    console.log('[debug] 原始事件(截断):', JSON.stringify(msg).slice(0, 500));
    console.log('[debug] group_id =', msg.group_id, '| user_id =', msg.user_id);
    console.log('[debug] segments =', JSON.stringify(msg.message));
    console.log('[debug] text =', JSON.stringify(text));
    console.log('[debug] mentions =', JSON.stringify(mentions));
    console.log('[debug] selfId =', selfId, '| String(selfId) =', String(selfId));
    console.log('[debug] isMention =', mentions.includes(String(selfId)));
    console.log('========================================');
  } else if (msg.post_type === 'notice') {
    console.log('[debug] notice:', msg.notice_type, JSON.stringify(msg).slice(0, 200));
  }
};
ws.onerror = (e) => console.log('[debug] WS错误:', e.message || e);
ws.onclose = () => console.log('[debug] 连接关闭');

// 临时工具:让机器人主动发一条消息
// 用法: node tools/say.mjs <群号> <消息内容>
const WS_URL = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001';
const [, , groupId, ...textParts] = process.argv;
const text = textParts.join(' ');

if (!groupId || !text) {
  console.error('用法: node tools/say.mjs <群号> <消息内容>');
  process.exit(1);
}

const ws = new WebSocket(WS_URL);
const timer = setTimeout(() => {
  console.error('连接超时');
  process.exit(1);
}, 10000);

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      action: 'send_group_msg',
      params: { group_id: Number(groupId), message: [{ type: 'text', data: { text } }] },
      echo: 'say',
    })
  );
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.echo === 'say') {
    clearTimeout(timer);
    console.log('发送结果:', msg.status === 'ok' ? '成功 ✅' : JSON.stringify(msg));
    ws.close();
    process.exit(0);
  }
};

ws.onerror = (e) => {
  clearTimeout(timer);
  console.error('WebSocket 错误:', e.message || e);
  process.exit(1);
};

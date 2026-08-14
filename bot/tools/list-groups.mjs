// 临时工具:列出机器人加入的所有群(通过 OneBot WS)
// 用法: node tools/list-groups.mjs
const WS_URL = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001';

const ws = new WebSocket(WS_URL);
const timer = setTimeout(() => {
  console.error('连接超时,请确认 NapCat 已启动');
  process.exit(1);
}, 10000);

ws.onopen = () => {
  ws.send(JSON.stringify({ action: 'get_group_list', params: {}, echo: 'list' }));
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.echo === 'list') {
    clearTimeout(timer);
    if (msg.status === 'ok' && msg.data) {
      console.log('=== 机器人所在的群 ===');
      for (const g of msg.data) {
        console.log(`${g.group_id}  ${g.group_name}`);
      }
      console.log(`共 ${msg.data.length} 个群`);
    } else {
      console.error('获取失败:', JSON.stringify(msg));
    }
    ws.close();
    process.exit(0);
  }
};

ws.onerror = (e) => {
  clearTimeout(timer);
  console.error('WebSocket 错误:', e.message || e);
  process.exit(1);
};

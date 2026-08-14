/**
 * OneBot 11 消息段 <-> 文本 转换
 */
export function segmentsToText(segments) {
  if (typeof segments === 'string') return { text: segments, mentions: [] };
  if (!Array.isArray(segments)) return { text: '', mentions: [] };

  const mentions = [];
  const parts = [];
  for (const seg of segments) {
    const d = seg.data || {};
    switch (seg.type) {
      case 'text':
        parts.push(d.text ?? '');
        break;
      case 'at':
        if (d.qq === 'all') parts.push('@全体成员');
        else {
          parts.push(`@${d.qq}`);
          mentions.push(String(d.qq));
        }
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'face':
        parts.push('[表情]');
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'reply':
        // 引用消息时保留简短标记(后续会截断)
        parts.push('[回复]');
        break;
      case 'json':
        parts.push('[卡片消息]');
        break;
      case 'forward':
        parts.push('[聊天记录]');
        break;
      default:
        parts.push(`[${seg.type}]`);
    }
  }
  return { text: parts.join('').trim(), mentions };
}

export function buildTextMessage(text) {
  return [{ type: 'text', data: { text } }];
}

/** 组合 @某人 + 文本 的回复消息 */
export function buildAtReply(userId, text) {
  return [
    { type: 'at', data: { qq: String(userId) } },
    { type: 'text', data: { text: ' ' + text } },
  ];
}

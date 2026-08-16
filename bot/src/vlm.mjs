/**
 * 本地视觉模型客户端(Qwen3-VL via llama.cpp llama-server)
 * 用途:识别群里的图片,把内容描述注入主 LLM 上下文
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = path.join(__dirname, '..', 'data', 'images');
const VLM_URL = process.env.VLM_URL || 'http://127.0.0.1:8080/v1/chat/completions';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

/**
 * 通过网关下载群图片,保存到本地,返回本地路径。
 * @param {Function} apiCall - 网关 API 调用函数 (action, params) => Promise<data>
 * @param {string} file - 消息段里的 image data.file / data.url
 */
export async function downloadImage(apiCall, file) {
  try {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    // get_image:返回本地缓存路径 + 远程 url
    const info = await apiCall('get_image', { file });
    if (!info) return null;
    const ext = (String(info.file_name || info.file || info.url || '')).match(/\.(png|jpe?g|gif|webp|bmp)(\?|$)/i)?.[1]?.toLowerCase() || 'jpg';
    const name = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const target = path.join(IMAGE_DIR, name);

    // 1) 优先:本地缓存路径直接复制(快且稳)
    if (info.file && typeof info.file === 'string' && info.file.startsWith('/')) {
      try {
        const buf = fs.readFileSync(info.file);
        if (buf.length >= 100) {
          fs.writeFileSync(target, buf);
          return target;
        }
      } catch {
        /* 本地文件不可读,走 URL */
      }
    }

    // 2) 兜底:远程 URL 下载
    const url = info.url;
    if (!url || typeof url !== 'string') return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    fs.writeFileSync(target, buf);
    return target;
  } catch (e) {
    log(`[VLM] 图片下载失败: ${e.message}`);
    return null;
  }
}

/** 让本地视觉模型描述一张图片 */
export async function describeImage(imagePath, prompt = '请用中文简要描述这张图片的内容') {
  try {
    const buf = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).slice(1).toLowerCase();
    const mime = MIME[ext] || 'image/jpeg';
    const base64 = buf.toString('base64');

    const body = {
      model: 'qwen3-vl',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      max_tokens: 400,
      temperature: 0.3,
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    const res = await fetch(VLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`VLM HTTP ${res.status}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('VLM 返回空内容');
    return content;
  } catch (e) {
    log(`[VLM] 识别失败: ${e.message}`);
    return null;
  }
}

/** 清理旧图片(保留最近 200 张,防止磁盘膨胀) */
export function cleanupImages() {
  try {
    const files = fs.readdirSync(IMAGE_DIR).map((f) => path.join(IMAGE_DIR, f));
    if (files.length > 200) {
      files
        .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
        .slice(0, files.length - 200)
        .forEach((f) => {
          try {
            fs.unlinkSync(f);
          } catch { /* 忽略 */ }
        });
    }
  } catch { /* 忽略 */ }
}

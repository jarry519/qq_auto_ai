import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

export function loadConfig() {
  loadEnv();
  const cfgPath = path.join(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    console.error('[配置错误] 缺少 DEEPSEEK_API_KEY,请检查 bot/.env');
    process.exit(1);
  }

  // 环境变量可覆盖部分配置
  if (process.env.BOT_NAME) config.botName = process.env.BOT_NAME;
  if (process.env.ONEBOT_WS_URL) config.onebot.wsUrl = process.env.ONEBOT_WS_URL;
  if (process.env.ONEBOT_TOKEN) config.onebot.token = process.env.ONEBOT_TOKEN;

  return { ...config, apiKey: key };
}

export function log(...args) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}]`, ...args);
}

# QQ 群 AI 机器人(OneBot 11 + DeepSeek + 本地视觉)

基于 **NapCat(OneBot 11 协议)+ Node.js + DeepSeek + 本地 Qwen3-VL** 的 QQ 群 AI 机器人:
AI 自主调用工具(搜索/天气/时间)、**本地图片识别**、上下文记忆、双模块热更新架构。

## 架构

```
NapCat(QQ登录态)
   ↑ WebSocket(OneBot 11, 127.0.0.1:3001)
[网关 gateway.mjs] ← 常驻,守住登录态,永不重启
   ↑ 本地HTTP(127.0.0.1:3211,长轮询+API代理)
[反应模块 index.mjs] ← AI大脑,可随时重启,不影响QQ登录
        ↓ 图片识别时
[本地视觉 Qwen3-VL] ← llama.cpp llama-server(127.0.0.1:8080)
[离线监控 watchdog.mjs] ← 掉线/被踢时桌面弹窗告警
```

## 功能

- **AI 自主工具调用**(OpenAI 函数调用):
  - `web_search` 联网搜索(Bing RSS + 网页正文)
  - `get_weather` 实时天气+3天预报(Open-Meteo,无需key)
  - `get_current_time` 准确时间(模型内部时钟不可靠,时间问题自动校准)
- **本地图片识别**:群友 @机器人 + 发图(同条消息或引用消息)→ 下载图片 → Qwen3-VL 识别 → 结合上下文回答
- **触发规则**:真@/文本提名字 → 必回;带问题 → 正面具体回答;空白@ → 简短应一声;其余静默(全部可配置)
- **上下文**:每群最近 256 条,持久化到 `bot/data/`,重启不丢
- **离线告警**:账号被踢/掉线/半死状态 → 桌面弹窗提醒扫码
- **技术问题**:AI 自主搜索 + 完整解答(禁止客套话/半截回复)
- **输出清洗**:自动去除 Markdown/动作描述等 QQ 不渲染的内容

## 部署(Linux)

```bash
# 1. 环境:Node.js ≥ 22、NapCat、QQ 客户端(参考 setup-qq.sh 与官方文档)
# 2. 配置
cp bot/.env.example bot/.env          # 填 DeepSeek Key
vim bot/config.json                   # 填群号 groups、botName
# 3. (可选)本地视觉模型:下载 Qwen3-VL GGUF 到 vlm/ 目录
#    modelscope download --model Qwen/Qwen3-VL-4B-Instruct-GGUF Qwen3VL-4B-Instruct-Q4_K_M.gguf mmproj-Qwen3VL-4B-Instruct-F16.gguf --local_dir vlm
#    并设置 LLAMA_SERVER 指向 llama.cpp 的 llama-server
# 4. 启动(NapCat + 网关 + 视觉 + 监控 + 反应模块)
./start.sh
# 5. 首次在 http://127.0.0.1:6099 扫码登录小号 QQ
# 6. 改代码只需重启反应模块(QQ 不掉线):
./restart-bot.sh          # 前台
./restart-bot.sh -b       # 后台(日志 bot/reactor.log)
```

## 目录

```
qqai-bot/
├── bot/
│   ├── config.json        # 配置(群号/名字/人设/行为)
│   ├── .env.example       # DeepSeek Key / VLM 地址
│   ├── src/
│   │   ├── gateway.mjs    # 常驻网关(连接NapCat/转发/API代理)
│   │   ├── index.mjs      # 反应模块(AI,可重启)
│   │   ├── brain.mjs      # 会话/决策/上下文/图片识别触发
│   │   ├── llm.mjs        # DeepSeek + AI工具调用 + 搜索
│   │   ├── weather.mjs    # 天气工具(Open-Meteo)
│   │   ├── vlm.mjs        # 本地视觉模型客户端(图片下载/识别)
│   │   ├── watchdog.mjs   # 离线告警监控
│   │   ├── format.mjs     # OneBot 消息段转换
│   │   └── config.mjs     # 配置加载
│   └── tools/             # list-groups / say / debug-listen
├── start.sh               # 一键启动(含视觉模型)
├── restart-bot.sh         # 只重启 AI(不重登)
├── setup-qq.sh            # QQ deb 解压注入(无root环境)
└── README.md
```

## 安全提醒

- ⚠️ 机器人行为有封号风险,务必使用小号
- API Key 只放 `bot/.env`(已被 .gitignore 排除)
- `bot/data/` 含聊天历史与识别过的图片,注意保管
- 自己账号发的消息 NapCat 不转发,测试用其他账号
- 掉线告警依赖桌面通知(notify-send),无桌面环境时降级为文件日志

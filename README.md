# QQ 群 AI 机器人(OneBot 11 + DeepSeek)

基于 **NapCat(OneBot 11 协议)+ Node.js + DeepSeek** 的 QQ 群 AI 机器人:登录一个 QQ 号作为机器人在群里收发消息,支持 AI 自主调用工具(联网搜索/天气/时间)、上下文记忆、双模块热更新架构。

## 架构(双模块)

```
NapCat(QQ登录态)
   ↑ WebSocket(OneBot 11, 127.0.0.1:3001)
[网关 gateway.mjs] ← 常驻,守住登录态,永不重启
   ↑ 本地HTTP(127.0.0.1:3211,长轮询)
[反应模块 index.mjs] ← AI大脑,可随时重启,不影响QQ登录
```

- **网关(gateway.mjs)**:连接 NapCat、转发消息、代发消息。**不要重启它**(重启需重新登录 QQ)
- **反应模块(index.mjs)**:AI 决策、上下文、工具调用。**改代码/配置后只需重启它**(`./restart-bot.sh`),QQ 不掉线

## 功能

- **AI 自主工具调用**(OpenAI 函数调用):
  - `web_search` 联网搜索(Bing RSS + 网页正文)
  - `get_weather` 实时天气+3天预报(Open-Meteo,无需key)
  - `get_current_time` 准确时间(模型内部时钟不可靠,时间问题强制校准)
- **触发规则**:真@/文本提名字 → 必回;带问题 → 正面具体回答;空白@ → 简短应一声;其余静默(全部可配置)
- **上下文**:每群最近 256 条,持久化到 `bot/data/`,重启不丢
- **技术问题**:AI 自主搜索 + 完整解答(禁止客套话/半截回复)
- **输出清洗**:自动去除 Markdown/动作描述等 QQ 不渲染的内容

## 快速开始(Linux)

```bash
# 1. 安装 NapCat + QQ 客户端(参考 setup-qq.sh 与官方文档)
# 2. 配置
cp bot/.env.example bot/.env      # 填 DeepSeek Key
vim bot/config.json               # 填群号 groups、botName
# 3. 启动(NapCat + 网关 + 反应模块)
./start.sh
# 4. 首次在 http://127.0.0.1:6099 扫码登录小号 QQ
# 5. 以后改代码只需:
./restart-bot.sh                  # 重启 AI,不重登 QQ
./restart-bot.sh -b               # 后台重启(日志 bot/reactor.log)
```

## 目录

```
qqai-bot/
├── bot/
│   ├── config.json        # 配置(群号/名字/人设/行为)
│   ├── .env.example       # DeepSeek Key 模板
│   ├── src/
│   │   ├── gateway.mjs    # 常驻网关(勿重启)
│   │   ├── index.mjs      # 反应模块(AI,可重启)
│   │   ├── brain.mjs      # 会话/决策/上下文
│   │   ├── llm.mjs        # DeepSeek + 工具调用 + 搜索
│   │   ├── weather.mjs    # 天气工具(Open-Meteo)
│   │   ├── format.mjs     # OneBot 消息段转换
│   │   └── config.mjs     # 配置加载
│   └── tools/             # list-groups / say / debug-listen
├── start.sh               # 一键启动
├── restart-bot.sh         # 只重启 AI(不重登)
├── setup-qq.sh            # QQ deb 解压注入(无root环境)
└── README.md
```

## 安全提醒

- ⚠️ 机器人行为有封号风险,务必使用小号
- API Key 只放 `bot/.env`(已被 .gitignore 排除)
- `bot/data/` 是聊天历史,注意保管
- 自己账号发的消息 NapCat 不转发,测试用其他账号

# QQ 群 AI 机器人(OneBot 11 + DeepSeek)

基于 **NapCat(OneBot 11 协议)+ Node.js + DeepSeek** 的 QQ 群机器人:登录一个 QQ 号作为机器人在指定群里收发消息,支持上下文记忆、联网搜索、按需开关各种发言行为。

## 架构

```
┌─────────────┐   WebSocket(OneBot 11)   ┌──────────────────┐   HTTPS   ┌────────────┐
│  NapCat     │ ◄──────────────────────► │  bot (Node.js)   │ ────────► │ DeepSeek   │
│ (QQ 客户端) │   ws://127.0.0.1:3001    │  src/index.mjs   │           │ API        │
└─────────────┘                          └──────────────────┘           └────────────┘
```

- **NapCat**:负责登录 QQ、收发群消息,提供 OneBot 11 WebSocket 接口(默认端口 3001,WebUI 端口 6099)
- **bot**:零依赖 Node.js 程序(仅用 Node 22 内置 WebSocket/fetch),管理群聊上下文、发言决策、联网搜索,调用 DeepSeek 生成回复

## 目录结构

```
qqai-bot/
├── bot/
│   ├── config.json     # 机器人配置(群号、名字、人设、行为开关)
│   ├── .env.example    # DeepSeek API Key(复制为 .env 并填写)
│   ├── package.json
│   ├── src/
│   │   ├── index.mjs   # 入口:WebSocket 连接 NapCat、事件分发
│   │   ├── brain.mjs   # 每群会话:上下文、发言决策、主动发言
│   │   ├── llm.mjs     # DeepSeek 客户端 + 联网搜索(Bing RSS/DDG)
│   │   ├── format.mjs  # OneBot 消息段 <-> 文本
│   │   └── config.mjs  # 配置加载(.env + config.json)
│   └── tools/
│       ├── list-groups.mjs  # 列出机器人加入的群
│       ├── say.mjs          # 让机器人主动发一条消息
│       └── debug-listen.mjs # 调试:打印原始事件和@判断
├── start.sh           # 一键启动(NapCat + bot)
├── setup-qq.sh        # 解压 QQ 客户端并注入 NapCat 入口
└── README.md
```

> 运行时还会生成:`bot/data/`(聊天历史持久化)、`qqconfig/`(QQ 数据目录)、`napcat/`(NapCat 本体)、`qqroot/`(QQ 客户端)、`libs/`(缺失系统库)。

## 快速开始

### 1. 准备运行环境

- Node.js ≥ 22
- Linux(带图形界面的桌面环境;无头服务器需自行装 Xvfb 或改用 Docker 部署 NapCat)

### 2. 安装 NapCat 与 QQ 客户端

```bash
# 下载 NapCat.Shell(最新版以 GitHub Releases 为准)
# https://github.com/NapNeko/NapCatQQ/releases/download/<版本>/NapCat.Shell.zip
mkdir -p napcat && unzip NapCat.Shell.zip -d napcat/

# 下载 QQ Linux 客户端 deb(与 NapCat 版本匹配,参考官方 napcat-docker 仓库的 Dockerfile)
mkdir -p qqroot && mv linuxqq_*.deb qqroot/linuxqq.deb

# 解压 QQ 并注入 NapCat 入口(需要 root 时改用手动解压,见下)
./setup-qq.sh
```

无 root 环境手动解压 deb:

```bash
dpkg-deb -x qqroot/linuxqq.deb qqroot/
```

### 3. 启动 NapCat 并扫码登录

```bash
./start.sh
```

浏览器打开 **http://127.0.0.1:6099**(NapCat WebUI),用**小号 QQ** 扫码登录(强烈建议专用小号,机器人行为有封号风险)。登录后 NapCat 会记住登录态,以后启动免扫码(把 QQ 号填进 `start.sh` 的 `ACCOUNT` 即可快速登录)。

### 4. 配置机器人

编辑 `bot/config.json`:

| 字段 | 说明 |
|---|---|
| `groups` | 要监听的**群号列表**,必填 |
| `botName` | 机器人名字(需与群名片一致时手动同步) |
| `persona` | 人设提示词,自由发挥 |
| `behavior.replyWhenMentioned` | 真 @ 时必回 |
| `behavior.replyToBotName` | 文本里出现名字/QQ号时也回(兼容手打@) |
| `behavior.replyProbability` | 普通聊天随机插话概率(0~1) |
| `behavior.proactive` | 主动发言(定时抛话题),需群活跃 |
| `behavior.quietHours` | 静默时段,如 `[["23","7"]]` 表示 23 点~7 点不说话 |
| `llm.webSearch` | 联网搜索开关 |

DeepSeek Key 填入 `bot/.env`(参考 `.env.example`)。

### 5. 启动机器人

```bash
cd bot && npm start
```

### 6. 验证

- 日志出现 `DeepSeek API 连通` 与 `登录成功,机器人 QQ: xxx`
- 在目标群里 @机器人(或文本提到它的名字),应收到回复(回复自动 @ 对方)

## 功能说明

### 发言决策(brain.mjs)
- **真 @ / 文本提到名字 / 提到QQ号** → 必回
- **空白@**(没附文字)→ 简短应一声(「在的,怎么了?」),不猜话题
- **提问/要求**(排名、解释、对比、分析…)→ 强制正面具体回答,不许玩笑搪塞
- **回复长度跟随对方**:对方几个字 → 回 10 字内;长文 → 回 50~100 字
- **别人 @ 别人时不插嘴**(`ignoreWhenOthersMentioned`)
- 其余消息一律静默(纯@模式)

### 上下文系统
- 每群保留最近 `historySize` 条消息(默认 30)喂给模型
- 全量持久化到 `bot/data/history_<群号>.jsonl`,**重启后自动加载**,可跨会话回忆

### 联网搜索
- 提问/技术问题时自动搜索(Bing RSS 优先,DuckDuckGo 兜底),抓取前 3 个网页正文,注入上下文
- 搜索失败自动降级为基于已有知识回答

### 技术问题
- 命中技术关键词(代码/电路/算法/报错等)时允许长回答,分点/给代码
- 强制**一条消息发完**:检测到客套话/预告/半截回复会自动重新生成

## 防封号与安全提醒

- ⚠️ 任何机器人行为都有封号风险,**务必使用小号**,不要用主号
- 频率限制可按需开启(`minIntervalSec`/`maxPerMinute`/`maxConsecutiveReplies`)
- API Key 只放在 `bot/.env`(已被 `.gitignore` 排除),不要提交到公开仓库
- 聊天历史(`bot/data/`)包含群聊内容,注意保管
- **自己账号发的消息 NapCat 默认不转发**(协议层过滤),手机登录同账号无法触发机器人;测试请用其他账号

## 常见问题

- **连不上 NapCat**:确认 NapCat 已登录,`napcat/config/onebot11_<QQ号>.json` 中 WebSocket Server 端口与 `onebot.wsUrl` 一致(默认 3001)
- **手打 @ 不触发**:QQ 中只有点名片选择联系人才是"真@";已内置文本名字识别,消息里带机器人名字(或QQ号)同样触发
- **扫码登录后重启又要扫码**:确认启动命令带 `-q <QQ号>`(见 `start.sh`),且 QQ 数据目录可写(`XDG_CONFIG_HOME` 已指向工作区)
- **搜索失败**:检查网络能否访问 bing.com;Bing 失败会自动尝试 DuckDuckGo

# discord_dm

微信ClawBot(见 [wx_dm](https://github.com/Yanming41/wx_dm))在"主动推送通知"和"发图片"这两件事上
踩了协议限制的坑(会话窗口限制、图片发送协议没打通)，于是转向Discord bot。这个仓库现在是
**独立的Discord纯传输层**——跟wx_dm一个设计思路：不含任何"这条消息该长什么样、点了按钮该
回什么"的业务逻辑，外部程序(比如
[scooter-dm-helper](https://github.com/Yanming41/scooter-dm-helper) 的
`furniture_watch.mjs`，小红书二手listing监控)靠两个文件跟它通信，不需要知道discord.js的
任何细节。

## 核心：`discord_dm.mjs`

常驻运行，同一个终端自带交互式控制台(敲`help`看命令)，同时对外提供两个文件接口：

- `outbox.jsonl` —— 外部程序写，本脚本读 —— 想发的消息(纯文字/富文本卡片/回复某次按钮点击)
- `inbox.jsonl` —— 本脚本写，外部程序读 —— 收到的按钮点击事件

具体的消息格式、字段说明见`discord_dm.mjs`文件头部的注释。

```bash
npm install
cp .env.example .env   # 填自己的 DISCORD_TOKEN / DISCORD_GUILD_ID / DISCORD_CHANNEL_ID
node discord_dm.mjs    # 常驻运行 + 交互式控制台
```

需要一个已经加进目标服务器、有发消息/管理webhook权限的Discord bot token。

## 历史/demo脚本(不是生产代码，留着当参考)

- `demo.mjs` —— 最早挨个试Discord bot几种组件时写的：纯文字消息、富文本卡片(embed)、
  带按钮的消息、webhook发消息、斜杠指令(`/status`)、表情回应。
- `send_batch.mjs` —— 在demo基础上做的实际场景演示(读小红书数据、Gemini多模态分类、
  发到Discord)，这里验证出来的逻辑后来抽成了`discord_dm.mjs`这个通用传输层 +
  `furniture_watch.mjs`里的业务逻辑，两者分开。
- `listen.mjs` —— 单独跑一个只监听按钮交互的进程，`discord_dm.mjs`出现之前用来单独调交互
  逻辑。

## 已知的坑

- **Discord的图片URL防盗链问题跟小红书CDN有关，不是Discord的问题**——小红书CDN会检查
  `Referer`头，直接把小红书图片链接塞进`embed.setImage(url)`，Discord服务器去抓图时不带这个
  头会被拒绝，图片显示不出来。得要么下载到本地再当附件发(`AttachmentBuilder`+
  `attachment://文件名`引用)，要么自己带着`Referer: https://www.xiaohongshu.com/`头下载完
  再传。`discord_dm.mjs`的`outbox.jsonl`接口只接受本机文件路径，就是因为这个原因。
- **多图展示技巧**：Discord会把"共用同一个`url`字段"的多个embed自动排成图集(grid)展示，
  不需要自己拼图——一条消息发多个embed，第一个带完整信息(标题/描述/字段)，其余的只带
  `setURL(同一个url)`+`setImage(...)`就行。
- **按钮交互的3秒响应限制 + 跨进程异步回复**：Discord要求按钮点击后3秒内必须响应
  (`deferReply`)，但"该回什么内容"往往需要外部程序去查数据才知道，等不起3秒。解法：
  `discord_dm.mjs`收到点击先`deferReply`占住交互，把`{application_id, token}`写进
  `inbox.jsonl`；外部程序查完数据后，把回复内容连同这个`token`写回`outbox.jsonl`；
  `discord_dm.mjs`用Discord的webhook消息编辑接口(`PATCH /webhooks/{id}/{token}/messages/@original`)
  把内容填进去——这个接口只需要token字符串，不需要原始的interaction对象，所以能跨进程/
  延后很久再回复。
- Gemini返回结果有时候不老实按```json代码块回答，会直接吐裸JSON——解析的时候两种都要试。

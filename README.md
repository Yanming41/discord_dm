# discord_dm

微信ClawBot(见 [wx_dm](https://github.com/Yanming41/wx_dm))在"主动推送通知"和"发图片"这两件事上
踩了协议限制的坑(会话窗口限制、图片发送协议没打通)，于是转向Discord bot——这个仓库是探索
Discord bot能力时留下的demo脚本，最终把摸索出的用法(embed卡片、按钮交互、多图图集、消息回复
链接)整理接进了 [scooter-dm-helper](https://github.com/Yanming41/scooter-dm-helper) 的
`furniture_watch.mjs`(小红书二手listing监控 → Discord通知)。

## 里面有什么

- `demo.mjs` —— 挨个试了一遍Discord bot的几种组件：纯文字消息、富文本卡片(embed)、
  带按钮的消息(真实可交互)、webhook发消息(不走bot登录)、斜杠指令(`/status`)、表情回应。
- `send_batch.mjs` —— 在demo基础上做的实际场景演示：读小红书抓取数据，用Gemini(结合文字+
  全部图片)判断有没有目标商品，命中的用embed+图集+按钮发到Discord，点"感兴趣"按钮能拿到
  原贴链接。这个脚本验证过的逻辑后来搬进了`furniture_watch.mjs`。
- `listen.mjs` —— 单独跑一个只监听按钮交互(不发消息)的进程，方便调交互逻辑不用重新触发
  一遍发送流程。
- `load_env.mjs` —— 跟其它项目一样的极简`.env`加载器。

## 用法

```bash
npm install
cp .env.example .env   # 填自己的 DISCORD_TOKEN / DISCORD_GUILD_ID / DISCORD_CHANNEL_ID
node demo.mjs           # 跑一遍组件演示
```

需要一个已经加进目标服务器、有发消息/管理webhook权限的Discord bot token。

## 已知的坑

- **Discord的图片URL防盗链问题跟小红书CDN有关，不是Discord的问题**——小红书CDN会检查
  `Referer`头，直接把小红书图片链接塞进`embed.setImage(url)`，Discord服务器去抓图时不带这个
  头会被拒绝，图片显示不出来。得要么下载到本地再当附件发(`AttachmentBuilder`+
  `attachment://文件名`引用)，要么自己带着`Referer: https://www.xiaohongshu.com/`头下载完
  再传。
- **多图展示技巧**：Discord会把"共用同一个`url`字段"的多个embed自动排成图集(grid)展示，
  不需要自己拼图——一条消息发多个embed，第一个带完整信息(标题/描述/字段)，其余的只带
  `setURL(同一个url)`+`setImage(...)`就行。
- Gemini返回结果有时候不老实按```json代码块回答，会直接吐裸JSON——解析的时候两种都要试。

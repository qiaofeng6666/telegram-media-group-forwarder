# Telegram Media Group Forwarder Bot

一个 Cloudflare Workers 上的 Telegram 机器人，能够将媒体组（相册）作为整体转发，保持原有的多图/多视频相册结构。

## 功能特点

- ✅ **媒体组整体转发** - 将多张图片/视频作为一个相册转发
- ✅ **无引用转发** - 使用 copyMessages API，不显示"转发自xxx"
- ✅ **自动删除原消息** - 转发成功后自动清理
- ✅ **用户隔离** - 只响应授权用户的消息
- ✅ **完全免费** - 运行在 Cloudflare Workers 免费计划上

## 部署步骤

### 1. 创建 Telegram Bot
- 在 Telegram 中搜索 @BotFather
- 发送 `/newbot` 创建机器人
- 保存获得的 Bot Token

### 2. 获取你的用户 ID
- 搜索 @userinfobot
- 发送任意消息，获取你的用户 ID

### 3. 部署到 Cloudflare Workers

1. 复制 `worker.js` 中的代码
2. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
3. 进入 Workers 和 Pages → 创建 Worker
4. 粘贴代码并保存
5. 设置环境变量：
   - `BOT_TOKEN`: 你的 Bot Token
   - `ADMIN_USER_ID`: 你的用户 ID
6. 访问 `https://你的worker域名/setwebhook` 设置 webhook

### 4. 测试
- 转发多张图片/视频给你的机器人
- 机器人会作为相册整体转发给你

## 环境变量

| 变量名 | 说明 |
|--------|------|
| `BOT_TOKEN` | Telegram Bot Token |
| `ADMIN_USER_ID` | 授权用户的 Telegram ID |

## 调试端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 查看缓冲区状态 |
| `/flush` | POST | 手动发送所有缓冲消息 |
| `/clearbuffer` | POST | 清空缓冲区 |

## 许可证

MIT License

# Telegram Media Group Forwarder Bot

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/qiaofeng6666/telegram-media-group-forwarder)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Cloudflare Workers](https://img.shields.io/badge/Platform-Cloudflare_Workers-orange)](https://workers.cloudflare.com)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-blue)](https://core.telegram.org/bots/api)

一个运行在 Cloudflare Workers 上的 Telegram 机器人，能够将媒体组（相册）作为整体转发，保持原有的多图/多视频相册结构。

## ✨ 功能特点

- 📸 **媒体组整体转发** - 将多张图片/视频作为一个相册转发
- 🔄 **无引用转发** - 使用 copyMessages API，不显示"转发自xxx"
- 🗑️ **自动删除原消息** - 转发成功后自动清理
- 🔒 **用户隔离** - 只响应授权用户的消息
- 💰 **完全免费** - 运行在 Cloudflare Workers 免费计划上

## 🔧 技术原理

### 核心挑战
Telegram 的 Webhook 在推送媒体组（相册）时，会将相册中的每一条消息**分别、独立地推送**，且所有消息拥有相同的 `media_group_id`。如果逐条处理，原本的相册就会被打散成独立消息。

### 解决方案
1. **缓存合并**：使用 `media_group_id` 作为缓存键，将短时间内到达的同组消息收集到缓冲区
2. **批量转发**：当收集完成时（检测到不同媒体组、收到普通消息或达到10条上限），调用 `copyMessages` API 一次性转发所有消息
3. **保留相册结构**：`copyMessages` 会自动保持消息的相册分组，且不显示"转发自xxx"

### 工作流程
用户发送3张图片（相册）
↓
Telegram Webhook 推送3条独立消息（相同 media_group_id）
↓
机器人缓存这3条消息
↓
检测到不同媒体组或普通消息时触发
↓
调用 copyMessages 批量转发 → 保持相册结构
↓
删除用户原始消息

## 🚀 快速部署

### 方式一：一键部署（推荐）

点击上方的一键部署按钮，按照提示完成部署：
1. 授权 Cloudflare 访问 GitHub
2. 创建 API Token（只需 Workers 编辑权限）
3. 等待自动部署完成
4. 在 Cloudflare Dashboard 设置环境变量

### 方式二：手动部署

#### 1. 创建 Telegram Bot
- 在 Telegram 中搜索 [@BotFather](https://t.me/botfather)
- 发送 `/newbot` 创建机器人
- 保存获得的 Bot Token

#### 2. 获取你的用户 ID
- 搜索 [@userinfobot](https://t.me/userinfobot)
- 发送任意消息，获取你的用户 ID

#### 3. 部署到 Cloudflare Workers
1. 复制 `worker.js` 中的代码
2. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
3. 进入 **Workers 和 Pages** → **创建 Worker**
4. 粘贴代码并保存
5. 在 **设置** → **变量** 添加环境变量：
   - `BOT_TOKEN`: 你的 Bot Token
   - `ADMIN_USER_ID`: 你的用户 ID
6. 访问 `https://你的worker域名/setwebhook` 设置 webhook

### 4. 测试
- 转发多张图片/视频给你的机器人
- 机器人会作为相册整体转发给你

## 📋 环境变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `BOT_TOKEN` | Telegram Bot Token | `1234567890:ABCdefGHIjkl...` |
| `ADMIN_USER_ID` | 授权用户的 Telegram ID | `123456789` |

## 🔧 调试端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 查看缓冲区状态 |
| `/flush` | POST | 手动发送所有缓冲消息 |
| `/clearbuffer` | POST | 清空缓冲区 |
| `/webhookinfo` | GET | 查看 webhook 状态 |

## 📝 技术说明

### 核心 API
- `copyMessages` - 批量复制消息，保持相册分组
- `deleteMessage` - 删除原始消息
- `setWebhook` - 设置 webhook 回调

### 触发发送的三种条件
1. **检测到不同媒体组 ID** - 开始新相册，发送上一个
2. **收到普通消息** - 没有 media_group_id 的消息触发发送
3. **达到 10 条上限** - 媒体组最多 10 条，立即发送

## ❓ 常见问题

### Q: 为什么我转发 3 张图片时，机器人没有立即转发？
A: 机器人会等待同一媒体组的所有消息。转发完 3 张后，再发送一条普通消息或等待触发条件即可。如果希望立即发送，可以访问 `/flush` 端点手动触发。

### Q: 可以转发视频和图片混合的相册吗？
A: 可以，Telegram 支持混合媒体组，`copyMessages` 会保持原始格式。

### Q: 机器人会回复其他人吗？
A: 不会，只响应 `ADMIN_USER_ID` 指定的用户，其他人发送消息会被完全忽略。

### Q: 为什么不用 `sendMediaGroup`？
A: `sendMediaGroup` 需要重建媒体内容，容易出错且会丢失说明文字。`copyMessages` 直接复制原消息，更可靠且无引用。

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## ⭐ Star 支持

如果这个项目对你有帮助，欢迎 Star 支持一下！

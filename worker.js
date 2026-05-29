// ==================== 配置说明 ====================
// 需要在 Cloudflare Worker 环境变量中设置：
// - BOT_TOKEN: Telegram Bot Token
// - ADMIN_USER_ID: 管理员用户ID（数字）
// =================================================

// 内存缓存：存储媒体组消息
const mediaGroupCache = new Map();

// 辅助函数：发送请求到 Telegram API
async function tgRequest(token, method, params) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Telegram API error in ${method}: ${errorText}`);
    throw new Error(`Telegram API error: ${response.status}`);
  }
  return response.json();
}

// 辅助函数：删除消息
async function deleteMessage(token, chatId, messageId) {
  try {
    return await tgRequest(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch (error) {
    console.error(`删除消息失败: ${error.message}`);
    return false;
  }
}

// 辅助函数：无引用转发单条消息
async function copyMessage(token, chatId, fromChatId, messageId) {
  return await tgRequest(token, 'copyMessage', {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId
  });
}

// 辅助函数：发送媒体组（相册）
async function sendMediaGroup(token, chatId, mediaGroupInput) {
  return await tgRequest(token, 'sendMediaGroup', {
    chat_id: chatId,
    media: mediaGroupInput
  });
}

// 发送媒体组并删除原消息
async function flushMediaGroup(token, kvKey, chatId) {
  const cache = mediaGroupCache.get(kvKey);
  if (!cache || cache.messages.length === 0) return;
  
  // 防止重复发送
  if (cache.isSending) return;
  cache.isSending = true;
  
  const messageCount = cache.messages.length;
  console.log(`📦 发送媒体组 (${messageCount}条): ${kvKey}`);
  
  try {
    // 构建媒体组
    const mediaGroupInput = cache.messages.map(msg => {
      if (msg.type === 'photo') {
        return {
          type: 'photo',
          media: msg.fileId,
          caption: msg.caption || ''
        };
      } else if (msg.type === 'video') {
        return {
          type: 'video',
          media: msg.fileId,
          caption: msg.caption || ''
        };
      } else if (msg.type === 'document') {
        return {
          type: 'document',
          media: msg.fileId,
          caption: msg.caption || ''
        };
      }
      return null;
    }).filter(m => m !== null);
    
    if (mediaGroupInput.length > 0) {
      await sendMediaGroup(token, chatId, mediaGroupInput);
    }
    
    // 删除所有原消息
    for (const msg of cache.messages) {
      await deleteMessage(token, chatId, msg.messageId);
    }
    console.log(`🗑️ 删除 ${messageCount} 条原消息`);
    
  } catch (error) {
    console.error(`发送媒体组失败: ${error.message}`);
  }
  
  // 清除缓存
  mediaGroupCache.delete(kvKey);
}

// 创建延迟发送的 Promise
function createTimerPromise(env, token, kvKey, chatId, delayMs = 500) {
  return new Promise((resolve) => {
    setTimeout(async () => {
      const cache = mediaGroupCache.get(kvKey);
      if (cache && !cache.flushed && cache.messages.length > 0) {
        await flushMediaGroup(token, kvKey, chatId);
      }
      resolve();
    }, delayMs);
  });
}

// 处理媒体组缓存
async function handleMediaGroup(env, message, groupId, chatId, messageId, ctx) {
  const token = env.BOT_TOKEN;
  const kvKey = `mg_${chatId}_${groupId}`;
  
  // 提取消息中的媒体信息
  let mediaInfo = null;
  
  if (message.photo) {
    const largestPhoto = message.photo[message.photo.length - 1];
    mediaInfo = { 
      type: 'photo', 
      fileId: largestPhoto.file_id,
      caption: message.caption || ''
    };
  } else if (message.video) {
    mediaInfo = { 
      type: 'video', 
      fileId: message.video.file_id,
      caption: message.caption || ''
    };
  } else if (message.document) {
    mediaInfo = { 
      type: 'document', 
      fileId: message.document.file_id,
      caption: message.caption || ''
    };
  } else {
    return false;
  }
  
  // 获取或创建缓存
  let cache = mediaGroupCache.get(kvKey);
  
  if (!cache) {
    cache = {
      messages: [],
      flushed: false,
      isSending: false,
      createdAt: Date.now()
    };
    
    // 创建延迟发送的 Promise
    const timerPromise = createTimerPromise(env, token, kvKey, chatId, 500);
    cache.timerPromise = timerPromise;
    ctx.waitUntil(timerPromise);
    
    mediaGroupCache.set(kvKey, cache);
  }
  
  // 添加消息到缓存
  cache.messages.push({
    ...mediaInfo,
    messageId: messageId,
    timestamp: Date.now()
  });
  
  // 如果达到10条，立即发送
  if (cache.messages.length >= 10 && !cache.flushed && !cache.isSending) {
    cache.flushed = true;
    await flushMediaGroup(token, kvKey, chatId);
  }
  
  return true;
}

// 清理过期缓存
function cleanExpiredCache() {
  const now = Date.now();
  const EXPIRE_TIME = 10000;
  
  for (const [key, cache] of mediaGroupCache.entries()) {
    if (now - cache.createdAt > EXPIRE_TIME) {
      mediaGroupCache.delete(key);
    }
  }
}

// 主处理函数
async function handleUpdate(update, env, ctx) {
  if (!update.message) return;
  
  const message = update.message;
  const chatId = message.chat.id;
  const fromId = message.from.id;
  const messageId = message.message_id;
  
  const adminUserId = parseInt(env.ADMIN_USER_ID);
  const token = env.BOT_TOKEN;
  
  // 权限验证
  if (fromId !== adminUserId) {
    console.log(`拒绝非管理员: ${fromId}`);
    return;
  }
  
  // 清理过期缓存
  cleanExpiredCache();
  
  const mediaGroupId = message.media_group_id;
  
  // 无媒体组ID，直接转发
  if (!mediaGroupId) {
    try {
      await copyMessage(token, chatId, chatId, messageId);
      await deleteMessage(token, chatId, messageId);
      console.log(`✅ 转发单条消息并删除`);
    } catch (error) {
      console.error(`转发失败: ${error.message}`);
    }
    return;
  }
  
  // 处理媒体组
  await handleMediaGroup(env, message, mediaGroupId, chatId, messageId, ctx);
}

// Worker 入口
export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    
    if (!env.BOT_TOKEN || !env.ADMIN_USER_ID) {
      console.error('环境变量未配置');
      return new Response('Configuration error', { status: 500 });
    }
    
    try {
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env, ctx));
      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error(`处理错误: ${error.message}`);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};

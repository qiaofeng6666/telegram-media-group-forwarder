// ==================== 配置说明 ====================
// 需要在 Cloudflare Worker 环境变量中设置：
// - BOT_TOKEN: Telegram Bot Token
// - ADMIN_USER_ID: 管理员用户ID（数字）
// =================================================

// 内存缓存：存储媒体组消息
const mediaGroupCache = new Map();

// Promise 缓存：防止并发创建重复缓存
const pendingGroupPromises = new Map();

// 全局清理调度器标志
let cleanupScheduled = false;

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
async function flushMediaGroup(token, kvKey, chatId, ctx) {
  const cache = mediaGroupCache.get(kvKey);
  if (!cache || cache.messages.length === 0) {
    console.log(`⚠️ 无缓存或空缓存，跳过发送: ${kvKey}`);
    return;
  }
  
  // 使用原子操作防止重复发送
  if (cache.isSending) {
    console.log(`⚠️ 正在发送中，跳过: ${kvKey}`);
    return;
  }
  
  cache.isSending = true;
  const messageCount = cache.messages.length;
  console.log(`📦 发送媒体组 (${messageCount}条)`);
  
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
      console.log(`✅ 发送成功 (${mediaGroupInput.length}条)`);
    }
    
    // 并发删除所有原消息
    const deletePromise = (async () => {
      const deleteTasks = cache.messages.map(msg => 
        deleteMessage(token, chatId, msg.messageId)
      );
      await Promise.all(deleteTasks);
      console.log(`🗑️ 并发删除完成 ${messageCount} 条原消息`);
    })();
    
    ctx.waitUntil(deletePromise);
    
  } catch (error) {
    console.error(`发送媒体组失败 (${kvKey}): ${error.message}`);
  } finally {
    // 清除缓存和Promise锁
    mediaGroupCache.delete(kvKey);
    pendingGroupPromises.delete(kvKey);
  }
}

// 全局清理函数（只运行一个实例）
async function globalCleanup(env, chatId, ctx) {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  
  const EXPIRE_TIME = 500; // 500ms 超时（给足够时间收集所有消息）
  
  while (mediaGroupCache.size > 0) {
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const now = Date.now();
    const expiredKeys = [];
    
    for (const [kvKey, cache] of mediaGroupCache.entries()) {
      if (cache && cache.messages.length > 0 && !cache.isSending && 
          (now - cache.createdAt > EXPIRE_TIME)) {
        console.log(`⏰ 强制发送超时缓存 (${cache.messages.length}条)`);
        expiredKeys.push(kvKey);
      }
    }
    
    // 批量处理过期的缓存
    for (const kvKey of expiredKeys) {
      ctx.waitUntil(flushMediaGroup(env.BOT_TOKEN, kvKey, chatId, ctx));
    }
  }
  
  cleanupScheduled = false;
  console.log(`✅ 所有缓存已清理，停止调度`);
}

// 处理媒体组缓存（使用原子锁）
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
  
  // 使用原子操作：检查并创建锁
  while (true) {
    const currentPromise = pendingGroupPromises.get(kvKey);
    
    // 如果没有锁，尝试获取锁
    if (!currentPromise) {
      const newPromise = (async () => {
        let cache = mediaGroupCache.get(kvKey);
        
        if (!cache) {
          cache = {
            messages: [],
            isSending: false,
            createdAt: Date.now()
          };
          mediaGroupCache.set(kvKey, cache);
          console.log(`🆕 创建新缓存: ${kvKey}`);
          
          // 只启动一次全局清理器
          if (!cleanupScheduled) {
            ctx.waitUntil(globalCleanup(env, chatId, ctx));
          }
        }
        
        // 添加消息到缓存
        cache.messages.push({
          ...mediaInfo,
          messageId: messageId,
          timestamp: Date.now()
        });
        
        const currentCount = cache.messages.length;
        console.log(`📥 缓存消息 (${currentCount}/10): ${kvKey}`);
        
        // 如果达到10条，立即发送
        if (currentCount >= 10 && !cache.isSending) {
          console.log(`🎯 达到10条，立即发送: ${kvKey}`);
          await flushMediaGroup(token, kvKey, chatId, ctx);
        }
      })();
      
      // 使用 compare-and-swap 逻辑设置锁
      if (!pendingGroupPromises.has(kvKey)) {
        pendingGroupPromises.set(kvKey, newPromise);
        try {
          await newPromise;
        } finally {
          // 不要立即删除，避免其他等待的请求重新创建
          setTimeout(() => {
            if (pendingGroupPromises.get(kvKey) === newPromise) {
              pendingGroupPromises.delete(kvKey);
            }
          }, 200);
        }
        return true;
      }
      // 如果竞争失败，继续循环
      continue;
    }
    
    // 有锁，等待锁释放后重新尝试
    console.log(`⏳ 等待现有锁释放: ${kvKey}`);
    await currentPromise;
    // 锁释放后，直接添加到已存在的缓存
    const cache = mediaGroupCache.get(kvKey);
    if (cache && !cache.isSending) {
      cache.messages.push({
        ...mediaInfo,
        messageId: messageId,
        timestamp: Date.now()
      });
      const currentCount = cache.messages.length;
      console.log(`📥 添加到现有缓存 (${currentCount}/10): ${kvKey}`);
      
      if (currentCount >= 10 && !cache.isSending) {
        console.log(`🎯 达到10条，立即发送: ${kvKey}`);
        await flushMediaGroup(token, kvKey, chatId, ctx);
      }
      return true;
    }
    
    // 缓存异常，重新尝试获取锁
    console.log(`⚠️ 缓存异常，重试: ${kvKey}`);
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
      // 使用 waitUntil 确保后台任务执行
      ctx.waitUntil(handleUpdate(update, env, ctx));
      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error(`处理错误: ${error.message}`);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};

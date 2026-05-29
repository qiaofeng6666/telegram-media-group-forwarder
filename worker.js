// Cloudflare Worker 代码 - 修复定时器存活问题

// 媒体组缓冲区
const mediaGroupBuffer = new Map();

// Telegram 媒体组最多 10 条消息
const MAX_MEDIA_GROUP_SIZE = 10;

// 动态超时配置
const DYNAMIC_TIMEOUT_CONFIG = {
  1: 2000, 2: 1800, 3: 1500, 4: 1200, 5: 1000,
  6: 800, 7: 700, 8: 600, 9: 550, 10: 500
};

async function sendTelegram(botToken, method, body) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  console.log(`📤 [${method}] 请求:`, JSON.stringify(body));
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    console.log(`📥 [${method}] 响应状态: ${response.status}`);
    const result = await response.json();
    console.log(`📥 [${method}] 响应:`, JSON.stringify(result));
    
    if (!result.ok) {
      console.error(`❌ ${method} 失败:`, result.description);
    }
    return result;
  } catch (error) {
    console.error(`❌ Telegram API 错误 (${method}):`, error.message);
    throw error;
  }
}

async function deleteMessage(botToken, chatId, messageId) {
  try {
    return await sendTelegram(botToken, 'deleteMessage', {
      chat_id: Number(chatId),
      message_id: messageId
    });
  } catch (error) {
    console.error('删除消息失败:', error.message);
    return { ok: false };
  }
}

async function copyMultipleMessages(botToken, fromChatId, toChatId, messageIds) {
  const sortedIds = [...messageIds].sort((a, b) => a - b);
  console.log(`📦 批量复制 ${sortedIds.length} 条消息: ${sortedIds.join(', ')}`);
  
  const result = await sendTelegram(botToken, 'copyMessages', {
    chat_id: Number(toChatId),
    from_chat_id: Number(fromChatId),
    message_ids: sortedIds
  });
  
  return result;
}

async function finalizeMediaGroup(env, chatId, mediaGroupId) {
  console.log(`🎯 [finalizeMediaGroup] 开始: ${mediaGroupId}`);
  
  const group = mediaGroupBuffer.get(mediaGroupId);
  if (!group || group.messages.length === 0) {
    console.log(`⚠️ 媒体组不存在或为空`);
    return false;
  }
  
  if (group.isProcessing) {
    console.log(`⚠️ 媒体组正在处理中，跳过`);
    return false;
  }
  
  group.isProcessing = true;
  
  const messageIds = group.messages.map(m => m.message_id);
  console.log(`🎯 媒体组 ${mediaGroupId} 共 ${messageIds.length} 条消息`);
  console.log(`   消息ID列表: ${messageIds.join(', ')}`);
  
  const result = await copyMultipleMessages(
    env.BOT_TOKEN, chatId, env.ADMIN_USER_ID, messageIds
  );
  
  if (result && result.ok) {
    console.log(`✅ 媒体组转发成功`);
    for (const msgId of messageIds) {
      await deleteMessage(env.BOT_TOKEN, chatId, msgId);
    }
    console.log(`   已删除 ${messageIds.length} 条原始消息`);
  } else {
    const errorMsg = result?.description || 'Unknown error';
    console.error(`❌ 媒体组转发失败: ${errorMsg}`);
  }
  
  // 清除定时器引用
  if (group.timerId) {
    clearTimeout(group.timerId);
  }
  mediaGroupBuffer.delete(mediaGroupId);
  
  console.log(`🎯 [finalizeMediaGroup] 完成: ${mediaGroupId}`);
  return result?.ok || false;
}

function getDynamicTimeout(messageCount) {
  if (messageCount >= MAX_MEDIA_GROUP_SIZE) return 0;
  return DYNAMIC_TIMEOUT_CONFIG[messageCount] || 1500;
}

// 核心：使用 ctx.waitUntil 确保定时器在响应后继续执行
function scheduleTimeout(env, ctx, mediaGroupId, messageCount, chatId) {
  const timeout = getDynamicTimeout(messageCount);
  
  if (timeout === 0) return null;
  
  const group = mediaGroupBuffer.get(mediaGroupId);
  if (!group) return null;
  
  // 清除旧的定时器
  if (group.timerId) {
    clearTimeout(group.timerId);
    console.log(`   🔄 刷新定时器: ${mediaGroupId} (${timeout}ms, 当前${messageCount}条)`);
  } else {
    console.log(`   ⏲️ 设置定时器: ${mediaGroupId} (${timeout}ms, 当前${messageCount}条)`);
  }
  
  // 关键修复：使用 Promise + ctx.waitUntil 保持定时器存活
  const timerPromise = new Promise((resolve) => {
    const timerId = setTimeout(() => {
      console.log(`⏰ 定时器触发: ${mediaGroupId} (等待${timeout}ms未收到新消息)`);
      finalizeMediaGroup(env, chatId, mediaGroupId)
        .then(() => resolve())
        .catch(err => {
          console.error(`定时器执行错误:`, err);
          resolve();
        });
    }, timeout);
    
    // 存储 timerId 以便后续可以取消
    group.timerId = timerId;
  });
  
  // 使用 waitUntil 保持定时器运行
  ctx.waitUntil(timerPromise);
  
  return timerPromise;
}

async function handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx) {
  console.log(`\n📸 媒体组消息: ID=${messageId}, 组ID=${mediaGroupId}`);
  
  let currentCount = 0;
  
  if (mediaGroupBuffer.has(mediaGroupId)) {
    const group = mediaGroupBuffer.get(mediaGroupId);
    const exists = group.messages.some(m => m.message_id === messageId);
    if (!exists) {
      group.messages.push({ message_id: messageId, timestamp: Date.now() });
      group.lastUpdate = Date.now();
      currentCount = group.messages.length;
      console.log(`   ➕ 添加消息，现有 ${currentCount} 条`);
    } else {
      currentCount = group.messages.length;
      console.log(`   ⚠️ 消息已存在，现有 ${currentCount} 条`);
    }
    // 刷新定时器（会先清除旧的，再设置新的）
    scheduleTimeout(env, ctx, mediaGroupId, currentCount, chatId);
  } else {
    console.log(`   🆕 创建新媒体组，第一条消息 ${messageId}`);
    const newGroup = {
      messages: [{ message_id: messageId, timestamp: Date.now() }],
      lastUpdate: Date.now(),
      chatId: chatId,
      isProcessing: false,
      timerId: null
    };
    mediaGroupBuffer.set(mediaGroupId, newGroup);
    currentCount = 1;
    // 设置定时器
    scheduleTimeout(env, ctx, mediaGroupId, currentCount, chatId);
  }
  
  // 达到最大数量，立即发送并清除定时器
  if (currentCount === MAX_MEDIA_GROUP_SIZE) {
    console.log(`   🚀 达到10条，立即发送！`);
    const group = mediaGroupBuffer.get(mediaGroupId);
    if (group) {
      if (group.timerId) {
        clearTimeout(group.timerId);
        group.timerId = null;
      }
      if (!group.isProcessing) {
        await finalizeMediaGroup(env, chatId, mediaGroupId);
      }
    }
  }
  
  return { status: 'buffered', count: currentCount };
}

async function handleNormalMessage(env, chatId, messageId, ctx) {
  console.log(`📄 普通消息: ID=${messageId}`);
  
  // 如果有缓冲的媒体组，先发送它们
  if (mediaGroupBuffer.size > 0) {
    const groupIds = Array.from(mediaGroupBuffer.keys());
    console.log(`   📤 普通消息触发，发送 ${groupIds.length} 个媒体组...`);
    for (const groupId of groupIds) {
      const group = mediaGroupBuffer.get(groupId);
      if (group && !group.isProcessing) {
        if (group.timerId) {
          clearTimeout(group.timerId);
          group.timerId = null;
        }
        await finalizeMediaGroup(env, chatId, groupId);
      }
    }
  }
  
  try {
    const result = await sendTelegram(env.BOT_TOKEN, 'copyMessage', {
      chat_id: Number(env.ADMIN_USER_ID),
      from_chat_id: Number(chatId),
      message_id: messageId
    });
    
    if (result && result.ok) {
      await deleteMessage(env.BOT_TOKEN, chatId, messageId);
      console.log(`   ✅ 转发成功`);
    } else {
      console.error(`   ❌ 转发失败: ${result?.description || 'Unknown error'}`);
    }
    return { success: result?.ok || false };
  } catch (error) {
    console.error(`   ❌ 转发失败: ${error.message}`);
    return { success: false };
  }
}

async function handleUpdate(env, update, ctx) {
  if (!update.message) return { status: 'no_message' };
  
  const message = update.message;
  const user = message.from;
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const mediaGroupId = message.media_group_id;
  
  const adminUserId = parseInt(env.ADMIN_USER_ID);
  if (Number(user.id) !== adminUserId) {
    console.log(`忽略非授权用户: ${user.id}`);
    return { status: 'ignored' };
  }
  
  console.log(`收到消息: ID=${messageId}, 类型=${message.photo ? 'photo' : message.video ? 'video' : 'text'}, media_group_id=${mediaGroupId || '无'}`);
  
  if (mediaGroupId) {
    return await handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx);
  } else {
    return await handleNormalMessage(env, chatId, messageId, ctx);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (!env.BOT_TOKEN || !env.ADMIN_USER_ID) {
      return new Response(JSON.stringify({ error: 'Missing env vars' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const url = new URL(request.url);
    
    // 健康检查
    if (request.method === 'GET' && url.pathname === '/health') {
      const bufferInfo = {};
      let totalMessages = 0;
      const now = Date.now();
      
      for (const [groupId, group] of mediaGroupBuffer.entries()) {
        const age = now - group.lastUpdate;
        bufferInfo[groupId] = {
          count: group.messages.length,
          ids: group.messages.map(m => m.message_id),
          age_ms: age,
          has_timer: !!group.timerId,
          isProcessing: group.isProcessing
        };
        totalMessages += group.messages.length;
      }
      
      return new Response(JSON.stringify({
        status: 'ok',
        buffer_size: mediaGroupBuffer.size,
        total_buffered_messages: totalMessages,
        buffer_info: bufferInfo,
        max_media_group_size: MAX_MEDIA_GROUP_SIZE
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 手动发送所有媒体组
    if (request.method === 'POST' && url.pathname === '/flush') {
      const groupIds = Array.from(mediaGroupBuffer.keys());
      console.log(`📤 手动发送 ${groupIds.length} 个媒体组`);
      for (const groupId of groupIds) {
        const group = mediaGroupBuffer.get(groupId);
        if (group && !group.isProcessing) {
          if (group.timerId) {
            clearTimeout(group.timerId);
            group.timerId = null;
          }
          await finalizeMediaGroup(env, group.chatId, groupId);
        }
      }
      return new Response(JSON.stringify({ status: 'flushed' }));
    }
    
    // 清除缓冲区
    if (request.method === 'POST' && url.pathname === '/clearbuffer') {
      for (const group of mediaGroupBuffer.values()) {
        if (group.timerId) {
          clearTimeout(group.timerId);
        }
      }
      mediaGroupBuffer.clear();
      return new Response(JSON.stringify({ status: 'cleared' }));
    }
    
    // 设置Webhook
    if (request.method === 'GET' && url.pathname === '/setwebhook') {
      const webhookUrl = `https://${url.hostname}/webhook`;
      const result = await sendTelegram(env.BOT_TOKEN, 'setWebhook', { url: webhookUrl });
      return new Response(JSON.stringify(result));
    }
    
    // Webhook主端点
    if (request.method === 'POST' && url.pathname === '/webhook') {
      try {
        const update = await request.json();
        const result = await handleUpdate(env, update, ctx);
        return new Response(JSON.stringify(result), { status: 200 });
      } catch (error) {
        console.error('Webhook处理错误:', error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

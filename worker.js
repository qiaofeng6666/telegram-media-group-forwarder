// Cloudflare Worker 代码 - Telegram 媒体组转发机器人
// 更多信息: https://github.com/你的用户名/telegram-media-group-forwarder

// 媒体组缓冲区
const mediaGroupBuffer = new Map();

// Telegram 媒体组最多 10 条消息
const MAX_MEDIA_GROUP_SIZE = 10;

async function sendTelegram(botToken, method, body) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!result.ok) {
      console.error(`${method} 失败:`, result.description);
    }
    return result;
  } catch (error) {
    console.error(`Telegram API 错误 (${method}):`, error.message);
    throw error;
  }
}

async function deleteMessage(botToken, chatId, messageId) {
  try {
    return await sendTelegram(botToken, 'deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.error('删除消息失败:', error.message);
  }
}

async function copyMultipleMessages(botToken, fromChatId, toChatId, messageIds) {
  const sortedIds = [...messageIds].sort((a, b) => a - b);
  console.log(`📦 批量复制 ${sortedIds.length} 条消息，IDs: ${sortedIds.join(', ')}`);
  
  const result = await sendTelegram(botToken, 'copyMessages', {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_ids: sortedIds
  });
  
  return result;
}

async function finalizeMediaGroup(env, chatId, mediaGroupId) {
  const group = mediaGroupBuffer.get(mediaGroupId);
  if (!group || group.messages.length === 0) {
    return false;
  }
  
  const messageIds = group.messages.map(m => m.message_id);
  const messageCount = messageIds.length;
  
  console.log(`🎯 媒体组 ${mediaGroupId} 收集完成，共 ${messageCount} 条消息`);
  
  const result = await copyMultipleMessages(
    env.BOT_TOKEN,
    chatId,
    env.ADMIN_USER_ID,
    messageIds
  );
  
  if (result.ok) {
    console.log(`✅ 媒体组转发成功`);
    for (const msgId of messageIds) {
      await deleteMessage(env.BOT_TOKEN, chatId, msgId);
    }
  } else {
    console.error(`❌ 媒体组转发失败: ${result.description}`);
  }
  
  mediaGroupBuffer.delete(mediaGroupId);
  return result.ok;
}

async function handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx) {
  console.log(`📸 媒体组消息: ID=${messageId}, 组ID=${mediaGroupId}`);
  
  // 检查是否有其他正在等待的媒体组
  if (mediaGroupBuffer.size > 0) {
    const existingGroupId = mediaGroupBuffer.keys().next().value;
    
    if (existingGroupId !== mediaGroupId) {
      console.log(`   🔄 检测到不同媒体组，先发送缓冲区中的...`);
      await finalizeMediaGroup(env, chatId, existingGroupId);
    }
  }
  
  let currentCount = 0;
  
  if (mediaGroupBuffer.has(mediaGroupId)) {
    const group = mediaGroupBuffer.get(mediaGroupId);
    group.messages.push({ message_id: messageId, timestamp: Date.now() });
    group.lastUpdate = Date.now();
    currentCount = group.messages.length;
    console.log(`   ➕ 媒体组 ${mediaGroupId} 现有 ${currentCount} 条消息`);
  } else {
    console.log(`   🆕 创建新媒体组 ${mediaGroupId}`);
    mediaGroupBuffer.set(mediaGroupId, {
      messages: [{ message_id: messageId, timestamp: Date.now() }],
      lastUpdate: Date.now(),
      chatId: chatId
    });
    currentCount = 1;
  }
  
  if (currentCount === MAX_MEDIA_GROUP_SIZE) {
    console.log(`   🚀 达到 ${MAX_MEDIA_GROUP_SIZE} 条，立即发送！`);
    await finalizeMediaGroup(env, chatId, mediaGroupId);
  }
  
  return { status: 'buffered', media_group_id: mediaGroupId, count: currentCount };
}

async function handleNormalMessage(env, chatId, messageId) {
  console.log(`📄 普通消息: ID=${messageId}，直接复制`);
  
  if (mediaGroupBuffer.size > 0) {
    const existingGroupId = mediaGroupBuffer.keys().next().value;
    console.log(`   📤 收到普通消息，先发送缓冲区中的媒体组...`);
    await finalizeMediaGroup(env, chatId, existingGroupId);
  }
  
  try {
    await sendTelegram(env.BOT_TOKEN, 'copyMessage', {
      chat_id: env.ADMIN_USER_ID,
      from_chat_id: chatId,
      message_id: messageId
    });
    await deleteMessage(env.BOT_TOKEN, chatId, messageId);
    return { success: true };
  } catch (error) {
    console.error(`转发失败: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function handleUpdate(env, update, ctx) {
  if (!update.message) {
    return { status: 'no_message' };
  }
  
  const message = update.message;
  const user = message.from;
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const mediaGroupId = message.media_group_id;
  
  const adminUserId = parseInt(env.ADMIN_USER_ID);
  if (user.id !== adminUserId) {
    console.log(`忽略非授权用户: ${user.id}`);
    return { status: 'ignored' };
  }
  
  if (mediaGroupId) {
    return await handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx);
  } else {
    return await handleNormalMessage(env, chatId, messageId);
  }
}

function cleanupExpiredBuffers(env) {
  const now = Date.now();
  for (const [groupId, group] of mediaGroupBuffer.entries()) {
    if (now - group.lastUpdate > 60000) {
      console.log(`强制清理过期媒体组: ${groupId}`);
      mediaGroupBuffer.delete(groupId);
    }
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
    
    cleanupExpiredBuffers(env);
    
    const url = new URL(request.url);
    
    if (request.method === 'GET' && url.pathname === '/health') {
      const bufferInfo = {};
      for (const [groupId, group] of mediaGroupBuffer.entries()) {
        bufferInfo[groupId] = {
          count: group.messages.length,
          ids: group.messages.map(m => m.message_id)
        };
      }
      return new Response(JSON.stringify({
        status: 'ok',
        buffer_size: mediaGroupBuffer.size,
        buffer_info: bufferInfo
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (request.method === 'POST' && url.pathname === '/flush') {
      for (const [groupId, group] of mediaGroupBuffer.entries()) {
        await finalizeMediaGroup(env, group.chatId, groupId);
      }
      return new Response(JSON.stringify({ status: 'flushed' }));
    }
    
    if (request.method === 'GET' && url.pathname === '/setwebhook') {
      const webhookUrl = `https://${url.hostname}/webhook`;
      const result = await sendTelegram(env.BOT_TOKEN, 'setWebhook', { url: webhookUrl });
      return new Response(JSON.stringify(result));
    }
    
    if (request.method === 'POST' && url.pathname === '/clearbuffer') {
      mediaGroupBuffer.clear();
      return new Response(JSON.stringify({ status: 'buffer_cleared' }));
    }
    
    if (request.method === 'POST' && url.pathname === '/webhook') {
      try {
        const update = await request.json();
        const result = await handleUpdate(env, update, ctx);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      } catch (error) {
        console.error('Webhook处理错误:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

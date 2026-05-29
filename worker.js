// Cloudflare Worker 代码 - 快速轮询版（2秒超时）

const mediaGroupBuffer = new Map();
const MAX_MEDIA_GROUP_SIZE = 10;

const DYNAMIC_TIMEOUT_CONFIG = {
  1: 2000, 2: 1800, 3: 1500, 4: 1200, 5: 1000,
  6: 800, 7: 700, 8: 600, 9: 550, 10: 500
};

async function sendTelegram(botToken, method, body) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!result.ok) console.error(`${method} 失败:`, result.description);
  return result;
}

async function deleteMessage(botToken, chatId, messageId) {
  return await sendTelegram(botToken, 'deleteMessage', {
    chat_id: Number(chatId),
    message_id: messageId
  });
}

async function copyMultipleMessages(botToken, fromChatId, toChatId, messageIds) {
  const sortedIds = [...messageIds].sort((a, b) => a - b);
  console.log(`📦 复制 ${sortedIds.length} 条`);
  return await sendTelegram(botToken, 'copyMessages', {
    chat_id: Number(toChatId),
    from_chat_id: Number(fromChatId),
    message_ids: sortedIds
  });
}

async function finalizeMediaGroup(env, chatId, mediaGroupId) {
  const group = mediaGroupBuffer.get(mediaGroupId);
  if (!group || group.messages.length === 0 || group.isProcessing) return false;
  
  group.isProcessing = true;
  const messageIds = group.messages.map(m => m.message_id);
  console.log(`🎯 发送媒体组: ${messageIds.length}条`);
  
  const result = await copyMultipleMessages(env.BOT_TOKEN, chatId, env.ADMIN_USER_ID, messageIds);
  
  if (result.ok) {
    for (const msgId of messageIds) {
      await deleteMessage(env.BOT_TOKEN, chatId, msgId);
    }
    console.log(`🗑️ 已删除 ${messageIds.length} 条原始消息`);
  } else {
    console.error(`❌ 转发失败: ${result.description}`);
  }
  
  mediaGroupBuffer.delete(mediaGroupId);
  return result.ok;
}

function getTimeout(count) {
  if (count >= MAX_MEDIA_GROUP_SIZE) return 0;
  return DYNAMIC_TIMEOUT_CONFIG[count] || 1500;
}

// 快速轮询：最多20次 × 100ms = 2秒
async function startPolling(env, ctx, mediaGroupId) {
  const maxAttempts = 20;  // 20次
  const interval = 100;    // 100ms
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, interval));
    
    const group = mediaGroupBuffer.get(mediaGroupId);
    if (!group) {
      // 已被处理，停止轮询
      return;
    }
    
    if (group.isProcessing) {
      // 正在处理中，等待
      continue;
    }
    
    const timeSinceLastUpdate = Date.now() - group.lastUpdate;
    const timeout = getTimeout(group.messages.length);
    
    // 检查是否超时
    if (timeSinceLastUpdate >= timeout) {
      console.log(`⏰ 轮询超时: ${mediaGroupId} (${group.messages.length}条, 等待${timeSinceLastUpdate}ms)`);
      await finalizeMediaGroup(env, group.chatId, mediaGroupId);
      return;
    }
    
    // 如果已达到10条，立即发送
    if (group.messages.length === MAX_MEDIA_GROUP_SIZE) {
      console.log(`🚀 轮询检测到10条: ${mediaGroupId}`);
      await finalizeMediaGroup(env, group.chatId, mediaGroupId);
      return;
    }
  }
  
  // 2秒后还没收到新消息，强制发送
  const group = mediaGroupBuffer.get(mediaGroupId);
  if (group && !group.isProcessing) {
    console.log(`⏰ 轮询结束，强制发送: ${mediaGroupId} (${group.messages.length}条)`);
    await finalizeMediaGroup(env, group.chatId, mediaGroupId);
  }
}

async function handleMediaGroupMessage(env, ctx, chatId, messageId, mediaGroupId) {
  let group = mediaGroupBuffer.get(mediaGroupId);
  
  if (group) {
    if (!group.messages.some(m => m.message_id === messageId)) {
      group.messages.push({ message_id: messageId, timestamp: Date.now() });
      group.lastUpdate = Date.now();
      const count = group.messages.length;
      console.log(`📸 ${mediaGroupId}: ${count}条`);
      
      if (count === MAX_MEDIA_GROUP_SIZE) {
        console.log(`🚀 达到10条，立即发送`);
        await finalizeMediaGroup(env, chatId, mediaGroupId);
      }
    }
  } else {
    console.log(`📸 ${mediaGroupId}: 创建 (1条)`);
    mediaGroupBuffer.set(mediaGroupId, {
      messages: [{ message_id: messageId, timestamp: Date.now() }],
      lastUpdate: Date.now(),
      chatId: chatId,
      isProcessing: false
    });
    
    // 启动轮询
    ctx.waitUntil(startPolling(env, ctx, mediaGroupId));
  }
}

async function handleNormalMessage(env, ctx, chatId, messageId) {
  // 发送所有缓冲的媒体组
  for (const [groupId, group] of mediaGroupBuffer.entries()) {
    if (group && !group.isProcessing) {
      await finalizeMediaGroup(env, chatId, groupId);
    }
  }
  
  const result = await sendTelegram(env.BOT_TOKEN, 'copyMessage', {
    chat_id: Number(env.ADMIN_USER_ID),
    from_chat_id: Number(chatId),
    message_id: messageId
  });
  
  if (result.ok) {
    await deleteMessage(env.BOT_TOKEN, chatId, messageId);
    console.log(`🗑️ 已删除 1 条消息`);
  }
}

async function handleUpdate(env, ctx, update) {
  if (!update.message) return;
  
  const msg = update.message;
  const userId = msg.from.id;
  const adminId = parseInt(env.ADMIN_USER_ID);
  if (Number(userId) !== adminId) return;
  
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const mediaGroupId = msg.media_group_id;
  
  if (mediaGroupId) {
    await handleMediaGroupMessage(env, ctx, chatId, messageId, mediaGroupId);
  } else {
    await handleNormalMessage(env, ctx, chatId, messageId);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (!env.BOT_TOKEN || !env.ADMIN_USER_ID) {
      return new Response('Missing env vars', { status: 500 });
    }
    
    const url = new URL(request.url);
    
    if (request.method === 'GET' && url.pathname === '/health') {
      const info = {};
      for (const [id, g] of mediaGroupBuffer.entries()) {
        info[id] = { count: g.messages.length };
      }
      return new Response(JSON.stringify({ buffer: info }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (request.method === 'POST' && url.pathname === '/flush') {
      for (const [id, g] of mediaGroupBuffer.entries()) {
        await finalizeMediaGroup(env, g.chatId, id);
      }
      return new Response('Flushed');
    }
    
    if (request.method === 'POST' && url.pathname === '/webhook') {
      try {
        const update = await request.json();
        ctx.waitUntil(handleUpdate(env, ctx, update));
        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error(error);
        return new Response('Error', { status: 500 });
      }
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

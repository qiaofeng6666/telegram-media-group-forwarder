// Cloudflare Worker 代码 - 队列处理媒体组版（最终优化版）

const mediaGroupBuffer = new Map();
const MAX_MEDIA_GROUP_SIZE = 10;
const WAIT_TIMEOUT = 200;

// 存储每个媒体组的延迟任务Promise
const pendingTimeouts = new Map();

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
  if (!group || group.messages.length === 0 || group.isProcessing) {
    return false;
  }
  
  group.isProcessing = true;
  const messageIds = group.messages.map(m => m.message_id);
  console.log(`🎯 发送媒体组: ${messageIds.length}条 (${mediaGroupId})`);
  
  const result = await copyMultipleMessages(env.BOT_TOKEN, chatId, env.ADMIN_USER_ID, messageIds);
  
  if (result.ok) {
    // 批量删除，但控制并发数
    for (const msgId of messageIds) {
      await deleteMessage(env.BOT_TOKEN, chatId, msgId);
      // 添加小延迟避免请求过快
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    console.log(`🗑️ 已删除 ${messageIds.length} 条原始消息`);
  } else {
    console.error(`❌ 转发失败: ${result.description}`);
  }
  
  mediaGroupBuffer.delete(mediaGroupId);
  pendingTimeouts.delete(mediaGroupId);
  return result.ok;
}

async function forwardNormalMessage(env, chatId, messageId) {
  const result = await sendTelegram(env.BOT_TOKEN, 'copyMessage', {
    chat_id: Number(env.ADMIN_USER_ID),
    from_chat_id: Number(chatId),
    message_id: messageId
  });
  
  if (result.ok) {
    await deleteMessage(env.BOT_TOKEN, chatId, messageId);
    console.log(`🗑️ 已删除 1 条消息`);
    return true;
  }
  return false;
}

// 为媒体组创建延迟发送任务
function scheduleMediaGroup(env, ctx, chatId, mediaGroupId) {
  // 如果已经有延迟任务，先取消旧的
  if (pendingTimeouts.has(mediaGroupId)) {
    // 注意：无法真正取消已开始的异步任务，但可以标记
    console.log(`⏰ ${mediaGroupId}: 已有延迟任务，重置定时器`);
  }
  
  // 创建新的延迟任务
  const delayPromise = (async () => {
    await new Promise(resolve => setTimeout(resolve, WAIT_TIMEOUT));
    console.log(`⏰ 延迟${WAIT_TIMEOUT}ms后检查: ${mediaGroupId}`);
    const group = mediaGroupBuffer.get(mediaGroupId);
    if (group && group.messages.length > 0 && group.messages.length < MAX_MEDIA_GROUP_SIZE && !group.isProcessing) {
      await finalizeMediaGroup(env, chatId, mediaGroupId);
    }
  })();
  
  pendingTimeouts.set(mediaGroupId, delayPromise);
  ctx.waitUntil(delayPromise);
}

async function handleMediaGroupMessage(env, ctx, chatId, messageId, mediaGroupId) {
  let group = mediaGroupBuffer.get(mediaGroupId);
  
  if (group) {
    // 组已存在，添加消息
    if (!group.messages.some(m => m.message_id === messageId)) {
      group.messages.push({ message_id: messageId, timestamp: Date.now() });
      group.lastUpdate = Date.now();
      const count = group.messages.length;
      console.log(`📸 ${mediaGroupId}: ${count}条`);
      
      // 达到10条，立即发送
      if (count === MAX_MEDIA_GROUP_SIZE) {
        console.log(`🚀 达到10条，立即发送`);
        // 取消延迟任务（通过标记避免重复发送）
        if (pendingTimeouts.has(mediaGroupId)) {
          pendingTimeouts.delete(mediaGroupId);
        }
        await finalizeMediaGroup(env, chatId, mediaGroupId);
      } else {
        // 未满10条，重置延迟任务（新的消息来了，重新计时）
        scheduleMediaGroup(env, ctx, chatId, mediaGroupId);
      }
    }
  } else {
    // 创建新媒体组
    console.log(`📸 ${mediaGroupId}: 创建 (1条)`);
    
    mediaGroupBuffer.set(mediaGroupId, {
      messages: [{ message_id: messageId, timestamp: Date.now() }],
      lastUpdate: Date.now(),
      chatId: chatId,
      isProcessing: false
    });
    
    // 启动延迟任务
    scheduleMediaGroup(env, ctx, chatId, mediaGroupId);
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
  
  if (!mediaGroupId) {
    // 普通消息：直接转发
    console.log(`📄 普通消息: ${messageId}，直接转发`);
    await forwardNormalMessage(env, chatId, messageId);
  } else {
    // 媒体组消息
    await handleMediaGroupMessage(env, ctx, chatId, messageId, mediaGroupId);
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
        info[id] = { count: g.messages.length, lastUpdate: g.lastUpdate };
      }
      return new Response(JSON.stringify({ 
        buffer: info, 
        pendingTimeouts: pendingTimeouts.size 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (request.method === 'POST' && url.pathname === '/flush') {
      for (const [id, g] of mediaGroupBuffer.entries()) {
        if (!g.isProcessing) {
          await finalizeMediaGroup(env, g.chatId, id);
        }
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

// Cloudflare Worker 代码 - 队列控制版（极简日志）

const mediaGroupBuffer = new Map();
const MAX_MEDIA_GROUP_SIZE = 10;
const WAIT_TIMEOUT = 200;
const REQUEST_DELAY = 100;

const pendingTimeouts = new Map();

// 请求队列（每个请求独立）
let requestQueue = [];
let isProcessingQueue = false;
const MAX_CONCURRENT = 3;

async function sendTelegram(botToken, method, body) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  
  return new Promise((resolve, reject) => {
    requestQueue.push({
      execute: async () => {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const result = await response.json();
          if (!result.ok) {
            if (result.description && result.description.includes('message not found')) {
              resolve({ ok: true });
            } else {
              console.error(`${method}失败:`, result.description);
              resolve(result);
            }
          } else {
            resolve(result);
          }
        } catch (error) {
          console.error(`${method}错误:`, error);
          reject(error);
        }
      }
    });
    
    processRequestQueue();
  });
}

async function processRequestQueue() {
  if (isProcessingQueue) return;
  if (requestQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (requestQueue.length > 0) {
    const batch = requestQueue.splice(0, MAX_CONCURRENT);
    const promises = batch.map(req => req.execute());
    await Promise.all(promises);
    
    if (requestQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    }
  }
  
  isProcessingQueue = false;
}

function resetQueue() {
  requestQueue = [];
  isProcessingQueue = false;
}

async function deleteMessage(botToken, chatId, messageId) {
  return await sendTelegram(botToken, 'deleteMessage', {
    chat_id: Number(chatId),
    message_id: messageId
  });
}

async function copyMultipleMessages(botToken, fromChatId, toChatId, messageIds) {
  const sortedIds = [...messageIds].sort((a, b) => a - b);
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
  const messageIds = [...group.messages.map(m => m.message_id)];
  const count = messageIds.length;
  console.log(`📦 发送媒体组 ${mediaGroupId}: ${count}条`);
  
  const result = await copyMultipleMessages(env.BOT_TOKEN, chatId, env.ADMIN_USER_ID, messageIds);
  
  if (result.ok) {
    // 并发删除所有消息
    const deletePromises = messageIds.map(msgId => deleteMessage(env.BOT_TOKEN, chatId, msgId));
    await Promise.all(deletePromises);
    console.log(`🗑️ 删除 ${count} 条原消息`);
  } else {
    console.error(`❌ 媒体组 ${mediaGroupId} 转发失败`);
    group.isProcessing = false;
    return false;
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
    console.log(`🗑️ 删除 1 条消息`);
    return true;
  }
  return false;
}

function scheduleMediaGroup(env, ctx, chatId, mediaGroupId) {
  if (pendingTimeouts.has(mediaGroupId)) {
    // 重置定时器
  }
  
  const delayPromise = (async () => {
    await new Promise(resolve => setTimeout(resolve, WAIT_TIMEOUT));
    const group = mediaGroupBuffer.get(mediaGroupId);
    if (group && group.messages.length > 0 && 
        group.messages.length < MAX_MEDIA_GROUP_SIZE && 
        !group.isProcessing) {
      console.log(`⏰ 超时发送 ${mediaGroupId}: ${group.messages.length}条`);
      await finalizeMediaGroup(env, chatId, mediaGroupId);
    }
  })();
  
  pendingTimeouts.set(mediaGroupId, delayPromise);
  ctx.waitUntil(delayPromise);
}

async function handleMediaGroupMessage(env, ctx, chatId, messageId, mediaGroupId) {
  let group = mediaGroupBuffer.get(mediaGroupId);
  
  if (group) {
    if (!group.messages.some(m => m.message_id === messageId)) {
      group.messages.push({ message_id: messageId, timestamp: Date.now() });
      group.lastUpdate = Date.now();
      const count = group.messages.length;
      
      if (count === MAX_MEDIA_GROUP_SIZE) {
        console.log(`🚀 ${mediaGroupId}: 满10条立即发送`);
        if (pendingTimeouts.has(mediaGroupId)) {
          pendingTimeouts.delete(mediaGroupId);
        }
        await finalizeMediaGroup(env, chatId, mediaGroupId);
      } else {
        scheduleMediaGroup(env, ctx, chatId, mediaGroupId);
      }
    }
  } else {
    mediaGroupBuffer.set(mediaGroupId, {
      messages: [{ message_id: messageId, timestamp: Date.now() }],
      lastUpdate: Date.now(),
      chatId: chatId,
      isProcessing: false
    });
    scheduleMediaGroup(env, ctx, chatId, mediaGroupId);
  }
}

async function handleUpdate(env, ctx, update) {
  resetQueue();
  
  if (!update.message) return;
  
  const msg = update.message;
  const userId = msg.from.id;
  const adminId = parseInt(env.ADMIN_USER_ID);
  
  if (Number(userId) !== adminId) return;
  
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const mediaGroupId = msg.media_group_id;
  
  if (!mediaGroupId) {
    await forwardNormalMessage(env, chatId, messageId);
  } else {
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
        info[id] = { count: g.messages.length };
      }
      return new Response(JSON.stringify({ 
        buffer: info, 
        pending: pendingTimeouts.size 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (request.method === 'POST' && url.pathname === '/flush') {
      const groups = Array.from(mediaGroupBuffer.entries());
      for (const [id, g] of groups) {
        if (!g.isProcessing) {
          await finalizeMediaGroup(env, g.chatId, id);
        }
      }
      return new Response(`Flushed ${groups.length} groups`);
    }
    
    if (request.method === 'POST' && url.pathname === '/webhook') {
      try {
        const update = await request.json();
        ctx.waitUntil(handleUpdate(env, ctx, update));
        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error('Webhook错误:', error);
        return new Response('Error', { status: 500 });
      }
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

// Cloudflare Worker 代码 - 队列 + Promise 等待版

const mediaGroupBuffer = new Map();
const messageQueue = [];
let isProcessing = false;
const pendingTimers = new Map(); // 记录等待中的定时器 Promise
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
  if (pendingTimers.has(mediaGroupId)) {
    clearTimeout(pendingTimers.get(mediaGroupId).timerId);
    pendingTimers.delete(mediaGroupId);
  }
  return result.ok;
}

function getTimeout(count) {
  if (count >= MAX_MEDIA_GROUP_SIZE) return 0;
  return DYNAMIC_TIMEOUT_CONFIG[count] || 1500;
}

// 设置定时器并返回 Promise
function scheduleTimer(env, ctx, chatId, mediaGroupId, count) {
  const timeout = getTimeout(count);
  if (timeout === 0) return null;
  
  // 清除旧定时器
  if (pendingTimers.has(mediaGroupId)) {
    clearTimeout(pendingTimers.get(mediaGroupId).timerId);
    pendingTimers.delete(mediaGroupId);
  }
  
  console.log(`⏲️ 设置定时器: ${timeout}ms (${count}条) - ${mediaGroupId}`);
  
  // 创建新的定时器 Promise
  let timerId;
  const timerPromise = new Promise((resolve) => {
    timerId = setTimeout(async () => {
      console.log(`⏰ 定时器触发: ${mediaGroupId} (${count}条)`);
      pendingTimers.delete(mediaGroupId);
      await finalizeMediaGroup(env, chatId, mediaGroupId);
      resolve();
    }, timeout);
  });
  
  pendingTimers.set(mediaGroupId, { timerId, promise: timerPromise });
  return timerPromise;
}

// 单线程处理队列
async function processQueue(env, ctx) {
  if (isProcessing) return;
  isProcessing = true;
  
  const timerPromises = [];
  
  try {
    while (messageQueue.length > 0) {
      const { chatId, messageId, mediaGroupId } = messageQueue.shift();
      
      let group = mediaGroupBuffer.get(mediaGroupId);
      
      if (group) {
        if (!group.messages.some(m => m.message_id === messageId)) {
          group.messages.push({ message_id: messageId, timestamp: Date.now() });
          group.lastUpdate = Date.now();
          const count = group.messages.length;
          console.log(`📸 ${mediaGroupId}: ${count}条`);
          
          if (count === MAX_MEDIA_GROUP_SIZE) {
            console.log(`🚀 达到10条，立即发送`);
            // 清除定时器
            if (pendingTimers.has(mediaGroupId)) {
              clearTimeout(pendingTimers.get(mediaGroupId).timerId);
              pendingTimers.delete(mediaGroupId);
            }
            await finalizeMediaGroup(env, chatId, mediaGroupId);
          } else {
            // 刷新定时器
            const timerPromise = scheduleTimer(env, ctx, chatId, mediaGroupId, count);
            if (timerPromise) timerPromises.push(timerPromise);
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
        const timerPromise = scheduleTimer(env, ctx, chatId, mediaGroupId, 1);
        if (timerPromise) timerPromises.push(timerPromise);
      }
    }
  } finally {
    isProcessing = false;
  }
  
  // 关键：等待所有定时器完成，保持 Worker 活跃
  if (timerPromises.length > 0) {
    console.log(`⏳ 等待 ${timerPromises.length} 个定时器完成...`);
    await Promise.all(timerPromises);
  }
}

async function handleNormalMessage(env, chatId, messageId) {
  // 先发送所有缓冲的媒体组
  for (const [groupId, group] of mediaGroupBuffer.entries()) {
    if (group && !group.isProcessing) {
      if (pendingTimers.has(groupId)) {
        clearTimeout(pendingTimers.get(groupId).timerId);
        pendingTimers.delete(groupId);
      }
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
    messageQueue.push({ chatId, messageId, mediaGroupId });
    await processQueue(env, ctx);
  } else {
    await handleNormalMessage(env, chatId, messageId);
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
        queue: messageQueue.length,
        timers: pendingTimers.size 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (request.method === 'POST' && url.pathname === '/flush') {
      for (const [id, g] of mediaGroupBuffer.entries()) {
        if (pendingTimers.has(id)) {
          clearTimeout(pendingTimers.get(id).timerId);
          pendingTimers.delete(id);
        }
        await finalizeMediaGroup(env, g.chatId, id);
      }
      return new Response('Flushed');
    }
    
    if (request.method === 'POST' && url.pathname === '/webhook') {
      try {
        const update = await request.json();
        // 使用 waitUntil 确保整个处理过程（包括定时器）完成
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

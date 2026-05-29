// Cloudflare Worker 代码 - 最终稳定版

const mediaGroupBuffer = new Map();
const creatingGroups = new Set();
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
  console.log(`📦 复制 ${sortedIds.length} 条: ${sortedIds.join(',')}`);
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
  console.log(`🎯 发送媒体组 ${mediaGroupId}: ${messageIds.length}条`);
  
  const result = await copyMultipleMessages(env.BOT_TOKEN, chatId, env.ADMIN_USER_ID, messageIds);
  
  if (result.ok) {
    for (const msgId of messageIds) {
      await deleteMessage(env.BOT_TOKEN, chatId, msgId);
    }
  }
  
  if (group.timerId) clearTimeout(group.timerId);
  mediaGroupBuffer.delete(mediaGroupId);
  return result.ok;
}

function getTimeout(count) {
  return count >= MAX_MEDIA_GROUP_SIZE ? 0 : (DYNAMIC_TIMEOUT_CONFIG[count] || 1500);
}

function scheduleTimeout(env, ctx, groupId, count, chatId) {
  const timeout = getTimeout(count);
  if (timeout === 0) return;
  
  const group = mediaGroupBuffer.get(groupId);
  if (!group) return;
  
  if (group.timerId) clearTimeout(group.timerId);
  
  const timerPromise = new Promise((resolve) => {
    group.timerId = setTimeout(() => {
      console.log(`⏰ 超时: ${groupId} (${count}条)`);
      finalizeMediaGroup(env, chatId, groupId).then(resolve);
    }, timeout);
  });
  ctx.waitUntil(timerPromise);
}

async function handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx) {
  // 等待正在创建的组
  while (creatingGroups.has(mediaGroupId)) {
    await new Promise(r => setTimeout(r, 10));
  }
  
  let group = mediaGroupBuffer.get(mediaGroupId);
  
  if (group) {
    if (!group.messages.some(m => m.message_id === messageId)) {
      group.messages.push({ message_id: messageId, timestamp: Date.now() });
      group.lastUpdate = Date.now();
      console.log(`📸 ${mediaGroupId}: +1 (${group.messages.length}条)`);
      scheduleTimeout(env, ctx, mediaGroupId, group.messages.length, chatId);
    }
  } else {
    creatingGroups.add(mediaGroupId);
    try {
      mediaGroupBuffer.set(mediaGroupId, {
        messages: [{ message_id: messageId, timestamp: Date.now() }],
        lastUpdate: Date.now(),
        chatId: chatId,
        isProcessing: false,
        timerId: null
      });
      console.log(`📸 ${mediaGroupId}: 创建 (1条)`);
      scheduleTimeout(env, ctx, mediaGroupId, 1, chatId);
    } finally {
      creatingGroups.delete(mediaGroupId);
    }
    group = mediaGroupBuffer.get(mediaGroupId);
  }
  
  if (group && group.messages.length === MAX_MEDIA_GROUP_SIZE) {
    if (group.timerId) clearTimeout(group.timerId);
    await finalizeMediaGroup(env, chatId, mediaGroupId);
  }
}

async function handleNormalMessage(env, chatId, messageId, ctx) {
  // 先发送所有缓冲的媒体组
  for (const [groupId, group] of mediaGroupBuffer.entries()) {
    if (group && !group.isProcessing) {
      if (group.timerId) clearTimeout(group.timerId);
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
  }
}

async function handleUpdate(env, update, ctx) {
  if (!update.message) return;
  
  const msg = update.message;
  const userId = msg.from.id;
  const adminId = parseInt(env.ADMIN_USER_ID);
  if (Number(userId) !== adminId) return;
  
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const mediaGroupId = msg.media_group_id;
  
  if (mediaGroupId) {
    await handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx);
  } else {
    await handleNormalMessage(env, chatId, messageId, ctx);
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
        info[id] = { count: g.messages.length, ids: g.messages.map(m => m.message_id) };
      }
      return new Response(JSON.stringify({ buffer: info }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (request.method === 'POST' && url.pathname === '/flush') {
      for (const [id, g] of mediaGroupBuffer.entries()) {
        if (g.timerId) clearTimeout(g.timerId);
        await finalizeMediaGroup(env, g.chatId, id);
      }
      return new Response('Flushed');
    }
    
    if (request.method === 'POST' && url.pathname === '/webhook') {
      try {
        const update = await request.json();
        await handleUpdate(env, update, ctx);
        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error(error);
        return new Response('Error', { status: 500 });
      }
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

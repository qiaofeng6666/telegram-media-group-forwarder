// Cloudflare Worker 代码 - 最终修复版

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
  if (!group || group.messages.length === 0 || group.isProcessing) {
    return false;
  }
  
  group.isProcessing = true;
  const messageIds = group.messages.map(m => m.message_id);
  console.log(`🎯 发送 ${mediaGroupId}: ${messageIds.length}条`);
  
  const result = await copyMultipleMessages(env.BOT_TOKEN, chatId, env.ADMIN_USER_ID, messageIds);
  
  if (result.ok) {
    for (const msgId of messageIds) {
      await deleteMessage(env.BOT_TOKEN, chatId, msgId);
    }
    console.log(`✅ 发送成功`);
  }
  
  mediaGroupBuffer.delete(mediaGroupId);
  return result.ok;
}

function getTimeout(count) {
  if (count >= MAX_MEDIA_GROUP_SIZE) return 0;
  return DYNAMIC_TIMEOUT_CONFIG[count] || 1500;
}

async function handleMediaGroupMessage(env, chatId, messageId, mediaGroupId) {
  let group = mediaGroupBuffer.get(mediaGroupId);
  
  if (group) {
    if (!group.messages.some(m => m.message_id === messageId)) {
      group.messages.push({ message_id: messageId, timestamp: Date.now() });
      group.lastUpdate = Date.now();
      const count = group.messages.length;
      console.log(`📸 ${mediaGroupId}: ${count}条`);
      
      if (count === MAX_MEDIA_GROUP_SIZE) {
        // 达到10条，立即发送
        await finalizeMediaGroup(env, chatId, mediaGroupId);
      } else {
        // 关键修复：先清除旧定时器，再设置新定时器
        if (group.timerId) {
          clearTimeout(group.timerId);
          group.timerId = null;
        }
        const timeout = getTimeout(count);
        group.timerId = setTimeout(async () => {
          console.log(`⏰ 超时: ${mediaGroupId} (${count}条)`);
          await finalizeMediaGroup(env, chatId, mediaGroupId);
        }, timeout);
      }
    }
  } else {
    console.log(`📸 ${mediaGroupId}: 创建`);
    const timeout = getTimeout(1);
    const timerId = setTimeout(async () => {
      console.log(`⏰ 超时: ${mediaGroupId} (1条)`);
      await finalizeMediaGroup(env, chatId, mediaGroupId);
    }, timeout);
    
    mediaGroupBuffer.set(mediaGroupId, {
      messages: [{ message_id: messageId, timestamp: Date.now() }],
      lastUpdate: Date.now(),
      chatId: chatId,
      isProcessing: false,
      timerId: timerId
    });
  }
}

async function handleNormalMessage(env, chatId, messageId) {
  // 先发送所有缓冲的媒体组
  for (const [groupId, group] of mediaGroupBuffer.entries()) {
    if (group && !group.isProcessing) {
      if (group.timerId) {
        clearTimeout(group.timerId);
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
  }
}

async function handleUpdate(env, update) {
  if (!update.message) return;
  
  const msg = update.message;
  const userId = msg.from.id;
  const adminId = parseInt(env.ADMIN_USER_ID);
  if (Number(userId) !== adminId) return;
  
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const mediaGroupId = msg.media_group_id;
  
  if (mediaGroupId) {
    await handleMediaGroupMessage(env, chatId, messageId, mediaGroupId);
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
        info[id] = { count: g.messages.length, hasTimer: !!g.timerId };
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
        // 关键：不使用 waitUntil，让 fetch 等待处理完成
        await handleUpdate(env, update);
        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error(error);
        return new Response('Error', { status: 500 });
      }
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

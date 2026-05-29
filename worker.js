// Cloudflare Worker 代码 - 修复并发创建问题（简洁版）

// 媒体组缓冲区
const mediaGroupBuffer = new Map();

// 正在创建中的媒体组锁
const creatingGroups = new Set();

// Telegram 媒体组最多 10 条消息
const MAX_MEDIA_GROUP_SIZE = 10;

// 动态超时配置
const DYNAMIC_TIMEOUT_CONFIG = {
  1: 2000, 2: 1800, 3: 1500, 4: 1200, 5: 1000,
  6: 800, 7: 700, 8: 600, 9: 550, 10: 500
};

const pendingTimeouts = new Map();

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
      chat_id: Number(chatId),
      message_id: messageId
    });
  } catch (error) {
    console.error('删除消息失败:', error.message);
  }
}

async function copyMultipleMessages(botToken, fromChatId, toChatId, messageIds) {
  const sortedIds = [...messageIds].sort((a, b) => a - b);
  console.log(`📦 批量复制 ${sortedIds.length} 条消息，IDs: ${sortedIds.join(', ')}`);
  
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
  console.log(`🎯 媒体组 ${mediaGroupId} 收集完成，共 ${messageIds.length} 条消息`);
  
  const result = await copyMultipleMessages(
    env.BOT_TOKEN, chatId, env.ADMIN_USER_ID, messageIds
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
  pendingTimeouts.delete(mediaGroupId);
  return result.ok;
}

function getDynamicTimeout(messageCount) {
  if (messageCount >= MAX_MEDIA_GROUP_SIZE) return 0;
  return DYNAMIC_TIMEOUT_CONFIG[messageCount] || 1500;
}

async function checkAndProcessTimeouts(env) {
  const now = Date.now();
  for (const [groupId, group] of mediaGroupBuffer.entries()) {
    if (group.isProcessing) continue;
    const timeSinceLastUpdate = now - group.lastUpdate;
    const dynamicTimeout = getDynamicTimeout(group.messages.length);
    if (timeSinceLastUpdate >= dynamicTimeout) {
      console.log(`⏰ 超时媒体组: ${groupId}`);
      await finalizeMediaGroup(env, group.chatId, groupId);
    }
  }
}

function scheduleTimeoutCheck(env, ctx, mediaGroupId, messageCount) {
  const timeout = getDynamicTimeout(messageCount);
  if (timeout === 0) return;
  
  if (pendingTimeouts.has(mediaGroupId)) {
    clearTimeout(pendingTimeouts.get(mediaGroupId));
  }
  
  const timerId = setTimeout(async () => {
    pendingTimeouts.delete(mediaGroupId);
    await checkAndProcessTimeouts(env);
  }, timeout);
  
  pendingTimeouts.set(mediaGroupId, timerId);
  
  ctx.waitUntil(new Promise(async (resolve) => {
    await new Promise(r => setTimeout(r, timeout));
    await checkAndProcessTimeouts(env);
    resolve();
  }));
  
  console.log(`   ⏲️ 设置动态超时: ${timeout}ms (消息数: ${messageCount})`);
}

// 核心修复：带并发控制的媒体组消息处理
async function handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx) {
  console.log(`📸 媒体组消息: ID=${messageId}, 组ID=${mediaGroupId}`);
  
  await checkAndProcessTimeouts(env);
  
  // 处理不同的媒体组 - 改为设置短超时而不是立即发送
  if (mediaGroupBuffer.size > 0) {
    const existingGroupIds = Array.from(mediaGroupBuffer.keys());
    if (!existingGroupIds.includes(mediaGroupId)) {
      console.log(`   🔄 检测到不同媒体组: 当前=${mediaGroupId}, 缓冲区中的=${existingGroupIds.join(', ')}`);
      for (const oldGroupId of existingGroupIds) {
        const oldGroup = mediaGroupBuffer.get(oldGroupId);
        if (oldGroup && !oldGroup.isProcessing && !pendingTimeouts.has(oldGroupId)) {
          console.log(`   ⏲️ 为旧媒体组设置短超时(500ms): ${oldGroupId}`);
          const shortTimeout = 500;
          const timerId = setTimeout(async () => {
            pendingTimeouts.delete(oldGroupId);
            await finalizeMediaGroup(env, chatId, oldGroupId);
          }, shortTimeout);
          pendingTimeouts.set(oldGroupId, timerId);
          ctx.waitUntil(new Promise(async (resolve) => {
            await new Promise(r => setTimeout(r, shortTimeout));
            await finalizeMediaGroup(env, chatId, oldGroupId);
            resolve();
          }));
        }
      }
    }
  }
  
  // 核心修复：等待正在创建的媒体组
  let retryCount = 0;
  while (creatingGroups.has(mediaGroupId) && !mediaGroupBuffer.has(mediaGroupId) && retryCount < 20) {
    console.log(`   ⏳ 等待媒体组创建完成: ${mediaGroupId}`);
    await wait(50);
    retryCount++;
  }
  
  let currentCount = 0;
  
  if (mediaGroupBuffer.has(mediaGroupId)) {
    const group = mediaGroupBuffer.get(mediaGroupId);
    const exists = group.messages.some(m => m.message_id === messageId);
    if (!exists) {
      group.messages.push({ message_id: messageId, timestamp: Date.now() });
      group.lastUpdate = Date.now();
      currentCount = group.messages.length;
      console.log(`   ➕ 媒体组 ${mediaGroupId} 现有 ${currentCount} 条消息`);
    } else {
      currentCount = group.messages.length;
      console.log(`   ⚠️ 消息 ${messageId} 已存在，当前总数: ${currentCount}`);
    }
    scheduleTimeoutCheck(env, ctx, mediaGroupId, currentCount);
  } else {
    // 加锁创建
    creatingGroups.add(mediaGroupId);
    try {
      console.log(`   🆕 创建新媒体组 ${mediaGroupId}，第一条消息 ID=${messageId}`);
      mediaGroupBuffer.set(mediaGroupId, {
        messages: [{ message_id: messageId, timestamp: Date.now() }],
        lastUpdate: Date.now(),
        chatId: chatId,
        isProcessing: false
      });
      currentCount = 1;
      scheduleTimeoutCheck(env, ctx, mediaGroupId, currentCount);
    } finally {
      creatingGroups.delete(mediaGroupId);
    }
  }
  
  if (currentCount === MAX_MEDIA_GROUP_SIZE) {
    console.log(`   🚀 达到最大数量 ${MAX_MEDIA_GROUP_SIZE} 条，立即发送！`);
    if (pendingTimeouts.has(mediaGroupId)) {
      clearTimeout(pendingTimeouts.get(mediaGroupId));
      pendingTimeouts.delete(mediaGroupId);
    }
    const group = mediaGroupBuffer.get(mediaGroupId);
    if (group && !group.isProcessing) {
      await finalizeMediaGroup(env, chatId, mediaGroupId);
    }
  }
  
  return { status: 'buffered', count: currentCount };
}

async function handleNormalMessage(env, chatId, messageId, ctx) {
  console.log(`📄 普通消息: ID=${messageId}`);
  await checkAndProcessTimeouts(env);
  
  if (mediaGroupBuffer.size > 0) {
    for (const [groupId, group] of mediaGroupBuffer.entries()) {
      if (group && !group.isProcessing) {
        await finalizeMediaGroup(env, chatId, groupId);
      }
    }
  }
  
  try {
    await sendTelegram(env.BOT_TOKEN, 'copyMessage', {
      chat_id: Number(env.ADMIN_USER_ID),
      from_chat_id: Number(chatId),
      message_id: messageId
    });
    await deleteMessage(env.BOT_TOKEN, chatId, messageId);
    console.log(`   ✅ 转发成功`);
    return { success: true };
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
  
  console.log(`收到消息: ID=${messageId}, 类型=${message.photo ? 'photo' : message.video ? 'video' : 'other'}, media_group_id=${mediaGroupId || '无'}`);
  
  let result;
  if (mediaGroupId) {
    result = await handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx);
  } else {
    result = await handleNormalMessage(env, chatId, messageId, ctx);
  }
  
  return result;
}

export default {
  async fetch(request, env, ctx) {
    if (!env.BOT_TOKEN || !env.ADMIN_USER_ID) {
      return new Response(JSON.stringify({ error: 'Missing env vars' }), { status: 500 });
    }
    
    const url = new URL(request.url);
    
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        buffer_size: mediaGroupBuffer.size,
        creating_groups: Array.from(creatingGroups),
        max_media_group_size: MAX_MEDIA_GROUP_SIZE
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    
    if (request.method === 'POST' && url.pathname === '/flush') {
      for (const [groupId, group] of mediaGroupBuffer.entries()) {
        if (group && !group.isProcessing) {
          await finalizeMediaGroup(env, group.chatId, groupId);
        }
      }
      return new Response(JSON.stringify({ status: 'flushed' }));
    }
    
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

// Cloudflare Worker 代码 - 最小修复版本（保持原有转发逻辑）

// 媒体组缓冲区
const mediaGroupBuffer = new Map();

// Telegram 媒体组最多 10 条消息
const MAX_MEDIA_GROUP_SIZE = 10;

// 媒体组基础等待超时时间（毫秒）
const BASE_MEDIA_GROUP_TIMEOUT = 1500; // 1.5秒

// 动态超时配置
const DYNAMIC_TIMEOUT_CONFIG = {
  1: 2000,   // 1条消息：等待2秒
  2: 1800,   // 2条消息：等待1.8秒
  3: 1500,   // 3条消息：等待1.5秒
  4: 1200,   // 4条消息：等待1.2秒
  5: 1000,   // 5条消息：等待1秒
  6: 800,    // 6条消息：等待0.8秒
  7: 700,    // 7条消息：等待0.7秒
  8: 600,    // 8条消息：等待0.6秒
  9: 550,    // 9条消息：等待0.55秒
  10: 500    // 10条消息：等待0.5秒（但达到10条会立即发送）
};

// 存储待处理的超时检查
const pendingTimeouts = new Map();

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
  
  // 防止重复处理
  if (group.isProcessing) {
    console.log(`⚠️ 媒体组 ${mediaGroupId} 正在处理中，跳过`);
    return false;
  }
  
  group.isProcessing = true;
  
  const messageIds = group.messages.map(m => m.message_id);
  const messageCount = messageIds.length;
  
  console.log(`🎯 媒体组 ${mediaGroupId} 收集完成，共 ${messageCount} 条消息`);
  console.log(`   消息ID列表: ${messageIds.join(', ')}`);
  
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
    console.log(`   已删除 ${messageCount} 条原始消息`);
  } else {
    console.error(`❌ 媒体组转发失败: ${result.description}`);
    console.log(`   保留 ${messageCount} 条原始消息`);
  }
  
  mediaGroupBuffer.delete(mediaGroupId);
  pendingTimeouts.delete(mediaGroupId);
  return result.ok;
}

// 获取动态超时时间
function getDynamicTimeout(messageCount) {
  // 如果达到最大数量，立即发送（超时0）
  if (messageCount >= MAX_MEDIA_GROUP_SIZE) {
    return 0;
  }
  // 根据消息数量返回对应的超时时间
  return DYNAMIC_TIMEOUT_CONFIG[messageCount] || BASE_MEDIA_GROUP_TIMEOUT;
}

// 检查并处理超时的媒体组
async function checkAndProcessTimeouts(env) {
  const now = Date.now();
  const expiredGroups = [];
  
  for (const [groupId, group] of mediaGroupBuffer.entries()) {
    if (group.isProcessing) continue;
    
    const timeSinceLastUpdate = now - group.lastUpdate;
    const dynamicTimeout = getDynamicTimeout(group.messages.length);
    
    if (timeSinceLastUpdate >= dynamicTimeout) {
      console.log(`⏰ 检测到超时媒体组: ${groupId}，已等待 ${timeSinceLastUpdate}ms (阈值: ${dynamicTimeout}ms, 消息数: ${group.messages.length})`);
      expiredGroups.push(groupId);
    }
  }
  
  for (const groupId of expiredGroups) {
    const group = mediaGroupBuffer.get(groupId);
    if (group && !group.isProcessing) {
      await finalizeMediaGroup(env, group.chatId, groupId);
    }
  }
}

// 安排超时检查（通过延迟执行）
function scheduleTimeoutCheck(env, ctx, mediaGroupId, messageCount) {
  const timeout = getDynamicTimeout(messageCount);
  
  // 如果超时时间为0，立即处理
  if (timeout === 0) {
    return;
  }
  
  // 清除已有的定时器
  if (pendingTimeouts.has(mediaGroupId)) {
    const oldTimer = pendingTimeouts.get(mediaGroupId);
    clearTimeout(oldTimer);
  }
  
  // 设置新的定时器
  const timerId = setTimeout(async () => {
    pendingTimeouts.delete(mediaGroupId);
    await checkAndProcessTimeouts(env);
  }, timeout);
  
  pendingTimeouts.set(mediaGroupId, timerId);
  
  // 同时使用 ctx.waitUntil 确保任务完成
  const timeoutPromise = new Promise(async (resolve) => {
    await new Promise(r => setTimeout(r, timeout));
    await checkAndProcessTimeouts(env);
    resolve();
  });
  
  ctx.waitUntil(timeoutPromise);
  
  console.log(`   ⏲️ 设置动态超时: ${timeout}ms (当前消息数: ${messageCount})`);
}

// 处理媒体组消息 - 保持原始逻辑，只添加去重
async function handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx) {
  console.log(`📸 媒体组消息: ID=${messageId}, 组ID=${mediaGroupId}`);
  
  // 先检查并处理已有的超时媒体组
  await checkAndProcessTimeouts(env);
  
  // 检查是否有其他正在等待的不同媒体组
  if (mediaGroupBuffer.size > 0) {
    const existingGroupIds = Array.from(mediaGroupBuffer.keys());
    
    // 如果当前消息的媒体组 ID 与缓冲区中的不同，且不是同一个组
    if (!existingGroupIds.includes(mediaGroupId)) {
      console.log(`   🔄 检测到不同媒体组: 当前=${mediaGroupId}, 缓冲区中的=${existingGroupIds.join(', ')}`);
      
      // 发送所有旧的媒体组（不是当前的）
      for (const oldGroupId of existingGroupIds) {
        const oldGroup = mediaGroupBuffer.get(oldGroupId);
        if (oldGroup && !oldGroup.isProcessing) {
          console.log(`   📤 发送缓冲区中的媒体组: ${oldGroupId}`);
          await finalizeMediaGroup(env, chatId, oldGroupId);
        }
      }
    }
  }
  
  // 添加到当前媒体组
  let currentCount = 0;
  
  if (mediaGroupBuffer.has(mediaGroupId)) {
    const group = mediaGroupBuffer.get(mediaGroupId);
    
    // 唯一修复：添加去重检查，避免重复添加同一条消息
    const exists = group.messages.some(m => m.message_id === messageId);
    if (!exists) {
      group.messages.push({ message_id: messageId, timestamp: Date.now() });
      group.lastUpdate = Date.now();
      currentCount = group.messages.length;
      console.log(`   ➕ 媒体组 ${mediaGroupId} 现有 ${currentCount} 条消息`);
    } else {
      currentCount = group.messages.length;
      console.log(`   ⚠️ 消息 ${messageId} 已存在，跳过重复添加，当前总数: ${currentCount}`);
    }
    
    // 更新超时检查
    scheduleTimeoutCheck(env, ctx, mediaGroupId, currentCount);
  } else {
    console.log(`   🆕 创建新媒体组 ${mediaGroupId}，第一条消息 ID=${messageId}`);
    mediaGroupBuffer.set(mediaGroupId, {
      messages: [{ message_id: messageId, timestamp: Date.now() }],
      lastUpdate: Date.now(),
      chatId: chatId,
      isProcessing: false
    });
    currentCount = 1;
    
    // 为新媒体组设置超时检查
    scheduleTimeoutCheck(env, ctx, mediaGroupId, currentCount);
  }
  
  // 如果达到最大数量（10条），立即发送并清除定时器
  if (currentCount === MAX_MEDIA_GROUP_SIZE) {
    console.log(`   🚀 已达到媒体组最大数量 ${MAX_MEDIA_GROUP_SIZE} 条，立即发送！`);
    
    // 清除定时器
    if (pendingTimeouts.has(mediaGroupId)) {
      const timerId = pendingTimeouts.get(mediaGroupId);
      clearTimeout(timerId);
      pendingTimeouts.delete(mediaGroupId);
    }
    
    const group = mediaGroupBuffer.get(mediaGroupId);
    if (group && !group.isProcessing) {
      await finalizeMediaGroup(env, chatId, mediaGroupId);
    }
  }
  
  return { status: 'buffered', media_group_id: mediaGroupId, count: currentCount };
}

// 处理普通消息
async function handleNormalMessage(env, chatId, messageId, ctx) {
  console.log(`📄 普通消息: ID=${messageId}，直接复制`);
  
  // 先检查并处理所有超时的媒体组
  await checkAndProcessTimeouts(env);
  
  // 如果有正在等待的媒体组，先发送它们
  if (mediaGroupBuffer.size > 0) {
    const existingGroupIds = Array.from(mediaGroupBuffer.keys());
    console.log(`   📤 收到普通消息，先发送缓冲区中的 ${existingGroupIds.length} 个媒体组...`);
    
    for (const groupId of existingGroupIds) {
      const group = mediaGroupBuffer.get(groupId);
      if (group && !group.isProcessing) {
        await finalizeMediaGroup(env, chatId, groupId);
      }
    }
  }
  
  try {
    await sendTelegram(env.BOT_TOKEN, 'copyMessage', {
      chat_id: env.ADMIN_USER_ID,
      from_chat_id: chatId,
      message_id: messageId
    });
    await deleteMessage(env.BOT_TOKEN, chatId, messageId);
    console.log(`   ✅ 转发成功`);
    return { success: true };
  } catch (error) {
    console.error(`   ❌ 转发失败: ${error.message}`);
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
  if (Number(user.id) !== adminUserId) {
    console.log(`忽略非授权用户: ${user.id}`);
    return { status: 'ignored' };
  }
  
  let msgType = 'unknown';
  if (message.photo) msgType = 'photo';
  else if (message.video) msgType = 'video';
  else if (message.text) msgType = 'text';
  else if (message.document) msgType = 'document';
  
  console.log(`收到消息: ID=${messageId}, 类型=${msgType}, media_group_id=${mediaGroupId || '无'}`);
  
  let result;
  if (mediaGroupId) {
    result = await handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx);
  } else {
    result = await handleNormalMessage(env, chatId, messageId, ctx);
  }
  
  // 在响应返回后，再次安排超时检查，确保最后的媒体组能被处理
  if (mediaGroupBuffer.size > 0) {
    for (const [groupId, group] of mediaGroupBuffer.entries()) {
      if (!group.isProcessing) {
        scheduleTimeoutCheck(env, ctx, groupId, group.messages.length);
      }
    }
  }
  
  return result;
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
        const dynamicTimeout = getDynamicTimeout(group.messages.length);
        bufferInfo[groupId] = {
          count: group.messages.length,
          ids: group.messages.map(m => m.message_id),
          lastUpdate: new Date(group.lastUpdate).toISOString(),
          age_ms: age,
          will_timeout_in_ms: Math.max(0, dynamicTimeout - age),
          dynamic_timeout_ms: dynamicTimeout,
          isProcessing: group.isProcessing || false
        };
        totalMessages += group.messages.length;
      }
      
      return new Response(JSON.stringify({
        status: 'ok',
        buffer_size: mediaGroupBuffer.size,
        total_buffered_messages: totalMessages,
        buffer_info: bufferInfo,
        max_media_group_size: MAX_MEDIA_GROUP_SIZE,
        base_timeout_ms: BASE_MEDIA_GROUP_TIMEOUT,
        dynamic_timeout_config: DYNAMIC_TIMEOUT_CONFIG,
        note: "最小修复版：只添加去重功能，保持原有转发逻辑"
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 手动发送所有媒体组
    if (request.method === 'POST' && url.pathname === '/flush') {
      const groupIds = Array.from(mediaGroupBuffer.keys());
      console.log(`📤 手动发送所有媒体组，共 ${groupIds.length} 个`);
      
      let successCount = 0;
      let failCount = 0;
      
      for (const groupId of groupIds) {
        const group = mediaGroupBuffer.get(groupId);
        if (group && group.chatId && !group.isProcessing) {
          const result = await finalizeMediaGroup(env, group.chatId, groupId);
          if (result) {
            successCount++;
          } else {
            failCount++;
          }
        }
      }
      
      return new Response(JSON.stringify({ 
        status: 'flushed',
        flushed_groups: successCount,
        failed_groups: failCount,
        total_groups: groupIds.length
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 清除缓冲区 - 先转发所有消息再清理
    if (request.method === 'POST' && url.pathname === '/clearbuffer') {
      const groupIds = Array.from(mediaGroupBuffer.keys());
      let totalMessages = 0;
      
      for (const group of mediaGroupBuffer.values()) {
        totalMessages += group.messages.length;
      }
      
      console.log(`🧹 清理缓冲区请求，当前有 ${groupIds.length} 个媒体组，共 ${totalMessages} 条消息`);
      
      let flushedGroups = 0;
      let failedGroups = 0;
      
      for (const groupId of groupIds) {
        const group = mediaGroupBuffer.get(groupId);
        if (group && group.chatId && !group.isProcessing) {
          const result = await finalizeMediaGroup(env, group.chatId, groupId);
          if (result) {
            flushedGroups++;
          } else {
            failedGroups++;
          }
        }
      }
      
      // 清理残留
      for (const [groupId, group] of mediaGroupBuffer.entries()) {
        if (group.timeoutId) {
          clearTimeout(group.timeoutId);
        }
      }
      mediaGroupBuffer.clear();
      
      // 清除所有定时器
      for (const timerId of pendingTimeouts.values()) {
        clearTimeout(timerId);
      }
      pendingTimeouts.clear();
      
      return new Response(JSON.stringify({ 
        status: 'buffer_cleared',
        operation: 'flush_then_clear',
        flushed_groups: flushedGroups,
        failed_groups: failedGroups,
        total_groups: groupIds.length,
        total_messages: totalMessages,
        message: `已转发 ${flushedGroups} 个媒体组（共 ${totalMessages} 条消息）并清空缓冲区`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 设置Webhook
    if (request.method === 'GET' && url.pathname === '/setwebhook') {
      const webhookUrl = `https://${url.hostname}/webhook`;
      const result = await sendTelegram(env.BOT_TOKEN, 'setWebhook', { url: webhookUrl });
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 获取webhook信息
    if (request.method === 'GET' && url.pathname === '/webhookinfo') {
      const result = await sendTelegram(env.BOT_TOKEN, 'getWebhookInfo', {});
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // CORS预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    
    // Webhook主端点
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
          headers: { 'Content-Type': 'application/json' },
          status: 500
        });
      }
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

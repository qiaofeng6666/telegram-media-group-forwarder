// Cloudflare Worker 代码 - 智能动态延迟版本

// 媒体组缓冲区
const mediaGroupBuffer = new Map();

// Telegram 媒体组最多 10 条消息
const MAX_MEDIA_GROUP_SIZE = 10;

// 延迟处理队列
const delayedProcessing = new Map();

// 动态延迟时间配置（毫秒）
// 消息数量越少，等待时间越长，给用户更多时间发送后续消息
function getDynamicDelay(messageCount) {
  switch (messageCount) {
    case 1: return 3000;   // 只有1条，等待3秒（给用户时间发更多）
    case 2: return 2500;   // 2条，等待2.5秒
    case 3: return 2000;   // 3条，等待2秒
    case 4: return 1500;   // 4条，等待1.5秒
    case 5: return 1200;   // 5条，等待1.2秒
    case 6: return 1000;   // 6条，等待1秒
    case 7: return 800;    // 7条，等待0.8秒
    case 8: return 600;    // 8条，等待0.6秒
    case 9: return 500;    // 9条，等待0.5秒
    default: return 500;   // 10条或以上，等待0.5秒（10条会立即发送）
  }
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
  return result.ok;
}

// 延迟处理媒体组（等待所有消息到达）
function scheduleDelayedProcessing(env, ctx, chatId, mediaGroupId, currentCount) {
  // 如果已经有延迟处理，先取消
  if (delayedProcessing.has(mediaGroupId)) {
    clearTimeout(delayedProcessing.get(mediaGroupId));
    console.log(`   🔄 重置 ${mediaGroupId} 的延迟定时器`);
  }
  
  const delayMs = getDynamicDelay(currentCount);
  
  // 设置新的延迟处理
  const timerId = setTimeout(async () => {
    console.log(`⏰ 延迟处理触发: ${mediaGroupId}，等待了 ${delayMs}ms，当前消息数: ${currentCount}`);
    delayedProcessing.delete(mediaGroupId);
    
    const group = mediaGroupBuffer.get(mediaGroupId);
    if (group && !group.isProcessing && group.messages.length > 0) {
      await finalizeMediaGroup(env, chatId, mediaGroupId);
    }
  }, delayMs);
  
  delayedProcessing.set(mediaGroupId, timerId);
  
  // 使用 ctx.waitUntil 确保任务完成
  const waitUntilPromise = new Promise(async (resolve) => {
    await new Promise(r => setTimeout(r, delayMs));
    if (delayedProcessing.has(mediaGroupId)) {
      const group = mediaGroupBuffer.get(mediaGroupId);
      if (group && !group.isProcessing && group.messages.length > 0) {
        await finalizeMediaGroup(env, chatId, mediaGroupId);
        delayedProcessing.delete(mediaGroupId);
      }
    }
    resolve();
  });
  
  ctx.waitUntil(waitUntilPromise);
  
  console.log(`   ⏲️ 设置动态延迟: ${delayMs}ms (当前消息数: ${currentCount})`);
}

// 处理媒体组消息
async function handleMediaGroupMessage(env, chatId, messageId, mediaGroupId, ctx) {
  console.log(`📸 媒体组消息: ID=${messageId}, 组ID=${mediaGroupId}`);
  
  // 检查是否有其他正在等待的不同媒体组
  const existingGroupIds = Array.from(mediaGroupBuffer.keys());
  
  // 如果存在不同的媒体组，立即发送旧的
  for (const oldGroupId of existingGroupIds) {
    if (oldGroupId !== mediaGroupId) {
      const oldGroup = mediaGroupBuffer.get(oldGroupId);
      if (oldGroup && !oldGroup.isProcessing) {
        console.log(`   📤 检测到不同媒体组，立即发送: ${oldGroupId} (共 ${oldGroup.messages.length} 条)`);
        
        // 取消该组的延迟处理
        if (delayedProcessing.has(oldGroupId)) {
          clearTimeout(delayedProcessing.get(oldGroupId));
          delayedProcessing.delete(oldGroupId);
        }
        
        await finalizeMediaGroup(env, chatId, oldGroupId);
      }
    }
  }
  
  // 添加到当前媒体组
  let currentCount = 0;
  
  if (mediaGroupBuffer.has(mediaGroupId)) {
    const group = mediaGroupBuffer.get(mediaGroupId);
    group.messages.push({ message_id: messageId, timestamp: Date.now() });
    group.lastUpdate = Date.now();
    currentCount = group.messages.length;
    console.log(`   ➕ 媒体组 ${mediaGroupId} 现有 ${currentCount} 条消息`);
  } else {
    console.log(`   🆕 创建新媒体组 ${mediaGroupId}，第一条消息 ID=${messageId}`);
    mediaGroupBuffer.set(mediaGroupId, {
      messages: [{ message_id: messageId, timestamp: Date.now() }],
      lastUpdate: Date.now(),
      chatId: chatId,
      isProcessing: false
    });
    currentCount = 1;
  }
  
  // 如果达到最大数量（10条），立即发送
  if (currentCount === MAX_MEDIA_GROUP_SIZE) {
    console.log(`   🚀 已达到最大数量 ${MAX_MEDIA_GROUP_SIZE} 条，立即发送！`);
    
    // 取消延迟处理
    if (delayedProcessing.has(mediaGroupId)) {
      clearTimeout(delayedProcessing.get(mediaGroupId));
      delayedProcessing.delete(mediaGroupId);
    }
    
    const group = mediaGroupBuffer.get(mediaGroupId);
    if (group && !group.isProcessing) {
      await finalizeMediaGroup(env, chatId, mediaGroupId);
    }
  } else {
    // 未达到最大数量，设置动态延迟处理
    scheduleDelayedProcessing(env, ctx, chatId, mediaGroupId, currentCount);
  }
  
  return { status: 'buffered', media_group_id: mediaGroupId, count: currentCount };
}

// 处理普通消息
async function handleNormalMessage(env, chatId, messageId, ctx) {
  console.log(`📄 普通消息: ID=${messageId}，直接复制`);
  
  // 如果有正在等待的媒体组，先发送它们
  if (mediaGroupBuffer.size > 0) {
    const existingGroupIds = Array.from(mediaGroupBuffer.keys());
    console.log(`   📤 收到普通消息，先发送缓冲区中的 ${existingGroupIds.length} 个媒体组...`);
    
    for (const groupId of existingGroupIds) {
      // 取消延迟处理
      if (delayedProcessing.has(groupId)) {
        clearTimeout(delayedProcessing.get(groupId));
        delayedProcessing.delete(groupId);
      }
      
      const group = mediaGroupBuffer.get(groupId);
      if (group && !group.isProcessing) {
        console.log(`   📤 发送媒体组: ${groupId} (共 ${group.messages.length} 条)`);
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
      
      for (const [groupId, group] of mediaGroupBuffer.entries()) {
        const dynamicDelay = getDynamicDelay(group.messages.length);
        bufferInfo[groupId] = {
          count: group.messages.length,
          ids: group.messages.map(m => m.message_id),
          lastUpdate: new Date(group.lastUpdate).toISOString(),
          age_ms: Date.now() - group.lastUpdate,
          dynamic_delay_ms: dynamicDelay,
          will_send_in_ms: Math.max(0, dynamicDelay - (Date.now() - group.lastUpdate)),
          isProcessing: group.isProcessing || false,
          hasDelayedTimer: delayedProcessing.has(groupId)
        };
        totalMessages += group.messages.length;
      }
      
      return new Response(JSON.stringify({
        status: 'ok',
        buffer_size: mediaGroupBuffer.size,
        total_buffered_messages: totalMessages,
        buffer_info: bufferInfo,
        max_media_group_size: MAX_MEDIA_GROUP_SIZE,
        dynamic_delay_config: {
          1: "3000ms (3秒)",
          2: "2500ms (2.5秒)",
          3: "2000ms (2秒)",
          4: "1500ms (1.5秒)",
          5: "1200ms (1.2秒)",
          6: "1000ms (1秒)",
          7: "800ms (0.8秒)",
          8: "600ms (0.6秒)",
          9: "500ms (0.5秒)",
          10: "立即发送"
        },
        strategy: "智能动态延迟：消息数量越少，等待时间越长，确保收集完整媒体组"
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 手动发送所有媒体组
    if (request.method === 'POST' && url.pathname === '/flush') {
      // 清除所有延迟定时器
      for (const [groupId, timerId] of delayedProcessing.entries()) {
        clearTimeout(timerId);
      }
      delayedProcessing.clear();
      
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
      // 清除所有延迟定时器
      for (const [groupId, timerId] of delayedProcessing.entries()) {
        clearTimeout(timerId);
      }
      delayedProcessing.clear();
      
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
      mediaGroupBuffer.clear();
      
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

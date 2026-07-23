export const DEFAULT_BULK_IMAGE_DELETE_SIZE = 30;

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTag(value, settings = {}) {
  let normalized = String(value ?? "").trim();
  const customTagRegex = createCustomTagRegex(settings);
  const match = customTagRegex?.exec(normalized);
  if (match) {
    normalized = match[1].trim();
  }
  return normalized
    .replaceAll("《", "<")
    .replaceAll("》", ">")
    .replace(/\r?\n/g, "");
}

function tagsMatch(left, right, settings) {
  const normalizedLeft = normalizeTag(left, settings);
  const normalizedRight = normalizeTag(right, settings);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  const leftPrefix = normalizedLeft.slice(0, 100);
  const rightPrefix = normalizedRight.slice(0, 100);
  return leftPrefix === rightPrefix
    || normalizedLeft.startsWith(rightPrefix)
    || normalizedRight.startsWith(leftPrefix);
}

function createImageBlockRegex() {
  return new RegExp(
    "(?:<font[^>]*>\\[[^\\]]*\\]<\\/font>\\s*)?"
      + "(?:<Tag_think>[\\s\\S]*?<\\/Tag_think>\\s*)?"
      + "<image>([\\s\\S]*?)<\\/image>",
    "gi"
  );
}

function createCustomTagRegex({ startTag = "image###", endTag = "###" } = {}) {
  if (!startTag || !endTag) {
    return null;
  }

  return new RegExp(`${escapeRegExp(startTag)}([\\s\\S]*?)${escapeRegExp(endTag)}`, "g");
}

function extractTagFromImageContent(content, settings) {
  const customTagRegex = createCustomTagRegex(settings);
  const match = customTagRegex?.exec(String(content ?? ""));
  return normalizeTag(match ? match[1] : content, settings);
}

function getSwipeId(message) {
  const swipeId = Number.parseInt(message?.swipe_id ?? 0, 10);
  return Number.isInteger(swipeId) && swipeId >= 0 ? swipeId : 0;
}

function getActiveMessageText(message) {
  const swipeId = getSwipeId(message);
  if (Array.isArray(message?.swipes) && typeof message.swipes[swipeId] === "string") {
    return message.swipes[swipeId];
  }
  return typeof message?.mes === "string" ? message.mes : "";
}

function getCurrentSwipeImages(message) {
  const swipeId = getSwipeId(message);
  const images = message?.extra?.images?.[swipeId];
  return Array.isArray(images) ? images : [];
}

function collectLockedTags(message, settings) {
  const lockedTags = new Set();
  const storedLockedTags = Array.isArray(message?.extra?.lockedTags)
    ? message.extra.lockedTags
    : [];
  for (const tag of storedLockedTags) {
    const normalized = normalizeTag(tag, settings);
    if (normalized) {
      lockedTags.add(normalized);
    }
  }

  for (const image of getCurrentSwipeImages(message)) {
    if (image?.locked !== true) {
      continue;
    }
    const normalized = normalizeTag(image?.tag, settings);
    if (normalized) {
      lockedTags.add(normalized);
    }
  }
  return lockedTags;
}

function isTagLocked(tag, lockedTags, settings) {
  if (!tag) {
    return false;
  }
  for (const lockedTag of lockedTags) {
    if (tagsMatch(tag, lockedTag, settings)) {
      return true;
    }
  }
  return false;
}

function isStoredImageLocked(image, lockedTags, settings) {
  return image?.locked === true || isTagLocked(image?.tag, lockedTags, settings);
}

function extractTextImageCandidates(text, settings) {
  const candidates = [];
  const withoutBlocks = String(text ?? "").replace(createImageBlockRegex(), (_match, content) => {
    const tag = extractTagFromImageContent(content, settings);
    if (tag) {
      candidates.push({ tag, type: "image-block" });
    }
    return "";
  });

  const customTagRegex = createCustomTagRegex(settings);
  if (customTagRegex) {
    let match;
    while ((match = customTagRegex.exec(withoutBlocks)) !== null) {
      const tag = normalizeTag(match[1], settings);
      if (tag) {
        candidates.push({ tag, type: "custom-tag" });
      }
    }
  }
  return candidates;
}

function cleanMessageText(text, lockedTags, settings) {
  const deletedTags = new Set();
  let result = String(text ?? "").replace(createImageBlockRegex(), (match, content) => {
    const tag = extractTagFromImageContent(content, settings);
    if (isTagLocked(tag, lockedTags, settings)) {
      return match;
    }
    if (tag) {
      deletedTags.add(tag);
    }
    return "";
  });

  const customTagRegex = createCustomTagRegex(settings);
  if (customTagRegex) {
    result = result.replace(customTagRegex, (match, tagValue) => {
      const tag = normalizeTag(tagValue, settings);
      if (isTagLocked(tag, lockedTags, settings)) {
        return match;
      }
      if (tag) {
        deletedTags.add(tag);
      }
      return "";
    });
  }

  result = result.replace(/\n{3,}/g, "\n\n");
  return {
    text: result,
    changed: result !== String(text ?? ""),
    deletedTags: [...deletedTags]
  };
}

export function createDefaultBulkImageDeleteRange(
  currentMessageId,
  totalMessages,
  size = DEFAULT_BULK_IMAGE_DELETE_SIZE
) {
  const safeTotal = Math.max(0, Number.parseInt(totalMessages, 10) || 0);
  const safeCurrent = Math.min(
    Math.max(0, Number.parseInt(currentMessageId, 10) || 0),
    Math.max(0, safeTotal - 1)
  );
  const safeSize = Math.max(1, Number.parseInt(size, 10) || DEFAULT_BULK_IMAGE_DELETE_SIZE);
  return {
    startFloor: safeTotal > 0 ? safeCurrent + 1 : 0,
    endFloor: safeTotal > 0 ? Math.min(safeTotal, safeCurrent + safeSize) : 0
  };
}

export function resolveBulkImageDeleteRange({
  scope = "range",
  currentMessageId = 0,
  startFloor,
  endFloor,
  totalMessages = 0
} = {}) {
  const total = Number.parseInt(totalMessages, 10);
  if (!Number.isInteger(total) || total <= 0) {
    return { valid: false, error: "当前聊天没有可处理的楼层", messageIds: [] };
  }

  let start;
  let end;
  if (scope === "current") {
    const current = Number.parseInt(currentMessageId, 10);
    if (!Number.isInteger(current) || current < 0 || current >= total) {
      return { valid: false, error: "无法定位当前楼层", messageIds: [] };
    }
    start = current + 1;
    end = current + 1;
  } else if (scope === "all") {
    start = 1;
    end = total;
  } else if (scope === "range") {
    start = Number.parseInt(startFloor, 10);
    end = Number.parseInt(endFloor, 10);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return { valid: false, error: "请输入有效的起止楼层", messageIds: [] };
    }
    if (start < 1 || end > total) {
      return { valid: false, error: `楼层范围必须在 1～${total} 之间`, messageIds: [] };
    }
    if (start > end) {
      return { valid: false, error: "起始楼层不能大于结束楼层", messageIds: [] };
    }
  } else {
    return { valid: false, error: "请选择有效的删除范围", messageIds: [] };
  }

  const startMessageId = start - 1;
  const endMessageId = end - 1;
  return {
    valid: true,
    error: "",
    startFloor: start,
    endFloor: end,
    startMessageId,
    endMessageId,
    messageIds: Array.from(
      { length: endMessageId - startMessageId + 1 },
      (_value, index) => startMessageId + index
    )
  };
}

export function analyzeMessageImageDeletion(message, settings = {}) {
  if (!message || typeof message !== "object") {
    return { unlockedCount: 0, lockedCount: 0, hasImages: false };
  }

  const lockedTags = collectLockedTags(message, settings);
  const storedImages = getCurrentSwipeImages(message);
  const storedTags = storedImages
    .map((image) => normalizeTag(image?.tag, settings))
    .filter(Boolean);
  let unlockedCount = 0;
  let lockedCount = 0;

  for (const image of storedImages) {
    if (isStoredImageLocked(image, lockedTags, settings)) {
      lockedCount += 1;
    } else {
      unlockedCount += 1;
    }
  }

  for (const candidate of extractTextImageCandidates(getActiveMessageText(message), settings)) {
    const alreadyCounted = storedTags.some((storedTag) => tagsMatch(storedTag, candidate.tag, settings));
    if (alreadyCounted) {
      continue;
    }
    if (isTagLocked(candidate.tag, lockedTags, settings)) {
      lockedCount += 1;
    } else {
      unlockedCount += 1;
    }
  }

  return {
    unlockedCount,
    lockedCount,
    hasImages: unlockedCount + lockedCount > 0
  };
}

export function deleteUnlockedImagesFromMessage(message, settings = {}) {
  const analysis = analyzeMessageImageDeletion(message, settings);
  if (!message || typeof message !== "object") {
    return {
      changed: false,
      deletedCount: 0,
      lockedCount: 0,
      deletedTags: []
    };
  }

  const swipeId = getSwipeId(message);
  const lockedTags = collectLockedTags(message, settings);
  const deletedTags = new Set();
  let changed = false;
  const existingImages = getCurrentSwipeImages(message);
  if (existingImages.length > 0) {
    const remainingImages = existingImages.filter((image) => {
      if (isStoredImageLocked(image, lockedTags, settings)) {
        return true;
      }
      const tag = normalizeTag(image?.tag, settings);
      if (tag) {
        deletedTags.add(tag);
      }
      return false;
    });
    if (remainingImages.length !== existingImages.length) {
      changed = true;
      if (remainingImages.length > 0) {
        message.extra.images[swipeId] = remainingImages;
      } else {
        delete message.extra.images[swipeId];
      }
    }
  }

  if (typeof message.mes === "string") {
    const cleanedMes = cleanMessageText(message.mes, lockedTags, settings);
    if (cleanedMes.changed) {
      message.mes = cleanedMes.text;
      changed = true;
    }
    cleanedMes.deletedTags.forEach((tag) => deletedTags.add(tag));
  }

  if (Array.isArray(message.swipes) && typeof message.swipes[swipeId] === "string") {
    const cleanedSwipe = cleanMessageText(message.swipes[swipeId], lockedTags, settings);
    if (cleanedSwipe.changed) {
      message.swipes[swipeId] = cleanedSwipe.text;
      changed = true;
    }
    cleanedSwipe.deletedTags.forEach((tag) => deletedTags.add(tag));
  }

  return {
    changed,
    deletedCount: analysis.unlockedCount,
    lockedCount: analysis.lockedCount,
    deletedTags: [...deletedTags]
  };
}

export function summarizeBulkImageDeletion(chat, range, settings = {}) {
  if (!Array.isArray(chat) || !range?.valid) {
    return {
      floorCount: 0,
      floorsWithImages: 0,
      affectedFloors: 0,
      unlockedCount: 0,
      lockedCount: 0
    };
  }

  let floorsWithImages = 0;
  let affectedFloors = 0;
  let unlockedCount = 0;
  let lockedCount = 0;
  for (const messageId of range.messageIds) {
    const analysis = analyzeMessageImageDeletion(chat[messageId], settings);
    if (analysis.hasImages) {
      floorsWithImages += 1;
    }
    if (analysis.unlockedCount > 0) {
      affectedFloors += 1;
    }
    unlockedCount += analysis.unlockedCount;
    lockedCount += analysis.lockedCount;
  }

  return {
    floorCount: range.messageIds.length,
    floorsWithImages,
    affectedFloors,
    unlockedCount,
    lockedCount
  };
}

export function getBulkImageDeleteMessagePreview(message, settings = {}, limit = 52) {
  let text = getActiveMessageText(message);
  text = text.replace(createImageBlockRegex(), " ");
  const customTagRegex = createCustomTagRegex(settings);
  if (customTagRegex) {
    text = text.replace(customTagRegex, " ");
  }
  text = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "（空消息）";
  }
  const safeLimit = Math.max(8, Number.parseInt(limit, 10) || 52);
  return text.length > safeLimit ? `${text.slice(0, safeLimit)}…` : text;
}

export function getBulkImageDeleteLegacyKey(message, settings = {}) {
  let text = getActiveMessageText(message);
  text = text.replace(createImageBlockRegex(), "");
  const customTagRegex = createCustomTagRegex(settings);
  if (customTagRegex) {
    text = text.replace(customTagRegex, "");
  }
  text = text
    .replace(/<!--[\\s\\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
  if (!text) {
    return "";
  }
  const start = Math.max(0, Math.floor(text.length / 2) - 10);
  return text.slice(start, start + 20);
}

export async function runBulkImageDeletion(chat, messageIds, {
  settings = {},
  shouldStop = () => false,
  onProgress = () => {},
  yieldEvery = 25,
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0))
} = {}) {
  const ids = Array.isArray(messageIds) ? messageIds : [];
  const result = {
    total: ids.length,
    processed: 0,
    changedFloors: 0,
    deletedCount: 0,
    lockedCount: 0,
    failed: 0,
    stopped: false,
    changedMessageIds: [],
    deletedTagsByMessageId: new Map()
  };
  const normalizedYieldEvery = Math.max(1, Number.parseInt(yieldEvery, 10) || 25);

  for (const messageId of ids) {
    if (shouldStop()) {
      result.stopped = true;
      break;
    }

    try {
      const deletion = deleteUnlockedImagesFromMessage(chat?.[messageId], settings);
      result.deletedCount += deletion.deletedCount;
      result.lockedCount += deletion.lockedCount;
      if (deletion.changed) {
        result.changedFloors += 1;
        result.changedMessageIds.push(messageId);
        result.deletedTagsByMessageId.set(messageId, deletion.deletedTags);
      }
    } catch {
      result.failed += 1;
    }

    result.processed += 1;
    onProgress({ ...result, currentMessageId: messageId });
    if (result.processed % normalizedYieldEvery === 0 && result.processed < ids.length) {
      await yieldControl();
    }
  }

  if (shouldStop() && result.processed < ids.length) {
    result.stopped = true;
  }
  return result;
}

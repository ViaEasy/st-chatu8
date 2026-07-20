export const DEFAULT_FLOOR_BATCH_COUNT = 3;
export const MAX_FLOOR_BATCH_COUNT = 20;
export const DEFAULT_FLOOR_BATCH_MODE = "pipeline";

export function normalizeFloorBatchCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_FLOOR_BATCH_COUNT;
  }
  return Math.min(MAX_FLOOR_BATCH_COUNT, Math.max(1, parsed));
}

export function getMessageKind(message) {
  if (!message || typeof message !== "object") {
    return "unknown";
  }
  if (message.is_system === true) {
    return "system";
  }
  return message.is_user === true ? "user" : "character";
}

export function selectSubsequentSameKindMessages(chat, startMessageId, count = DEFAULT_FLOOR_BATCH_COUNT) {
  if (!Array.isArray(chat)) {
    return [];
  }
  const normalizedStartId = Number.parseInt(startMessageId, 10);
  if (!Number.isInteger(normalizedStartId) || normalizedStartId < 0 || normalizedStartId >= chat.length) {
    return [];
  }

  const targetKind = getMessageKind(chat[normalizedStartId]);
  if (targetKind === "unknown") {
    return [];
  }

  const limit = normalizeFloorBatchCount(count);
  const selected = [];
  for (let messageId = normalizedStartId + 1; messageId < chat.length && selected.length < limit; messageId += 1) {
    const message = chat[messageId];
    if (getMessageKind(message) === targetKind) {
      selected.push({ messageId, message });
    }
  }
  return selected;
}

export function messageHasGeneratedImage(message) {
  if (!message || typeof message !== "object") {
    return false;
  }

  const swipeId = message.swipe_id ?? 0;
  const swipeImages = message.extra?.images?.[swipeId];
  return Array.isArray(swipeImages) ? swipeImages.length > 0 : Boolean(swipeImages);
}

export function messageHasImageTag(message, { startTag = "", endTag = "" } = {}) {
  if (!message || typeof message !== "object") {
    return false;
  }

  const text = typeof message.mes === "string" ? message.mes : "";
  if (/<image>[\s\S]*?<\/image>/i.test(text)) {
    return true;
  }
  return Boolean(startTag && endTag && text.includes(startTag) && text.includes(endTag));
}

export function messageHasImageOrTag(message, settings = {}) {
  return messageHasGeneratedImage(message) || messageHasImageTag(message, settings);
}

export function summarizeFloorBatchTargets(targets, {
  skipExisting = true,
  settings = {}
} = {}) {
  const source = Array.isArray(targets) ? targets : [];
  let generateTag = 0;
  let reuseTag = 0;
  let skipped = 0;

  for (const target of source) {
    const message = target?.message ?? target;
    const hasGeneratedImage = messageHasGeneratedImage(message);
    if (skipExisting && hasGeneratedImage) {
      skipped += 1;
    } else if (!hasGeneratedImage && messageHasImageTag(message, settings)) {
      reuseTag += 1;
    } else {
      generateTag += 1;
    }
  }

  return {
    total: source.length,
    processing: source.length - skipped,
    generateTag,
    reuseTag,
    skipped
  };
}

export async function runFloorBatch(items, {
  concurrency = 1,
  worker,
  shouldStop = () => false,
  onProgress = () => {}
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { results: [], completed: 0, succeeded: 0, failed: 0, skipped: 0, stopped: Boolean(shouldStop()) };
  }
  if (typeof worker !== "function") {
    throw new TypeError("worker 必须是函数");
  }

  const workerCount = Math.min(items.length, Math.max(1, Number.parseInt(concurrency, 10) || 1));
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;

  const runWorker = async () => {
    while (!shouldStop()) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }

      const item = items[index];
      let entry;
      try {
        const value = await worker(item, index);
        const status = value?.skipped === true ? "skipped" : value?.success === false ? "failed" : "success";
        entry = { item, index, status, value };
      } catch (error) {
        entry = { item, index, status: "failed", error };
      }
      results[index] = entry;
      completed += 1;
      onProgress({ completed, total: items.length, entry });
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  const settledResults = results.filter(Boolean);
  return {
    results: settledResults,
    completed,
    succeeded: settledResults.filter((entry) => entry.status === "success").length,
    failed: settledResults.filter((entry) => entry.status === "failed").length,
    skipped: settledResults.filter((entry) => entry.status === "skipped").length,
    stopped: Boolean(shouldStop())
  };
}

function getPipelineEntryStatus(value) {
  if (value?.skipped === true) {
    return "skipped";
  }
  return value?.success === false ? "failed" : "success";
}

export async function runFloorPipeline(items, {
  maxInFlight = 2,
  worker,
  shouldStop = () => false,
  onSubmitted = () => {},
  onProgress = () => {}
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { results: [], submitted: 0, completed: 0, succeeded: 0, failed: 0, skipped: 0, stopped: Boolean(shouldStop()) };
  }
  if (typeof worker !== "function") {
    throw new TypeError("worker 必须是函数");
  }

  const inFlightLimit = Math.max(1, Number.parseInt(maxInFlight, 10) || 1);
  const results = new Array(items.length);
  const inFlight = new Set();
  let submitted = 0;
  let completed = 0;

  const finalize = (entry) => {
    results[entry.index] = entry;
    completed += 1;
    onProgress({ submitted, completed, total: items.length, entry });
    return entry;
  };

  const waitForCapacity = async () => {
    while (inFlight.size >= inFlightLimit) {
      await Promise.race(inFlight);
    }
  };

  for (let index = 0; index < items.length; index += 1) {
    if (shouldStop()) {
      break;
    }
    await waitForCapacity();
    if (shouldStop()) {
      break;
    }

    const item = items[index];
    let value;
    try {
      // worker 只负责生成 Tag 并提交图片请求；这里逐个 await，保证 Tag 阶段始终串行。
      value = await worker(item, index);
    } catch (error) {
      submitted += 1;
      onSubmitted({ submitted, total: items.length, item, index, error });
      finalize({ item, index, status: "failed", error });
      continue;
    }

    submitted += 1;
    onSubmitted({ submitted, total: items.length, item, index, value });
    const completion = value?.completion;
    if (!completion || typeof completion.then !== "function") {
      finalize({ item, index, status: getPipelineEntryStatus(value), value });
      continue;
    }

    let ticket;
    ticket = Promise.resolve(completion)
      .then((completionValue) => {
        const finalValue = completionValue && typeof completionValue === "object"
          ? { ...value, ...completionValue, completion: undefined }
          : { ...value, completion: undefined };
        return finalize({ item, index, status: getPipelineEntryStatus(finalValue), value: finalValue });
      })
      .catch((error) => finalize({ item, index, status: "failed", error }))
      .finally(() => inFlight.delete(ticket));
    inFlight.add(ticket);
  }

  await Promise.all(inFlight);
  const settledResults = results.filter(Boolean);
  return {
    results: settledResults,
    submitted,
    completed,
    succeeded: settledResults.filter((entry) => entry.status === "success").length,
    failed: settledResults.filter((entry) => entry.status === "failed").length,
    skipped: settledResults.filter((entry) => entry.status === "skipped").length,
    stopped: Boolean(shouldStop())
  };
}

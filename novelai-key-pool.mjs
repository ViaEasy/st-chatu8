const PLACEHOLDER_KEY = "000000";

function createAbortError() {
  const error = new Error("任务已取消");
  error.name = "AbortError";
  return error;
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function getCooldownRemainingSeconds(cooldownUntil, now = Date.now()) {
  const endTime = Number(cooldownUntil);
  const currentTime = Number(now);
  if (!Number.isFinite(endTime) || !Number.isFinite(currentTime)) return 0;
  return Math.max(0, Math.ceil((endTime - currentTime) / 1_000));
}

function isUsableKey(value) {
  return typeof value === "string" && value.trim() !== "" && value.trim() !== PLACEHOLDER_KEY;
}

export function normalizeNovelAIKeys(keys) {
  if (!Array.isArray(keys)) return [];
  const seenIds = new Set();
  const seenKeys = new Set();
  const result = [];

  keys.forEach((entry, index) => {
    if (!entry || !isUsableKey(entry.key)) return;
    const normalizedKey = entry.key.trim();
    if (seenKeys.has(normalizedKey)) return;
    seenKeys.add(normalizedKey);
    let id = String(entry.id || `novelai-key-${index + 1}`).trim();
    if (!id) id = `novelai-key-${index + 1}`;
    while (seenIds.has(id)) id = `${id}-${index + 1}`;
    seenIds.add(id);
    result.push({
      id,
      label: String(entry.label || `Key ${index + 1}`).trim() || `Key ${index + 1}`,
      key: normalizedKey,
      enabled: entry.enabled !== false && String(entry.enabled) !== "false"
    });
  });

  return result;
}

export function migrateLegacyNovelAIKey(keys, legacyKey) {
  const normalized = normalizeNovelAIKeys(keys);
  if (normalized.length > 0 || !isUsableKey(legacyKey)) {
    return { keys: normalized, migrated: false };
  }

  return {
    keys: [{ id: "legacy", label: "默认 Key", key: legacyKey.trim(), enabled: true }],
    migrated: true
  };
}

export class NovelAIKeyPool {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
    this.onChange = options.onChange || (() => {});
    this.keys = [];
    this.maxConcurrency = 1;
    this.cooldownMs = 60_000;
    this.pending = [];
    this.active = new Map();
    this.runtime = new Map();
    this.wakeupTimer = null;
    this.configure(options);
  }

  configure(options = {}) {
    if (Object.hasOwn(options, "keys")) {
      this.keys = normalizeNovelAIKeys(options.keys);
      const currentIds = new Set(this.keys.map((entry) => entry.id));
      for (const keyId of this.runtime.keys()) {
        if (!currentIds.has(keyId) && !this._isKeyActive(keyId)) this.runtime.delete(keyId);
      }
      this.keys.forEach((entry) => this._getRuntime(entry.id));
    }
    if (Object.hasOwn(options, "maxConcurrency")) {
      this.maxConcurrency = clampInteger(options.maxConcurrency, 1, 1, 8);
    }
    if (Object.hasOwn(options, "cooldownMs")) {
      this.cooldownMs = clampInteger(options.cooldownMs, 60_000, 1_000, 10 * 60_000);
    }
    this._drain();
    this._notify();
  }

  acquire(taskId, options = {}) {
    const id = String(taskId || "").trim();
    if (!id) return Promise.reject(new Error("NovelAI 任务缺少 taskId"));
    if (this.active.has(id) || this.pending.some((request) => request.taskId === id)) {
      return Promise.reject(new Error(`NovelAI 任务已存在: ${id}`));
    }

    const excludeKeyIds = new Set((options.excludeKeyIds || []).map(String));
    const eligible = this.keys.filter((entry) => entry.enabled && !excludeKeyIds.has(entry.id));
    if (eligible.length === 0 || eligible.every((entry) => this._getRuntime(entry.id).disabled)) {
      const error = new Error(excludeKeyIds.size > 0 ? "没有其他可用的 NovelAI Key" : "没有启用的 NovelAI Key");
      error.code = excludeKeyIds.size > 0 ? "NO_ALTERNATIVE_NOVELAI_KEY" : "NO_NOVELAI_KEY";
      return Promise.reject(error);
    }
    if (options.signal?.aborted) return Promise.reject(createAbortError());

    return new Promise((resolve, reject) => {
      const request = {
        taskId: id,
        excludeKeyIds,
        signal: options.signal || null,
        resolve,
        reject,
        onAbort: null
      };
      if (request.signal) {
        request.onAbort = () => {
          const index = this.pending.indexOf(request);
          if (index !== -1) {
            this.pending.splice(index, 1);
            reject(createAbortError());
            this._notify();
          }
        };
        request.signal.addEventListener("abort", request.onAbort, { once: true });
      }
      this.pending.push(request);
      this._drain();
      this._notify();
    });
  }

  release(taskId, outcome = {}) {
    const activeTask = this.active.get(String(taskId));
    if (!activeTask) return false;

    this.active.delete(String(taskId));
    const runtime = this._getRuntime(activeTask.key.id);
    runtime.lastUsedAt = this.now();
    runtime.lastStatus = outcome.status || "success";
    runtime.lastError = outcome.error ? String(outcome.error) : "";

    if (outcome.status === "rate_limited") {
      const retryAfterMs = clampInteger(outcome.retryAfterMs, this.cooldownMs, 1_000, 10 * 60_000);
      runtime.cooldownUntil = Math.max(runtime.cooldownUntil, this.now() + retryAfterMs);
    } else if (outcome.status === "invalid") {
      runtime.disabled = true;
    }

    this._drain();
    this._notify();
    return true;
  }

  cancel(taskId) {
    const id = String(taskId);
    const pendingIndex = this.pending.findIndex((request) => request.taskId === id);
    if (pendingIndex !== -1) {
      const [request] = this.pending.splice(pendingIndex, 1);
      this._detachAbortListener(request);
      request.reject(createAbortError());
      this._notify();
      return true;
    }
    return this.active.has(id);
  }

  resetKey(keyId) {
    const runtime = this._getRuntime(String(keyId));
    runtime.disabled = false;
    runtime.cooldownUntil = 0;
    runtime.lastError = "";
    runtime.lastStatus = "idle";
    this._drain();
    this._notify();
  }

  getSnapshot() {
    const now = this.now();
    const activeByKey = new Map();
    for (const activeTask of this.active.values()) {
      activeByKey.set(activeTask.key.id, (activeByKey.get(activeTask.key.id) || 0) + 1);
    }
    return {
      maxConcurrency: this.maxConcurrency,
      running: this.active.size,
      pending: this.pending.length,
      keys: this.keys.map((entry) => {
        const runtime = this._getRuntime(entry.id);
        const activeCount = activeByKey.get(entry.id) || 0;
        let status = "idle";
        if (!entry.enabled || runtime.disabled) status = "disabled";
        else if (activeCount > 0) status = "running";
        else if (runtime.cooldownUntil > now) status = "cooldown";
        return {
          id: entry.id,
          label: entry.label,
          enabled: entry.enabled && !runtime.disabled,
          status,
          activeCount,
          cooldownUntil: runtime.cooldownUntil,
          lastStatus: runtime.lastStatus,
          lastError: runtime.lastError
        };
      })
    };
  }

  _drain() {
    this._rejectImpossibleRequests();
    if (this.pending.length === 0 || this.active.size >= this.maxConcurrency) {
      this._scheduleWakeup();
      return;
    }
    let madeProgress = true;
    while (madeProgress && this.pending.length > 0 && this.active.size < this.maxConcurrency) {
      madeProgress = false;
      for (let index = 0; index < this.pending.length; index++) {
        const request = this.pending[index];
        if (request.signal?.aborted) {
          this.pending.splice(index, 1);
          index--;
          this._detachAbortListener(request);
          request.reject(createAbortError());
          continue;
        }
        const key = this._selectKey(request.excludeKeyIds);
        if (!key) continue;

        this.pending.splice(index, 1);
        this._detachAbortListener(request);
        this.active.set(request.taskId, { key, startedAt: this.now() });
        const runtime = this._getRuntime(key.id);
        runtime.lastUsedAt = this.now();
        runtime.lastStatus = "running";
        request.resolve({
          taskId: request.taskId,
          key: { ...key },
          release: (outcome) => this.release(request.taskId, outcome)
        });
        madeProgress = true;
        break;
      }
    }
    this._scheduleWakeup();
  }

  _selectKey(excludeKeyIds) {
    const now = this.now();
    return this.keys
      .filter((entry) => {
        const runtime = this._getRuntime(entry.id);
        return entry.enabled && !runtime.disabled && !excludeKeyIds.has(entry.id) && runtime.cooldownUntil <= now && !this._isKeyActive(entry.id);
      })
      .sort((a, b) => this._getRuntime(a.id).lastUsedAt - this._getRuntime(b.id).lastUsedAt)[0] || null;
  }

  _rejectImpossibleRequests() {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const request = this.pending[index];
      const hasPotentialKey = this.keys.some((entry) => {
        return entry.enabled && !request.excludeKeyIds.has(entry.id) && !this._getRuntime(entry.id).disabled;
      });
      if (hasPotentialKey) continue;
      this.pending.splice(index, 1);
      this._detachAbortListener(request);
      const error = new Error(request.excludeKeyIds.size > 0 ? "没有其他可用的 NovelAI Key" : "没有启用的 NovelAI Key");
      error.code = request.excludeKeyIds.size > 0 ? "NO_ALTERNATIVE_NOVELAI_KEY" : "NO_NOVELAI_KEY";
      request.reject(error);
    }
  }

  _scheduleWakeup() {
    if (this.wakeupTimer) {
      this.clearTimer(this.wakeupTimer);
      this.wakeupTimer = null;
    }
    const now = this.now();
    const cooldowns = this.keys
      .filter((entry) => {
        const runtime = this._getRuntime(entry.id);
        return entry.enabled && !runtime.disabled && runtime.cooldownUntil > now;
      })
      .map((entry) => this._getRuntime(entry.id).cooldownUntil);
    if (cooldowns.length === 0) return;
    const delay = Math.max(1, Math.min(...cooldowns) - now);
    this.wakeupTimer = this.setTimer(() => {
      this.wakeupTimer = null;
      this._drain();
      this._notify();
    }, delay);
  }

  _getRuntime(keyId) {
    if (!this.runtime.has(keyId)) {
      this.runtime.set(keyId, {
        disabled: false,
        cooldownUntil: 0,
        lastUsedAt: 0,
        lastStatus: "idle",
        lastError: ""
      });
    }
    return this.runtime.get(keyId);
  }

  _isKeyActive(keyId) {
    for (const activeTask of this.active.values()) {
      if (activeTask.key.id === keyId) return true;
    }
    return false;
  }

  _detachAbortListener(request) {
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
  }

  _notify() {
    this.onChange(this.getSnapshot());
  }
}

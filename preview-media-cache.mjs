export function getCarouselWindow(index, length) {
  if (!Number.isInteger(index) || !Number.isInteger(length) || length <= 0 || index < 0 || index >= length) {
    return [];
  }

  const indices = [index];
  if (length > 1) {
    indices.push((index - 1 + length) % length, (index + 1) % length);
  }
  return [...new Set(indices)];
}

export class LazyMediaCache {
  #entries = [];
  #loader;
  #resolved = new Map();
  #pending = new Map();
  #revision = 0;
  #disposed = false;

  constructor(entries, loader) {
    if (typeof loader !== "function") {
      throw new TypeError("LazyMediaCache requires a loader function");
    }
    this.#loader = loader;
    this.#entries = Array.isArray(entries) ? entries : [];
  }

  get size() {
    return this.#entries.length;
  }

  async get(index) {
    if (this.#disposed || !Number.isInteger(index) || index < 0 || index >= this.#entries.length) {
      return null;
    }
    if (this.#resolved.has(index)) {
      return this.#resolved.get(index);
    }
    const existing = this.#pending.get(index);
    if (existing) {
      return existing.promise;
    }

    const controller = new AbortController();
    const revision = this.#revision;
    const request = {
      controller,
      promise: null
    };
    request.promise = Promise.resolve()
      .then(() => this.#loader(this.#entries[index], index, { signal: controller.signal }))
      .then((value) => {
        if (this.#disposed || revision !== this.#revision || controller.signal.aborted) {
          return null;
        }
        if (value != null) {
          this.#resolved.set(index, value);
        }
        return value ?? null;
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.name === "AbortError") {
          return null;
        }
        throw error;
      })
      .finally(() => {
        if (this.#pending.get(index) === request) {
          this.#pending.delete(index);
        }
      });
    this.#pending.set(index, request);
    return request.promise;
  }

  prefetch(indices) {
    return Promise.allSettled((indices || []).map((index) => this.get(index)));
  }

  retain(indices) {
    const retained = new Set(indices || []);
    for (const index of this.#resolved.keys()) {
      if (!retained.has(index)) {
        this.#resolved.delete(index);
      }
    }
    for (const [index, request] of this.#pending.entries()) {
      if (!retained.has(index)) {
        request.controller.abort();
        this.#pending.delete(index);
      }
    }
  }

  replaceEntries(entries) {
    if (this.#disposed) return;
    this.#abortPending();
    this.#revision += 1;
    this.#entries = Array.isArray(entries) ? entries : [];
    this.#resolved.clear();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#revision += 1;
    this.#abortPending();
    this.#entries = [];
    this.#resolved.clear();
  }

  #abortPending() {
    for (const request of this.#pending.values()) {
      request.controller.abort();
    }
    this.#pending.clear();
  }
}

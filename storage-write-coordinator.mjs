export class CoalescedAsyncWriter {
  #write;
  #requestedVersion = 0;
  #settledVersion = 0;
  #scheduled = false;
  #running = null;
  #waiters = [];

  constructor(write) {
    if (typeof write !== "function") {
      throw new TypeError("write 必须是函数");
    }
    this.#write = write;
  }

  request() {
    const version = ++this.#requestedVersion;
    const promise = new Promise((resolve, reject) => {
      this.#waiters.push({ version, resolve, reject });
    });
    this.#schedule();
    return promise;
  }

  get pendingVersion() {
    return this.#requestedVersion;
  }

  get settledVersion() {
    return this.#settledVersion;
  }

  #schedule() {
    if (this.#scheduled || this.#running) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#running || this.#settledVersion >= this.#requestedVersion) {
        return;
      }
      const run = this.#drain();
      this.#running = run;
      run.finally(() => {
        if (this.#running === run) {
          this.#running = null;
        }
        if (this.#settledVersion < this.#requestedVersion) {
          this.#schedule();
        }
      }).catch(() => {});
    });
  }

  async #drain() {
    while (this.#settledVersion < this.#requestedVersion) {
      const targetVersion = this.#requestedVersion;
      try {
        await this.#write({
          targetVersion,
          previousVersion: this.#settledVersion
        });
        this.#settleThrough(targetVersion, null);
      } catch (error) {
        this.#settleThrough(targetVersion, error);
      }
      this.#settledVersion = targetVersion;
    }
  }

  #settleThrough(version, error) {
    const remaining = [];
    for (const waiter of this.#waiters) {
      if (waiter.version <= version) {
        if (error) {
          waiter.reject(error);
        } else {
          waiter.resolve({ version: waiter.version, flushedVersion: version });
        }
      } else {
        remaining.push(waiter);
      }
    }
    this.#waiters = remaining;
  }
}

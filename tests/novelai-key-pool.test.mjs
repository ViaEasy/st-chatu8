import test from "node:test";
import assert from "node:assert/strict";

import {
  migrateLegacyNovelAIKey,
  normalizeNovelAIKeys,
  NovelAIKeyPool
} from "../novelai-key-pool.mjs";

const keys = [
  { id: "a", label: "A", key: "pst-a", enabled: true },
  { id: "b", label: "B", key: "pst-b", enabled: true }
];

test("migrates the legacy key once", () => {
  const result = migrateLegacyNovelAIKey([], "pst-legacy");
  assert.equal(result.migrated, true);
  assert.deepEqual(result.keys, [{ id: "legacy", label: "默认 Key", key: "pst-legacy", enabled: true }]);
  assert.equal(migrateLegacyNovelAIKey(result.keys, "pst-other").migrated, false);
  assert.deepEqual(migrateLegacyNovelAIKey([], "000000").keys, []);
});

test("normalizes invalid and duplicate entries", () => {
  assert.deepEqual(normalizeNovelAIKeys([
    null,
    { id: "same", label: "First", key: " pst-one ", enabled: "true" },
    { id: "same", label: "Second", key: "pst-two", enabled: "false" },
    { id: "duplicate-key", label: "Duplicate", key: "pst-one", enabled: true },
    { id: "empty", label: "Empty", key: "" }
  ]), [
    { id: "same", label: "First", key: "pst-one", enabled: true },
    { id: "same-3", label: "Second", key: "pst-two", enabled: false }
  ]);
});

test("runs one task per key and respects global concurrency", async () => {
  const pool = new NovelAIKeyPool({ keys, maxConcurrency: 2 });
  const first = await pool.acquire("task-1");
  const second = await pool.acquire("task-2");
  assert.notEqual(first.key.id, second.key.id);
  assert.equal(pool.getSnapshot().running, 2);

  let thirdResolved = false;
  const thirdPromise = pool.acquire("task-3").then((lease) => {
    thirdResolved = true;
    return lease;
  });
  await Promise.resolve();
  assert.equal(thirdResolved, false);
  first.release({ status: "success" });
  const third = await thirdPromise;
  assert.equal(third.key.id, first.key.id);

  second.release({ status: "success" });
  third.release({ status: "success" });
  assert.equal(pool.getSnapshot().running, 0);
});

test("cancels a queued task without affecting running work", async () => {
  const pool = new NovelAIKeyPool({ keys: [keys[0]], maxConcurrency: 1 });
  const running = await pool.acquire("running");
  const controller = new AbortController();
  const queued = pool.acquire("queued", { signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, (error) => error.name === "AbortError");
  assert.equal(pool.getSnapshot().running, 1);
  assert.equal(pool.getSnapshot().pending, 0);
  running.release({ status: "success" });
});

test("puts a rate-limited key on cooldown and selects another key", async () => {
  let now = 1_000;
  const pool = new NovelAIKeyPool({ keys, maxConcurrency: 1, cooldownMs: 30_000, now: () => now });
  const first = await pool.acquire("task-1");
  first.release({ status: "rate_limited" });

  const second = await pool.acquire("task-2");
  assert.notEqual(second.key.id, first.key.id);
  const firstState = pool.getSnapshot().keys.find((entry) => entry.id === first.key.id);
  assert.equal(firstState.status, "cooldown");
  second.release({ status: "success" });
  now += 30_001;
  pool.configure({});
  assert.equal(pool.getSnapshot().keys.find((entry) => entry.id === first.key.id).status, "idle");
});

test("disables an invalid key for the current session", async () => {
  const pool = new NovelAIKeyPool({ keys, maxConcurrency: 1 });
  const first = await pool.acquire("task-1");
  first.release({ status: "invalid", error: "401" });
  const second = await pool.acquire("task-2");
  assert.notEqual(second.key.id, first.key.id);
  assert.equal(pool.getSnapshot().keys.find((entry) => entry.id === first.key.id).status, "disabled");
  second.release({ status: "success" });
});

test("rejects queued work when the last usable key becomes invalid", async () => {
  const pool = new NovelAIKeyPool({ keys: [keys[0]], maxConcurrency: 1 });
  const running = await pool.acquire("running");
  const queued = pool.acquire("queued");
  running.release({ status: "invalid", error: "401" });
  await assert.rejects(queued, (error) => error.code === "NO_NOVELAI_KEY");
});

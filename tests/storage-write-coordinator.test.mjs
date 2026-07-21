import assert from "node:assert/strict";
import test from "node:test";

import { CoalescedAsyncWriter } from "../storage-write-coordinator.mjs";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("同一轮并发请求只写入一次", async () => {
  const writes = [];
  const writer = new CoalescedAsyncWriter(async ({ targetVersion }) => {
    writes.push(targetVersion);
  });

  const results = await Promise.all([
    writer.request(),
    writer.request(),
    writer.request()
  ]);

  assert.deepEqual(writes, [3]);
  assert.deepEqual(results.map((result) => result.flushedVersion), [3, 3, 3]);
});

test("写入进行中出现新修改时会追加一次最新快照", async () => {
  const firstWrite = createDeferred();
  const writes = [];
  const writer = new CoalescedAsyncWriter(async ({ targetVersion }) => {
    writes.push(targetVersion);
    if (writes.length === 1) {
      await firstWrite.promise;
    }
  });

  const firstRequest = writer.request();
  await new Promise((resolve) => setImmediate(resolve));
  const secondRequest = writer.request();
  const thirdRequest = writer.request();

  firstWrite.resolve();
  const [first, second, third] = await Promise.all([firstRequest, secondRequest, thirdRequest]);

  assert.deepEqual(writes, [1, 3]);
  assert.equal(first.flushedVersion, 1);
  assert.equal(second.flushedVersion, 3);
  assert.equal(third.flushedVersion, 3);
});

test("一次写入失败只拒绝对应批次，后续请求仍可重试", async () => {
  let attempts = 0;
  const writer = new CoalescedAsyncWriter(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("temporary failure");
    }
  });

  await assert.rejects(writer.request(), /temporary failure/);
  const result = await writer.request();

  assert.equal(attempts, 2);
  assert.equal(result.flushedVersion, 2);
});

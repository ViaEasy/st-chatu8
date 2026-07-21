import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getCarouselWindow, LazyMediaCache } from "../preview-media-cache.mjs";

const indexSource = await readFile(new URL("../index.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `\u627E\u4E0D\u5230\u51FD\u6570 ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`\u51FD\u6570 ${name} \u6CA1\u6709\u5B8C\u6574\u7ED3\u675F`);
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("轮播窗口只包含当前项和相邻项", () => {
  assert.deepEqual(getCarouselWindow(0, 5), [0, 4, 1]);
  assert.deepEqual(getCarouselWindow(0, 2), [0, 1]);
  assert.deepEqual(getCarouselWindow(0, 1), [0]);
  assert.deepEqual(getCarouselWindow(2, 0), []);
});

test("同一媒体的并发加载会复用一个请求", async () => {
  const deferred = createDeferred();
  let loads = 0;
  const cache = new LazyMediaCache(["a"], async () => {
    loads += 1;
    return deferred.promise;
  });

  const first = cache.get(0);
  const second = cache.get(0);
  deferred.resolve("blob-a");

  assert.equal(await first, "blob-a");
  assert.equal(await second, "blob-a");
  assert.equal(await cache.get(0), "blob-a");
  assert.equal(loads, 1);
});

test("大量媒体只会预取当前项和左右邻项", async () => {
  const loadedIndices = [];
  const entries = Array.from({ length: 100 }, (_, index) => index);
  const cache = new LazyMediaCache(entries, async (_entry, index) => {
    loadedIndices.push(index);
    return `blob-${index}`;
  });

  await cache.prefetch(getCarouselWindow(50, entries.length));

  assert.deepEqual(loadedIndices, [50, 49, 51]);
});

test("保留轮播窗口时会释放远端缓存并中止无关请求", async () => {
  const aborted = [];
  const cache = new LazyMediaCache([0, 1, 2, 3], (entry, index, { signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      aborted.push(index);
      resolve(null);
    });
  }));

  const farRequest = cache.get(3);
  await new Promise((resolve) => setImmediate(resolve));
  cache.retain(getCarouselWindow(1, 4));

  assert.equal(await farRequest, null);
  assert.deepEqual(aborted, [3]);
});

test("关闭或替换条目后，迟到结果不会重新进入缓存", async () => {
  const firstDeferred = createDeferred();
  let loads = 0;
  const cache = new LazyMediaCache(["old"], async (entry) => {
    loads += 1;
    if (entry === "old") return firstDeferred.promise;
    return `blob-${entry}`;
  });

  const oldRequest = cache.get(0);
  await new Promise((resolve) => setImmediate(resolve));
  cache.replaceEntries(["new"]);
  firstDeferred.resolve("blob-old");

  assert.equal(await oldRequest, null);
  assert.equal(await cache.get(0), "blob-new");
  cache.dispose();
  assert.equal(await cache.get(0), null);
  assert.equal(loads, 2);
});

test("预览窗口不再一次性读取全部原图", () => {
  const previewSource = extractFunction(indexSource, "showImagePreview");

  assert.match(previewSource, /new LazyMediaCache\(images, loadMediaEntry\)/);
  assert.match(previewSource, /getCarouselWindow\(index, n\)/);
  assert.doesNotMatch(previewSource, /const blobPromises = merged\.images\.map/);
  assert.doesNotMatch(previewSource, /const allBlobs = await Promise\.all/);
});

test("关闭预览会中止请求并释放监听器和对象 URL", () => {
  const cleanupSource = extractFunction(indexSource, "cleanupPreview");

  assert.match(cleanupSource, /thumbnailController\?\.abort\(\)/);
  assert.match(cleanupSource, /mediaCache\.dispose\(\)/);
  assert.match(cleanupSource, /revokeTrackBlobUrls\(\)/);
  assert.match(cleanupSource, /revokeThumbnailBlobUrls\(\)/);
  assert.match(cleanupSource, /removeEventListener\("keydown", keyHandler\)/);
});

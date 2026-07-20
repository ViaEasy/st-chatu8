import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FLOOR_BATCH_COUNT,
  MAX_FLOOR_BATCH_COUNT,
  messageHasImageOrTag,
  normalizeFloorBatchCount,
  runFloorBatch,
  selectSubsequentSameKindMessages
} from "../floor-batch-runner.mjs";

const character = (mes, extra = {}) => ({ mes, is_user: false, ...extra });
const user = (mes) => ({ mes, is_user: true });

test("默认选择后续 3 个同类型楼层并跳过中间用户消息", () => {
  const chat = [character("起点"), user("用户 1"), character("角色 1"), user("用户 2"), character("角色 2"), character("角色 3"), character("角色 4")];
  const selected = selectSubsequentSameKindMessages(chat, 0);
  assert.deepEqual(selected.map((entry) => entry.messageId), [2, 4, 5]);
});

test("数量限制为 1 到 20，非法值回退为 3", () => {
  assert.equal(normalizeFloorBatchCount(0), 1);
  assert.equal(normalizeFloorBatchCount(100), MAX_FLOOR_BATCH_COUNT);
  assert.equal(normalizeFloorBatchCount("invalid"), DEFAULT_FLOOR_BATCH_COUNT);
});

test("能识别当前 swipe 的已有图片和正文 Tag", () => {
  assert.equal(messageHasImageOrTag(character("正文", { swipe_id: 1, extra: { images: { 1: [{ url: "image" }] } } })), true);
  assert.equal(messageHasImageOrTag(character("正文\n<image>tags</image>")), true);
  assert.equal(messageHasImageOrTag(character("正文 [img]tags[/img]"), { startTag: "[img]", endTag: "[/img]" }), true);
  assert.equal(messageHasImageOrTag(character("只有正文")), false);
});

test("串行模式不会同时处理两个楼层", async () => {
  let active = 0;
  let maxActive = 0;
  const result = await runFloorBatch([1, 2, 3], {
    concurrency: 1,
    worker: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { success: true };
    }
  });
  assert.equal(maxActive, 1);
  assert.equal(result.succeeded, 3);
});

test("并行模式最多同时处理两个楼层，单层失败不会中断其他楼层", async () => {
  let active = 0;
  let maxActive = 0;
  const result = await runFloorBatch([1, 2, 3, 4], {
    concurrency: 2,
    worker: async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (item === 2) {
        throw new Error("单层失败");
      }
      return { success: true };
    }
  });
  assert.equal(maxActive, 2);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 1);
});

test("停止后不再领取新的楼层任务", async () => {
  let stopped = false;
  const started = [];
  const result = await runFloorBatch([1, 2, 3, 4], {
    concurrency: 2,
    shouldStop: () => stopped,
    worker: async (item) => {
      started.push(item);
      stopped = true;
      await Promise.resolve();
      return { success: true };
    }
  });
  assert.deepEqual(started, [1]);
  assert.equal(result.stopped, true);
});

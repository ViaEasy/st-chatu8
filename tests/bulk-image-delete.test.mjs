import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMessageImageDeletion,
  createDefaultBulkImageDeleteRange,
  deleteUnlockedImagesFromMessage,
  getBulkImageDeleteLegacyKey,
  getBulkImageDeleteMessagePreview,
  resolveBulkImageDeleteRange,
  runBulkImageDeletion,
  summarizeBulkImageDeletion
} from "../bulk-image-delete.mjs";

const settings = { startTag: "image###", endTag: "###" };

test("批量删除默认选择当前层及向后 30 层", () => {
  assert.deepEqual(createDefaultBulkImageDeleteRange(39, 1000), {
    startFloor: 40,
    endFloor: 69
  });
  assert.deepEqual(createDefaultBulkImageDeleteRange(990, 1000), {
    startFloor: 991,
    endFloor: 1000
  });
});

test("能解析当前层、指定范围和整个聊天", () => {
  assert.deepEqual(
    resolveBulkImageDeleteRange({ scope: "current", currentMessageId: 4, totalMessages: 10 }).messageIds,
    [4]
  );
  assert.deepEqual(
    resolveBulkImageDeleteRange({ scope: "range", startFloor: 3, endFloor: 5, totalMessages: 10 }).messageIds,
    [2, 3, 4]
  );
  assert.deepEqual(
    resolveBulkImageDeleteRange({ scope: "all", totalMessages: 3 }).messageIds,
    [0, 1, 2]
  );
});

test("拒绝越界和倒序范围", () => {
  assert.equal(
    resolveBulkImageDeleteRange({ scope: "range", startFloor: 0, endFloor: 2, totalMessages: 10 }).valid,
    false
  );
  assert.equal(
    resolveBulkImageDeleteRange({ scope: "range", startFloor: 8, endFloor: 3, totalMessages: 10 }).valid,
    false
  );
  assert.equal(
    resolveBulkImageDeleteRange({ scope: "range", startFloor: 1, endFloor: 11, totalMessages: 10 }).valid,
    false
  );
});

test("预览不会重复计算正文 Tag 和 extra.images 中的同一图片", () => {
  const message = {
    mes: "正文\n<image>image###same tag###</image>",
    swipe_id: 0,
    extra: {
      images: {
        0: [
          { tag: "same tag" },
          { tag: "second tag", locked: true }
        ]
      }
    }
  };
  assert.deepEqual(analyzeMessageImageDeletion(message, settings), {
    unlockedCount: 1,
    lockedCount: 1,
    hasImages: true
  });
});

test("兼容 extra.images 和 lockedTags 中已包裹的旧版 Tag", () => {
  const message = {
    mes: "<image>image###legacy tag###</image>",
    swipe_id: 0,
    extra: {
      lockedTags: ["image###legacy tag###"],
      images: {
        0: [{ tag: "image###legacy tag###" }]
      }
    }
  };
  assert.deepEqual(analyzeMessageImageDeletion(message, settings), {
    unlockedCount: 0,
    lockedCount: 1,
    hasImages: true
  });
  const result = deleteUnlockedImagesFromMessage(message, settings);
  assert.equal(result.changed, false);
  assert.match(message.mes, /legacy tag/);

  const malformedMessage = {
    mes: "<image>image###l###</image>",
    extra: { lockedTags: "legacy tag" }
  };
  assert.equal(analyzeMessageImageDeletion(malformedMessage, settings).unlockedCount, 1);
});

test("删除时保留锁定图片和锁定正文 Tag", () => {
  const message = {
    mes: [
      "开头",
      "<image>image###remove me###</image>",
      "<image>image###keep me###</image>",
      "结尾"
    ].join("\n"),
    swipe_id: 0,
    swipes: [
      [
        "开头",
        "<image>image###remove me###</image>",
        "<image>image###keep me###</image>",
        "结尾"
      ].join("\n")
    ],
    extra: {
      lockedTags: ["keep me"],
      images: {
        0: [
          { tag: "remove me", url: "remove" },
          { tag: "keep me", url: "keep" }
        ]
      }
    }
  };

  const result = deleteUnlockedImagesFromMessage(message, settings);
  assert.equal(result.changed, true);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.lockedCount, 1);
  assert.deepEqual(message.extra.images[0].map((image) => image.tag), ["keep me"]);
  assert.doesNotMatch(message.mes, /remove me/);
  assert.match(message.mes, /keep me/);
  assert.equal(message.swipes[0], message.mes);
});

test("删除尚未生成图片的独立正文 Tag", () => {
  const message = {
    mes: "正文 image###pending image### 结束",
    extra: {}
  };
  const result = deleteUnlockedImagesFromMessage(message, settings);
  assert.equal(result.deletedCount, 1);
  assert.equal(message.mes, "正文  结束");
});

test("mes 有 Tag 但当前 swipe 没有时仍能检测并删除", () => {
  const message = {
    mes: "正文 <image>image###mes only###</image> 结束",
    swipe_id: 0,
    swipes: ["正文没有图片 Tag"],
    extra: {}
  };

  assert.deepEqual(analyzeMessageImageDeletion(message, settings), {
    unlockedCount: 1,
    lockedCount: 0,
    hasImages: true
  });

  const result = deleteUnlockedImagesFromMessage(message, settings);
  assert.equal(result.deletedCount, 1);
  assert.doesNotMatch(message.mes, /mes only/);
  assert.equal(message.swipes[0], "正文没有图片 Tag");
});

test("mes 与当前 swipe 的 Tag 会合并统计并跨版本去重", () => {
  const message = {
    mes: [
      "<image>image###mes only###</image>",
      "<image>image###shared###</image>"
    ].join("\n"),
    swipe_id: 0,
    swipes: [
      [
        "<image>image###shared###</image>",
        "<image>image###swipe only###</image>"
      ].join("\n")
    ],
    extra: {}
  };

  assert.deepEqual(analyzeMessageImageDeletion(message, settings), {
    unlockedCount: 3,
    lockedCount: 0,
    hasImages: true
  });

  const result = deleteUnlockedImagesFromMessage(message, settings);
  assert.equal(result.deletedCount, 3);
  assert.doesNotMatch(message.mes, /image###/);
  assert.doesNotMatch(message.swipes[0], /image###/);
});

test("批量预览统计楼层、可删除项和锁定项", () => {
  const chat = [
    { mes: "普通正文" },
    { mes: "<image>image###one###</image>" },
    {
      mes: "<image>image###locked###</image>",
      extra: { lockedTags: ["locked"] }
    }
  ];
  const range = resolveBulkImageDeleteRange({ scope: "all", totalMessages: chat.length });
  assert.deepEqual(summarizeBulkImageDeletion(chat, range, settings), {
    floorCount: 3,
    floorsWithImages: 2,
    affectedFloors: 1,
    unlockedCount: 1,
    lockedCount: 1
  });
});

test("消息预览会移除图片 Tag 并截断长文本", () => {
  const message = {
    mes: "<image>image###prompt###</image><b>第一章</b> " + "正文".repeat(40)
  };
  const preview = getBulkImageDeleteMessagePreview(message, settings, 12);
  assert.equal(preview.startsWith("第一章"), true);
  assert.equal(preview.endsWith("…"), true);
  assert.doesNotMatch(preview, /prompt|<b>/);
});

test("旧 image_groups 键会基于删除图片标记后的正文生成", () => {
  const message = {
    mes: "abcdefghij<image>image###prompt###</image>klmnopqrstuvwxyz"
  };
  assert.equal(getBulkImageDeleteLegacyKey(message, settings), "defghijklmnopqrstuvw");
});

test("停止后不再处理后续楼层，并持续报告进度", async () => {
  const chat = [
    { mes: "<image>one</image>" },
    { mes: "<image>two</image>" },
    { mes: "<image>three</image>" }
  ];
  let stopped = false;
  const progress = [];
  const result = await runBulkImageDeletion(chat, [0, 1, 2], {
    settings,
    shouldStop: () => stopped,
    onProgress: (entry) => {
      progress.push(entry.processed);
      stopped = true;
    },
    yieldEvery: 1,
    yieldControl: async () => {}
  });

  assert.deepEqual(progress, [1]);
  assert.equal(result.processed, 1);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.stopped, true);
  assert.equal(chat[0].mes, "");
  assert.match(chat[1].mes, /two/);
});

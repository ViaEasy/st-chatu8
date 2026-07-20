import test from "node:test";
import assert from "node:assert/strict";

import {
  annotateCharacterCandidates,
  buildCharacterScanChunks,
  findExistingCharacterPreset,
  mergeAliasField,
  mergeCharacterCandidates,
  normalizeCharacterScanCount,
  parseCharacterDiscoveryResponse,
  runCharacterGenerationBatch,
  selectSubsequentCharacterMessages
} from "../character-batch-runner.mjs";

test("默认扫描后续 10 个同类型楼层并跳过用户消息", () => {
  const chat = Array.from({ length: 25 }, (_, index) => ({
    is_user: index % 2 === 1,
    mes: `消息 ${index}`
  }));
  const selected = selectSubsequentCharacterMessages(chat, 0);
  assert.equal(selected.length, 10);
  assert.deepEqual(selected.map((item) => item.messageId), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
});

test("从用户楼层启动时也只扫描后续角色回复", () => {
  const chat = [
    { is_user: true, mes: "起点" },
    { is_user: true, mes: "用户补充" },
    { is_user: false, mes: "角色回复" },
    { is_user: true, mes: "用户继续" },
    { is_user: false, mes: "下一章" }
  ];
  assert.deepEqual(selectSubsequentCharacterMessages(chat, 0, 2).map((item) => item.messageId), [2, 4]);
});

test("扫描数量限制为 1 到 30，非法值回退为 10", () => {
  assert.equal(normalizeCharacterScanCount(0), 1);
  assert.equal(normalizeCharacterScanCount(99), 30);
  assert.equal(normalizeCharacterScanCount("abc"), 10);
});

test("普通长度楼层会按字符预算分组，但不会被拆开", () => {
  const items = [
    { messageId: 1, message: { mes: "a".repeat(800) } },
    { messageId: 2, message: { mes: "b".repeat(800) } },
    { messageId: 3, message: { mes: "c".repeat(800) } }
  ];
  const chunks = buildCharacterScanChunks(items, 1000);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk[0].messageId), [1, 2, 3]);
});

test("单个超长楼层也会安全拆分，避免超过 LLM 上下文", () => {
  const chunks = buildCharacterScanChunks([{ messageId: 7, message: { mes: "长".repeat(2500) } }], 1000);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk[0].messageId), [7, 7, 7]);
  assert.deepEqual(chunks.map((chunk) => chunk[0].partIndex), [0, 1, 2]);
});

test("解析角色扫描结果并合并跨章节别名", () => {
  const first = parseCharacterDiscoveryResponse(`
    <角色>
    中文名称：林夕
    英文名称: Lin Xi
    别名: 小夕|林小姐
    重要程度: 重要配角
    置信度: 高
    依据: #2 首次登场
    </角色>
  `);
  const second = parseCharacterDiscoveryResponse(`
    <character>
    nameCN: 林小姐
    nameEN: Lin Xi
    aliases: 林夕
    importance: 重要配角
    confidence: 高
    evidence: #5 再次出现
    </character>
  `);
  const merged = mergeCharacterCandidates([...first, ...second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].nameCN, "林夕");
  assert.ok(merged[0].aliases.includes("林小姐"));
  assert.match(merged[0].evidence, /#2/);
  assert.match(merged[0].evidence, /#5/);
});

test("跨章节合并时保留更高的重要程度与置信度", () => {
  const merged = mergeCharacterCandidates([
    { nameCN: "林夕", importance: "临时角色", confidence: "低" },
    { nameCN: "林夕", importance: "重要配角", confidence: "高" }
  ]);
  assert.equal(merged[0].importance, "重要配角");
  assert.equal(merged[0].confidence, "高");
});

test("已有角色按中英文名或别名精确跳过，不做包含式误判", () => {
  const presets = {
    "[角色卡]林夕": { nameCN: "林夕|小夕", nameEN: "Lin Xi" },
    "[角色卡]安娜": { nameCN: "安娜", nameEN: "Anna" }
  };
  assert.equal(findExistingCharacterPreset({ nameCN: "小夕" }, presets)?.presetId, "[角色卡]林夕");
  assert.equal(findExistingCharacterPreset({ nameCN: "林" }, presets), null);
});

test("带角色卡前缀的预设只在当前角色卡范围内判重，旧版无前缀预设仍兼容", () => {
  const presets = {
    "[卡A]林夕": { nameCN: "林夕", nameEN: "Lin Xi" },
    "[卡B]安娜": { nameCN: "安娜", nameEN: "Anna" },
    "旧版角色": { nameCN: "苏晴", nameEN: "Su Qing" }
  };
  assert.equal(findExistingCharacterPreset({ nameCN: "林夕" }, presets, "卡B"), null);
  assert.equal(findExistingCharacterPreset({ nameCN: "林夕" }, presets, "卡A")?.presetId, "[卡A]林夕");
  assert.equal(findExistingCharacterPreset({ nameCN: "苏晴" }, presets, "卡B")?.presetId, "旧版角色");
});

test("已有角色禁用勾选，疑似路人默认不勾选，重要角色默认勾选", () => {
  const annotated = annotateCharacterCandidates([
    { nameCN: "林夕", importance: "重要配角", confidence: "高" },
    { nameCN: "店员", importance: "临时角色", confidence: "高" },
    { nameCN: "小夕", importance: "重要配角", confidence: "高" }
  ], {
    "[角色卡]林夕": { nameCN: "林夕|小夕", nameEN: "Lin Xi" }
  });
  assert.equal(annotated[0].selected, false);
  assert.equal(annotated[0].existingMatch?.presetId, "[角色卡]林夕");
  assert.equal(annotated[1].selected, false);
  assert.equal(annotated[1].likelyGeneric, true);
});

test("合并角色名字段时保留现有别名格式并去重", () => {
  assert.equal(mergeAliasField("林夕|小夕", "林小姐", "小夕", "无"), "林夕|小夕|林小姐");
});

test("批量角色生成最多并发 2 个，单个失败不会中断其他角色", async () => {
  let active = 0;
  let maxActive = 0;
  const summary = await runCharacterGenerationBatch(["a", "b", "c", "d"], {
    concurrency: 10,
    worker: async (name) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (name === "b") throw new Error("boom");
      return { success: true };
    }
  });
  assert.equal(maxActive, 2);
  assert.equal(summary.succeeded, 3);
  assert.equal(summary.failed, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { planProcessedImageElement } from "../auto-click-resume.mjs";

function createButton(requestId, { loading = false } = {}) {
  return {
    dataset: { requestId },
    hasAttribute: (name) => name === "data-loading" && loading
  };
}

function createRoot({ text = "正文", storedLength = text.length, buttons = [], mediaIds = [] } = {}) {
  const mediaSet = new Set(mediaIds);
  const spans = buttons.map((button) => ({
    dataset: { requestId: button.dataset.requestId },
    querySelector: () => mediaSet.has(button.dataset.requestId) ? {} : null
  }));
  return {
    dataset: {
      chatu8Processed: "true",
      chatu8ContentLength: String(storedLength)
    },
    textContent: text,
    querySelectorAll: (selector) => selector.startsWith("button") ? buttons : spans
  };
}

test("显式自动点击会接管后台已经渲染但尚未生图的按钮", () => {
  const buttons = [createButton("image-1"), createButton("image-2")];
  const plan = planProcessedImageElement(createRoot({ buttons }), { autoClick: true });

  assert.equal(plan.action, "resume-auto-click");
  assert.deepEqual(plan.buttons, buttons);
});

test("普通后台扫描仍会跳过已处理元素，避免重复生图", () => {
  const plan = planProcessedImageElement(createRoot({ buttons: [createButton("image-1")] }));

  assert.equal(plan.action, "skip");
  assert.deepEqual(plan.buttons, []);
});

test("已有媒体的按钮不会重新生成，仍在加载的按钮会继续等待结果", () => {
  const rendered = createButton("rendered");
  const loading = createButton("loading", { loading: true });
  const plan = planProcessedImageElement(
    createRoot({ buttons: [rendered, loading], mediaIds: ["rendered"] }),
    { autoClick: true }
  );

  assert.equal(plan.action, "resume-auto-click");
  assert.deepEqual(plan.buttons, [loading]);
});

test("正文变化或按钮缺失时会清理标记并重新解析", () => {
  const changed = planProcessedImageElement(createRoot({ storedLength: 1 }), { autoClick: true });
  const missingButtons = planProcessedImageElement(createRoot(), { autoClick: true });

  assert.deepEqual(changed, { action: "process", buttons: [], resetMarkers: true });
  assert.deepEqual(missingButtons, { action: "process", buttons: [], resetMarkers: true });
});

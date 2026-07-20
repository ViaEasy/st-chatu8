import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexSource = await readFile(new URL("../index.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `找不到函数 ${name}`);

  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  assert.fail(`函数 ${name} 没有完整结束`);
}

test("明确目标的自动生图不依赖元素是否位于当前视口", () => {
  const functionSource = extractFunction(indexSource, "processImagePlaceholdersForElement");
  const processedElements = [];
  const processTarget = new Function(
    "isElementVisible",
    "findAndReplaceInElement",
    `return (${functionSource});`
  )(
    () => false,
    (element) => processedElements.push(element)
  );
  const offscreenElement = { id: "offscreen-message" };

  processTarget(offscreenElement);

  assert.deepEqual(processedElements, [offscreenElement]);
});

test("明确目标为空时不会启动图片处理", () => {
  const functionSource = extractFunction(indexSource, "processImagePlaceholdersForElement");
  let processCount = 0;
  const processTarget = new Function(
    "isElementVisible",
    "findAndReplaceInElement",
    `return (${functionSource});`
  )(
    () => true,
    () => {
      processCount += 1;
    }
  );

  processTarget(null);

  assert.equal(processCount, 0);
});

test("明确目标的自动点击参数会原样传给占位符处理器", async () => {
  const functionSource = extractFunction(indexSource, "processImagePlaceholdersForElement");
  let receivedOptions = null;
  const processTarget = new Function(
    "findAndReplaceInElement",
    `return (${functionSource});`
  )((element, imageAlt, options) => {
    receivedOptions = options;
    return Promise.resolve({ element, imageAlt });
  });
  const options = { autoClick: true, autoClickTaskId: "task-1" };

  await processTarget({ id: "target" }, options);

  assert.equal(receivedOptions, options);
});

test("后台全局扫描仍然保留视口过滤", () => {
  const functionSource = extractFunction(indexSource, "processMesTextElements");

  assert.match(functionSource, /isElementVisible\(element, 0\)/);
});

test("等待单张图片生成时能按 requestId 收到完成结果并清理监听器", async () => {
  const functionSource = extractFunction(indexSource, "triggerGenerationWithResult");
  const listeners = new Set();
  const eventSource = {
    on: (_event, listener) => listeners.add(listener),
    removeListener: (_event, listener) => listeners.delete(listener),
    emit: (_event, data) => [...listeners].forEach((listener) => listener(data))
  };
  const waitForGeneration = new Function(
    "eventSource18",
    "EventType",
    "triggerGeneration",
    `return (${functionSource});`
  )(
    eventSource,
    { GENERATE_IMAGE_RESPONSE: "response" },
    (button) => eventSource.emit("response", { id: button.dataset.requestId, success: true })
  );

  const result = await waitForGeneration({ dataset: { requestId: "request-1" } }, 100);

  assert.equal(result.success, true);
  assert.equal(listeners.size, 0);
});

test("图片生成长期无响应时会超时返回，不会永久卡住楼层队列", async () => {
  const functionSource = extractFunction(indexSource, "triggerGenerationWithResult");
  const listeners = new Set();
  const waitForGeneration = new Function(
    "eventSource18",
    "EventType",
    "triggerGeneration",
    `return (${functionSource});`
  )(
    {
      on: (_event, listener) => listeners.add(listener),
      removeListener: (_event, listener) => listeners.delete(listener)
    },
    { GENERATE_IMAGE_RESPONSE: "response" },
    () => {}
  );

  const result = await waitForGeneration({ dataset: { requestId: "request-timeout" } }, 5);

  assert.equal(result.success, false);
  assert.equal(result.error, "generation_timeout");
  assert.equal(listeners.size, 0);
});

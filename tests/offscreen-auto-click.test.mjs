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

test("后台全局扫描仍然保留视口过滤", () => {
  const functionSource = extractFunction(indexSource, "processMesTextElements");

  assert.match(functionSource, /isElementVisible\(element, 0\)/);
});

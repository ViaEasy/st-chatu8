import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  findMessageTextElements,
  IMAGE_HEALTH_CHECK_INTERVAL_MS,
  INTERACTION_HEALTH_CHECK_INTERVAL_MS,
  isFeatureEnabled
} from "../dom-processing-scheduler.mjs";

const indexSource = await readFile(new URL("../index.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `找不到函数 ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`函数 ${name} 没有完整结束`);
}

function createMessage(id, targets) {
  return {
    getAttribute: (name) => name === "mesid" ? String(id) : null,
    matches: () => false,
    querySelectorAll: (selector) => selector === ".mes_text" ? targets : []
  };
}

test("消息事件只选择对应楼层正文", () => {
  const targetA = { id: "target-a" };
  const targetB = { id: "target-b" };
  const root = {
    querySelectorAll: () => [
      createMessage(3, [targetA]),
      createMessage(4, [targetB])
    ]
  };

  assert.deepEqual(findMessageTextElements(root, 4), [targetB]);
  assert.deepEqual(findMessageTextElements(root, 99), []);
});

test("健康检查保留为低频兼容兜底", () => {
  assert.equal(IMAGE_HEALTH_CHECK_INTERVAL_MS, 30_000);
  assert.equal(INTERACTION_HEALTH_CHECK_INTERVAL_MS, 30_000);
});

test("兼容布尔值和旧版字符串开关", () => {
  assert.equal(isFeatureEnabled(true), true);
  assert.equal(isFeatureEnabled("true"), true);
  assert.equal(isFeatureEnabled(false, true), false);
  assert.equal(isFeatureEnabled(undefined, true), true);
});

test("消息渲染、编辑、滑动和历史加载事件会主动触发处理", () => {
  const iframeModule = indexSource.slice(
    indexSource.indexOf('"utils/iframe/index.js"()'),
    indexSource.indexOf("// utils/errorCollector.js")
  );

  assert.match(iframeModule, /USER_MESSAGE_RENDERED/);
  assert.match(iframeModule, /CHARACTER_MESSAGE_RENDERED/);
  assert.match(iframeModule, /MESSAGE_SWIPED/);
  assert.match(iframeModule, /MESSAGE_EDITED/);
  assert.match(iframeModule, /MORE_MESSAGES_LOADED/);
});

test("图片、点击和手势扫描均使用低频健康检查", () => {
  assert.match(indexSource, /setInterval\(runImageHealthCheck, IMAGE_HEALTH_CHECK_INTERVAL_MS\)/);
  assert.match(indexSource, /INTERACTION_HEALTH_CHECK_INTERVAL_MS/);
  assert.doesNotMatch(indexSource, /setInterval\(chenk, 4e3\)/);
  assert.doesNotMatch(indexSource, /setInterval\(scanGestureElements, 3e3\)/);
});

test("点击和手势使用文档级委托，不再遍历每条消息绑定监听器", () => {
  const clickScan = extractFunction(indexSource, "scanClickTriggerElements");
  const gestureScan = extractFunction(indexSource, "scanGestureElements");
  const stopClick = extractFunction(indexSource, "stopClickTriggerMonitor");

  assert.doesNotMatch(clickScan, /getElementsByClassName\("mes_text"\)/);
  assert.doesNotMatch(gestureScan, /getElementsByClassName\("mes_text"\)/);
  assert.match(clickScan, /bindClickTrigger\(mainRoot, document\)/);
  assert.match(stopClick, /unbindClickTrigger/);
});

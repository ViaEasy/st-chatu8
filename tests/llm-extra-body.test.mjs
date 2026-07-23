import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLLMRequestBody,
  formatLLMExtraBodyForEditor,
  parseLLMExtraBody
} from "../llm-extra-body.mjs";

test("空附加参数保持原请求体不变", () => {
  const baseBody = { model: "test-model", messages: [], stream: false };

  assert.deepEqual(buildLLMRequestBody(baseBody, ""), baseBody);
  assert.notEqual(buildLLMRequestBody(baseBody, ""), baseBody);
});

test("直连请求会合并配置独有的附加参数", () => {
  const requestBody = buildLLMRequestBody(
    { model: "test-model", messages: [], stream: false },
    '{"enable_thinking":false,"reasoning":{"effort":"low"}}'
  );

  assert.equal(requestBody.enable_thinking, false);
  assert.deepEqual(requestBody.reasoning, { effort: "low" });
});

test("酒馆代理请求通过 custom_include_body 转发附加参数", () => {
  const requestBody = buildLLMRequestBody(
    {
      chat_completion_source: "custom",
      custom_url: "https://example.test/v1",
      model: "test-model",
      messages: []
    },
    '{"enable_thinking":false}',
    { throughProxy: true }
  );

  assert.equal(requestBody.enable_thinking, undefined);
  assert.deepEqual(JSON.parse(requestBody.custom_include_body), { enable_thinking: false });
});

test("拒绝无效 JSON、数组和覆盖内置请求字段", () => {
  assert.throws(() => parseLLMExtraBody("{"), /不是有效的 JSON/);
  assert.throws(() => parseLLMExtraBody("[]"), /必须是一个 JSON 对象/);
  assert.throws(
    () => parseLLMExtraBody('{"messages":[],"model":"other"}'),
    /不能覆盖内置字段：messages, model/
  );
  assert.throws(() => parseLLMExtraBody('{"__proto__":{"polluted":true}}'), /不能覆盖内置字段/);
});

test("导入的对象格式可以格式化到编辑框", () => {
  assert.equal(
    formatLLMExtraBodyForEditor({ enable_thinking: false }),
    '{\n  "enable_thinking": false\n}'
  );
  assert.equal(formatLLMExtraBodyForEditor('{"enable_thinking":false}'), '{"enable_thinking":false}');
});

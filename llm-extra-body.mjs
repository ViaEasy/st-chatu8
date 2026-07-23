export const LLM_EXTRA_BODY_RESERVED_KEYS = Object.freeze([
  "chat_completion_source",
  "custom_url",
  "custom_include_headers",
  "custom_include_body",
  "custom_exclude_body",
  "__proto__",
  "prototype",
  "constructor",
  "model",
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "stream"
]);

const reservedKeySet = new Set(LLM_EXTRA_BODY_RESERVED_KEYS);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 解析并校验单个 LLM 配置的附加请求体参数。
 */
export function parseLLMExtraBody(value) {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  let parsed = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`附加请求体不是有效的 JSON：${error.message}`);
    }
  }

  if (!isPlainObject(parsed)) {
    throw new Error("附加请求体必须是一个 JSON 对象，例如 {\"enable_thinking\": false}");
  }

  const reservedKeys = Object.keys(parsed).filter((key) => reservedKeySet.has(key));
  if (reservedKeys.length > 0) {
    throw new Error(`附加请求体不能覆盖内置字段：${reservedKeys.join(", ")}`);
  }

  return { ...parsed };
}

/**
 * 让导入的对象格式和当前保存的字符串格式都能在编辑框中正常显示。
 */
export function formatLLMExtraBodyForEditor(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (isPlainObject(value)) {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}

/**
 * 直连时把附加参数合并到请求体；走酒馆代理时通过 custom_include_body 转发。
 */
export function buildLLMRequestBody(baseBody, extraBody, { throughProxy = false } = {}) {
  const parsedExtraBody = parseLLMExtraBody(extraBody);
  if (Object.keys(parsedExtraBody).length === 0) {
    return { ...baseBody };
  }

  if (throughProxy) {
    return {
      ...baseBody,
      custom_include_body: JSON.stringify(parsedExtraBody)
    };
  }

  return {
    ...baseBody,
    ...parsedExtraBody
  };
}

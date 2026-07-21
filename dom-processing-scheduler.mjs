export const IMAGE_HEALTH_CHECK_INTERVAL_MS = 30_000;
export const INTERACTION_HEALTH_CHECK_INTERVAL_MS = 30_000;

export function findMessageTextElements(root, messageId) {
  if (!root || messageId === null || messageId === undefined) {
    return [];
  }
  const expectedId = String(messageId);
  const messages = root.querySelectorAll?.(".mes[mesid]") || [];
  const targets = [];
  for (const message of messages) {
    if (message.getAttribute?.("mesid") !== expectedId) {
      continue;
    }
    if (message.matches?.(".mes_text")) {
      targets.push(message);
      continue;
    }
    targets.push(...(message.querySelectorAll?.(".mes_text") || []));
  }
  return targets;
}

export function isFeatureEnabled(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return value === true || value === "true";
}

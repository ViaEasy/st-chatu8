function hasRenderedMedia(rootElement, button) {
  const requestId = button?.dataset?.requestId;
  if (!requestId || typeof rootElement?.querySelectorAll !== "function") {
    return false;
  }

  const spans = Array.from(rootElement.querySelectorAll("span[data-request-id]"));
  const targetSpan = spans.find((span) => span?.dataset?.requestId === requestId);
  return Boolean(targetSpan?.querySelector?.("img, video, .st-chatu8-video-fallback"));
}

/**
 * 决定已被后台占位符扫描处理过的消息，是否仍需由显式自动点击流程接管。
 */
export function planProcessedImageElement(rootElement, { autoClick = false } = {}) {
  if (!rootElement?.dataset || rootElement.dataset.chatu8Processed !== "true") {
    return { action: "process", buttons: [], resetMarkers: false };
  }

  const currentLength = rootElement.textContent?.length || 0;
  const storedLength = Number.parseInt(rootElement.dataset.chatu8ContentLength || "0", 10);
  if (currentLength !== storedLength) {
    return { action: "process", buttons: [], resetMarkers: true };
  }

  const buttons = typeof rootElement.querySelectorAll === "function"
    ? Array.from(rootElement.querySelectorAll("button.image-tag-button"))
    : [];
  if (buttons.length === 0) {
    return { action: "process", buttons: [], resetMarkers: true };
  }

  if (!autoClick) {
    return { action: "skip", buttons: [], resetMarkers: false };
  }

  const unresolvedButtons = buttons.filter((button) => !hasRenderedMedia(rootElement, button));
  return unresolvedButtons.length > 0
    ? { action: "resume-auto-click", buttons: unresolvedButtons, resetMarkers: false }
    : { action: "skip", buttons: [], resetMarkers: false };
}

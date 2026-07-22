import { getMessageKind, runFloorBatch } from "./floor-batch-runner.mjs";

export const DEFAULT_CHARACTER_SCAN_COUNT = 10;
export const MAX_CHARACTER_SCAN_COUNT = 30;
export const MAX_CHARACTER_GENERATION_CONCURRENCY = 2;

const GENERIC_CHARACTER_PATTERN = /^(?:年(?:轻|长)|中年|老年|男|女|小|老)?(?:路人|行人|群众|客人|顾客|店员|服务员|侍者|守卫|卫兵|士兵|保安|司机|医生|护士|老师|学生|同学|警察|记者|工作人员|主持人|裁判|老板|摊主|佣人|仆人|随从|手下|村民|居民|观众)(?:甲|乙|丙|丁|\d+)?$/;
const EMPTY_NAME_MARKERS = new Set(["无", "未知", "未提供", "没有", "none", "unknown", "n/a", "null"]);

export function normalizeCharacterScanCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHARACTER_SCAN_COUNT;
  }
  return Math.min(MAX_CHARACTER_SCAN_COUNT, Math.max(1, parsed));
}

export function selectCharacterMessagesFromCurrent(chat, startMessageId, count = DEFAULT_CHARACTER_SCAN_COUNT) {
  if (!Array.isArray(chat)) {
    return [];
  }
  const normalizedStartId = Number.parseInt(startMessageId, 10);
  if (!Number.isInteger(normalizedStartId) || normalizedStartId < 0 || normalizedStartId >= chat.length) {
    return [];
  }

  if (getMessageKind(chat[normalizedStartId]) === "unknown") {
    return [];
  }

  const limit = normalizeCharacterScanCount(count);
  const selected = [];
  for (let messageId = normalizedStartId; messageId < chat.length && selected.length < limit; messageId += 1) {
    const message = chat[messageId];
    if (getMessageKind(message) === "character") {
      selected.push({ messageId, message });
    }
  }
  return selected;
}

export function buildCharacterScanChunks(items, maxCharacters = 18000) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const limit = Math.max(1000, Number.parseInt(maxCharacters, 10) || 18000);
  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const item of items) {
    const text = typeof item?.message?.mes === "string" ? item.message.mes : "";
    const payloadLimit = Math.max(1, limit - 32);
    const parts = text.length > payloadLimit ? Array.from({ length: Math.ceil(text.length / payloadLimit) }, (_, index) => text.slice(index * payloadLimit, (index + 1) * payloadLimit)) : [text];
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      const entry = { ...item, text: part, partIndex, partCount: parts.length };
      const entryLength = part.length + 32;
      if (current.length > 0 && currentLength + entryLength > limit) {
        chunks.push(current);
        current = [];
        currentLength = 0;
      }
      current.push(entry);
      currentLength += entryLength;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function normalizeCharacterName(name) {
  if (typeof name !== "string") {
    return "";
  }
  return name.normalize("NFKC").toLowerCase().replace(/[‘’`´]/g, "'").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

export function splitCharacterAliases(value) {
  if (typeof value !== "string") {
    return [];
  }
  const seen = new Set();
  return value.split(/[|｜,，、;/；]+/).map((name) => name.trim()).filter((name) => {
    const normalized = normalizeCharacterName(name);
    if (!normalized || EMPTY_NAME_MARKERS.has(normalized) || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function getField(content, labels) {
  for (const line of content.split(/\r?\n/)) {
    const colonIndex = line.search(/[:：]/);
    if (colonIndex < 0) continue;
    const label = line.slice(0, colonIndex).trim().toLowerCase();
    if (labels.some((candidate) => label === candidate.toLowerCase())) {
      return line.slice(colonIndex + 1).trim();
    }
  }
  return "";
}

function uniqueNames(values) {
  const result = [];
  const seen = new Set();
  for (const value of values.flatMap((item) => splitCharacterAliases(item))) {
    const normalized = normalizeCharacterName(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

export function parseCharacterDiscoveryResponse(responseText) {
  if (typeof responseText !== "string" || responseText.trim() === "") {
    return [];
  }
  const candidates = [];
  const blockRegex = /<(?:角色|人物|character)>([\s\S]*?)<\/(?:角色|人物|character)>/gi;
  let match;
  while ((match = blockRegex.exec(responseText)) !== null) {
    const content = match[1];
    const nameCN = splitCharacterAliases(getField(content, ["中文名称", "中文名", "namecn"]))[0] || "";
    const nameEN = splitCharacterAliases(getField(content, ["英文名称", "英文名", "nameen"]))[0] || "";
    if (!nameCN && !nameEN) continue;
    candidates.push({
      nameCN: nameCN || nameEN,
      nameEN,
      aliases: splitCharacterAliases(getField(content, ["别名", "aliases", "alias"])),
      importance: getField(content, ["重要程度", "重要性", "importance"]),
      confidence: getField(content, ["置信度", "confidence"]),
      evidence: getField(content, ["依据", "证据", "evidence"])
    });
  }
  return mergeCharacterCandidates(candidates);
}

function getCandidateNames(candidate) {
  return uniqueNames([candidate?.nameCN || "", candidate?.nameEN || "", ...(candidate?.aliases || [])]);
}

function mergeTextValues(left, right) {
  const values = [];
  const seen = new Set();
  for (const value of [left, right]) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    const normalized = normalizeCharacterName(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(trimmed);
  }
  return values.join("；");
}

function chooseRankedValue(left, right, ranks) {
  const getRank = (value) => {
    const normalized = `${value || ""}`.toLowerCase();
    const matched = ranks.find(([pattern]) => pattern.test(normalized));
    return matched?.[1] || 0;
  };
  return getRank(right) > getRank(left) ? right : left || right || "";
}

function chooseImportance(left, right) {
  return chooseRankedValue(left, right, [
    [/核心|主角|core|main/, 4],
    [/重要|major/, 3],
    [/一般|普通|support/, 2],
    [/临时|路人|背景|extra|minor|background/, 1]
  ]);
}

function chooseConfidence(left, right) {
  return chooseRankedValue(left, right, [[/高|high/, 3], [/中|medium/, 2], [/低|low/, 1]]);
}

export function mergeCharacterCandidates(candidates) {
  const merged = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const names = getCandidateNames(candidate);
    if (names.length === 0) continue;
    const normalizedNames = new Set(names.map(normalizeCharacterName));
    const existing = merged.find((item) => getCandidateNames(item).some((name) => normalizedNames.has(normalizeCharacterName(name))));
    if (!existing) {
      merged.push({
        nameCN: candidate.nameCN || candidate.nameEN || "",
        nameEN: candidate.nameEN || "",
        aliases: uniqueNames(candidate.aliases || []),
        importance: candidate.importance || "",
        confidence: candidate.confidence || "",
        evidence: candidate.evidence || ""
      });
      continue;
    }

    const combinedNames = uniqueNames([...getCandidateNames(existing), ...names]);
    existing.nameCN = existing.nameCN || candidate.nameCN || candidate.nameEN || "";
    existing.nameEN = existing.nameEN || candidate.nameEN || "";
    const primaryNames = new Set([normalizeCharacterName(existing.nameCN), normalizeCharacterName(existing.nameEN)].filter(Boolean));
    existing.aliases = combinedNames.filter((name) => !primaryNames.has(normalizeCharacterName(name)));
    existing.importance = chooseImportance(existing.importance, candidate.importance);
    existing.confidence = chooseConfidence(existing.confidence, candidate.confidence);
    existing.evidence = mergeTextValues(existing.evidence, candidate.evidence);
  }
  return merged;
}

function stripCardPrefix(presetId) {
  return typeof presetId === "string" ? presetId.replace(/^\[[^\]]+\]/, "").trim() : "";
}

function presetIsInCardScope(presetId, cardName) {
  if (!cardName || typeof presetId !== "string") {
    return true;
  }
  const prefixMatch = presetId.match(/^\[([^\]]+)\]/);
  return !prefixMatch || normalizeCharacterName(prefixMatch[1]) === normalizeCharacterName(cardName);
}

export function findExistingCharacterPreset(candidate, characterPresets = {}, cardName = "") {
  const candidateNames = new Set(getCandidateNames(candidate).map(normalizeCharacterName).filter(Boolean));
  if (candidateNames.size === 0) {
    return null;
  }
  for (const [presetId, preset] of Object.entries(characterPresets || {})) {
    if (!presetIsInCardScope(presetId, cardName)) continue;
    const presetNames = uniqueNames([stripCardPrefix(presetId), preset?.nameCN || "", preset?.nameEN || ""]);
    const matchedName = presetNames.find((name) => candidateNames.has(normalizeCharacterName(name)));
    if (matchedName) {
      return { presetId, matchedName };
    }
  }
  return null;
}

export function isLikelyGenericCharacter(candidate) {
  const primaryName = (candidate?.nameCN || candidate?.nameEN || "").trim();
  return GENERIC_CHARACTER_PATTERN.test(primaryName);
}

export function shouldSelectCharacterByDefault(candidate) {
  const importance = `${candidate?.importance || ""}`.toLowerCase();
  const confidence = `${candidate?.confidence || ""}`.toLowerCase();
  if (/主角|核心|重要|main|major|core/.test(importance)) {
    return true;
  }
  if (/路人|背景|临时|龙套|extra|background|minor/.test(importance)) {
    return false;
  }
  if (/低|low/.test(confidence) || isLikelyGenericCharacter(candidate)) {
    return false;
  }
  return true;
}

export function annotateCharacterCandidates(candidates, characterPresets = {}, cardName = "") {
  return mergeCharacterCandidates(candidates).map((candidate, index) => {
    const existingMatch = findExistingCharacterPreset(candidate, characterPresets, cardName);
    return {
      ...candidate,
      id: `candidate-${index}`,
      existingMatch,
      selected: !existingMatch && shouldSelectCharacterByDefault(candidate),
      likelyGeneric: isLikelyGenericCharacter(candidate)
    };
  });
}

export function mergeAliasField(...values) {
  return uniqueNames(values).join("|");
}

export async function runCharacterGenerationBatch(items, options = {}) {
  return runFloorBatch(items, {
    ...options,
    concurrency: Math.min(MAX_CHARACTER_GENERATION_CONCURRENCY, Math.max(1, Number.parseInt(options.concurrency, 10) || MAX_CHARACTER_GENERATION_CONCURRENCY))
  });
}

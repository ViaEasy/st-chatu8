const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);

function normalizeCount(value, maximum = Number.POSITIVE_INFINITY) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return 0;
  return Math.min(maximum, Math.max(0, number));
}

export function normalizeFloorBatchProgress(task = {}) {
  const source = task.progress && typeof task.progress === "object" ? task.progress : {};
  const total = normalizeCount(source.total);
  const completed = normalizeCount(source.completed, total);
  const submitted = Math.max(completed, normalizeCount(source.submitted, total));
  const succeeded = normalizeCount(source.succeeded, completed);
  const failed = normalizeCount(source.failed, completed);
  const skipped = normalizeCount(source.skipped, completed);
  const failedMessageIds = Array.isArray(source.failedMessageIds)
    ? [...new Set(source.failedMessageIds
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value >= 0))].sort((a, b) => a - b)
    : [];
  return {
    mode: ["serial", "parallel", "pipeline"].includes(source.mode) ? source.mode : "serial",
    total,
    submitted,
    completed,
    succeeded,
    failed,
    skipped,
    pending: Math.max(0, total - submitted),
    inFlight: Math.max(0, submitted - completed),
    failedMessageIds,
    percent: total > 0 ? Math.min(100, Math.round(completed / total * 100)) : 0
  };
}

export function getFloorBatchModeLabel(mode) {
  if (mode === "pipeline") return "流水线";
  if (mode === "parallel") return "并行";
  return "串行";
}

export function getFloorBatchStatusLabel(task = {}) {
  const progress = normalizeFloorBatchProgress(task);
  if (task.status === "failed" && progress.failed > 0 && progress.failed < progress.completed) {
    return "部分失败";
  }
  const labels = {
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    cancelled: "已取消",
    failed: "失败"
  };
  return labels[task.status] || task.status || "未知";
}

export function getTaskHistoryIdsToRemove(tasks, maxHistory = 50) {
  const source = Array.isArray(tasks) ? tasks : [];
  const limit = Math.max(0, Number.parseInt(maxHistory, 10) || 0);
  const overflow = Math.max(0, source.length - limit);
  if (overflow === 0) return [];

  return source
    .filter((task) => task && !ACTIVE_TASK_STATUSES.has(task.status))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(0, overflow)
    .map((task) => task.id)
    .filter(Boolean);
}

export function partitionTaskManagerTasks(tasks, floorBatchType = "floor_batch") {
  const source = Array.isArray(tasks) ? tasks : [];
  const floorBatchTasks = source.filter((task) => task?.type === floorBatchType).sort((a, b) => {
    const activeDifference = Number(ACTIVE_TASK_STATUSES.has(b?.status)) - Number(ACTIVE_TASK_STATUSES.has(a?.status));
    return activeDifference || (b?.createdAt || 0) - (a?.createdAt || 0);
  });
  return {
    floorBatchTasks,
    regularTasks: source.filter((task) => task?.type !== floorBatchType)
  };
}

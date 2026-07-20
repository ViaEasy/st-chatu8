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
  return {
    mode: ["serial", "parallel", "pipeline"].includes(source.mode) ? source.mode : "serial",
    total,
    submitted,
    completed,
    succeeded,
    failed,
    skipped,
    inFlight: Math.max(0, submitted - completed),
    percent: total > 0 ? Math.min(100, Math.round(completed / total * 100)) : 0
  };
}

export function getFloorBatchModeLabel(mode) {
  if (mode === "pipeline") return "流水线";
  if (mode === "parallel") return "并行";
  return "串行";
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

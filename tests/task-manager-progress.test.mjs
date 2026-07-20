import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getFloorBatchModeLabel,
  normalizeFloorBatchProgress,
  partitionTaskManagerTasks
} from "../task-manager-progress.mjs";

const indexSource = await readFile(new URL("../index.js", import.meta.url), "utf8");
const taskManagerCss = await readFile(new URL("../styles/main.css", import.meta.url), "utf8");

test("批量进度区分已提交、已完成和生图中楼层", () => {
  const progress = normalizeFloorBatchProgress({
    progress: {
      mode: "pipeline",
      total: 10,
      submitted: 8,
      completed: 6,
      succeeded: 5,
      failed: 1,
      skipped: 0
    }
  });

  assert.deepEqual(progress, {
    mode: "pipeline",
    total: 10,
    submitted: 8,
    completed: 6,
    succeeded: 5,
    failed: 1,
    skipped: 0,
    inFlight: 2,
    percent: 60
  });
});

test("非法批量进度会被限制在安全范围", () => {
  const progress = normalizeFloorBatchProgress({
    progress: { mode: "unknown", total: 3, submitted: 9, completed: -1, succeeded: 6 }
  });

  assert.equal(progress.mode, "serial");
  assert.equal(progress.submitted, 3);
  assert.equal(progress.completed, 0);
  assert.equal(progress.succeeded, 0);
  assert.equal(progress.percent, 0);
});

test("批量父任务置顶，单图任务保留原列表", () => {
  const tasks = [
    { id: "image", type: "novelai", status: "running", createdAt: 30 },
    { id: "old-batch", type: "floor_batch", status: "completed", createdAt: 20 },
    { id: "active-batch", type: "floor_batch", status: "running", createdAt: 10 }
  ];
  const partitioned = partitionTaskManagerTasks(tasks);

  assert.deepEqual(partitioned.floorBatchTasks.map((task) => task.id), ["active-batch", "old-batch"]);
  assert.deepEqual(partitioned.regularTasks.map((task) => task.id), ["image"]);
});

test("批量模式使用用户可读名称", () => {
  assert.equal(getFloorBatchModeLabel("pipeline"), "流水线");
  assert.equal(getFloorBatchModeLabel("parallel"), "并行");
  assert.equal(getFloorBatchModeLabel("serial"), "串行");
});

test("任务队列会保存结构化批量进度，而不是依赖解析任务文案", () => {
  assert.match(indexSource, /progress: task\.progress && typeof task\.progress === "object"/);
  assert.match(indexSource, /task\.progress = \{ \.\.\.\(task\.progress \|\| \{\}\), \.\.\.details\.progress \}/);
  assert.match(indexSource, /type: TaskType\.FLOOR_BATCH,[\s\S]*?progress: \{[\s\S]*?mode: config\.mode/);
});

test("批量进度卡提供一键停止并复用统一取消接口", () => {
  assert.match(indexSource, /class="floor-batch-stop-btn"/);
  assert.match(indexSource, /querySelectorAll\("\.floor-batch-stop-btn"\)[\s\S]{0,500}handleCancelTask\(taskId\)/);
  assert.match(taskManagerCss, /\.floor-batch-progress-track/);
  assert.match(taskManagerCss, /\.floor-batch-stop-btn/);
});

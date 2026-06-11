#!/usr/bin/env node

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const monitorRoot = join(repoRoot, ".codex-monitor");
const jobsDir = join(monitorRoot, "jobs");
const responsesDir = join(monitorRoot, "app-server-responses");
const codexStateDb = join(homedir(), ".codex", "state_5.sqlite");
const recentCompletedHours = 2;
const archiveDefaultHours = 24;
const threadTitleAliases = new Map([
  ["019ea504-df7d-7a90-a666-701ce37eaef5", "评估旅行规划agent表现"],
]);

function usage() {
  console.log(`Usage:
  node bin/codex_monitor_dashboard.mjs [options]

Options:
  --host <host>       default: 127.0.0.1
  --port <port>       default: 17888
  --root <path>       optional monitor package root; default: current package
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function safeReadText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function tailText(path, lines = 80, maxChars = 30000) {
  const text = safeReadText(path);
  if (!text) {
    return "";
  }
  return text.slice(-maxChars).trimEnd().split("\n").slice(-lines).join("\n");
}

function listFiles(path, predicate = () => true) {
  try {
    return readdirSync(path)
      .filter((name) => !name.startsWith("._"))
      .filter(predicate)
      .map((name) => join(path, name))
      .sort();
  } catch {
    return [];
  }
}

function localPidRunning(pid) {
  if (!pid) {
    return false;
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() !== "";
}

function readJsonLines(path) {
  return safeReadText(path)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseProgress(processLines = "") {
  const pattern = /^(\d+):Process \[(\d+)\/(\d+)\], Success \[(\d+)\/(\d+)\]:/gm;
  const entries = [];
  let match;
  while ((match = pattern.exec(processLines)) !== null) {
    entries.push({
      line: Number(match[1]),
      index: Number(match[2]),
      total: Number(match[3]),
      success: Number(match[4]),
      evaluated: Number(match[5]),
      raw: match[0],
    });
  }
  return entries;
}

function hasContextError(record) {
  const text = JSON.stringify(record || {});
  return text.includes("contextWindowExceeded");
}

function classifyDelivery(record) {
  if (!record) {
    return null;
  }
  if (record.delivered === false || record.error || record.errorCode) {
    return {
      state: "failed",
      label: "通知失败",
      tone: "bad",
      reason: record.errorCode || record.error || "通知失败",
    };
  }
  if (hasContextError(record)) {
    return {
      state: "failed",
      label: "通知失败",
      tone: "bad",
      reason: "Codex 上下文已满",
    };
  }
  if (typeof record.agentText === "string" && record.agentText.trim() === "") {
    return {
      state: "failed",
      label: "通知失败",
      tone: "bad",
      reason: "Codex 没有返回有效回复",
    };
  }
  return {
    state: "delivered",
    label: "通知成功",
    tone: "good",
    reason: "",
  };
}

function loadDeliveryRecords(root) {
  const responseRoot = join(root, ".codex-monitor", "app-server-responses");
  const responseFiles = listFiles(responseRoot, (name) => name.endsWith(".json"));
  const failureFiles = responseFiles.filter((path) => path.endsWith(".failed.json"));
  const records = [];

  for (const path of responseFiles) {
    const record = safeReadJson(path);
    if (!record?.event?.jobId) {
      continue;
    }
    records.push({
      ...record,
      deliveryFile: path,
      deliveryKind: path.endsWith(".failed.json") ? "failure" : "response",
    });
  }

  for (const record of readJsonLines(join(root, ".codex-monitor", "app-server-failures.jsonl"))) {
    if (!record?.event?.jobId) {
      continue;
    }
    records.push({
      ...record,
      deliveryKind: "failure",
    });
  }

  for (const path of failureFiles) {
    const record = safeReadJson(path);
    if (!record?.event?.jobId) {
      continue;
    }
    records.push({
      ...record,
      deliveryFile: path,
      deliveryKind: "failure",
    });
  }

  return records.sort((a, b) => {
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
}

function sqliteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function loadThreadMetadata(threadIds) {
  const ids = [...new Set(threadIds.filter(Boolean))];
  if (!ids.length || !existsSync(codexStateDb)) {
    return new Map();
  }

  const query = [
    "select id, title, rollout_path as rolloutPath",
    "from threads",
    `where id in (${ids.map(sqliteLiteral).join(",")})`,
  ].join(" ");
  const result = spawnSync("sqlite3", ["-json", codexStateDb, query], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    return new Map();
  }

  try {
    return new Map(JSON.parse(result.stdout).map((row) => [row.id, row]));
  } catch {
    return new Map();
  }
}

function eventLabel(type) {
  const labels = {
    progress: "进度通知",
    done: "完成通知",
    oom: "显存警报",
  };
  return labels[type] || `${type} 事件`;
}

function latestByType(records) {
  const map = new Map();
  for (const record of records) {
    map.set(record.type || record.event?.type || "event", record);
  }
  return map;
}

function deliveryForEvent(deliveryRecords, jobId, eventType) {
  const candidates = deliveryRecords.filter((record) => {
    return record.event?.jobId === jobId && record.event?.type === eventType;
  });
  return candidates.at(-1) || null;
}

function expectedEventTypes(job, eventsByType) {
  const types = new Set(["done"]);
  for (const rule of job.rules || []) {
    if (rule?.type) {
      types.add(rule.type);
    }
  }
  for (const type of eventsByType.keys()) {
    types.add(type);
  }
  return [...types];
}

function hasAppServerBridge(job) {
  return String(job.onEventCommand || "").includes("codex_app_server_event_bridge");
}

function secondsSince(iso) {
  if (!iso) {
    return null;
  }
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - time) / 1000));
}

function timeMs(iso) {
  if (!iso) {
    return null;
  }
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

function lastActivityMs(job) {
  return timeMs(job.lastEventAt) || timeMs(job.lastPollAt) || timeMs(job.createdAt) || 0;
}

function compactText(value, maxLength = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactThreadTitle(threadId, rawTitle) {
  if (threadTitleAliases.has(threadId)) {
    return threadTitleAliases.get(threadId);
  }
  const title = String(rawTitle || "").replace(/\s+/g, " ").trim();
  if (!title) {
    return threadId ? `会话 ${String(threadId).slice(0, 8)}` : "未知会话";
  }
  if (title.length <= 22) {
    return title;
  }
  const firstSentence = title.split(/[。！？!?]/)[0]?.trim();
  if (firstSentence && firstSentence.length <= 22) {
    return firstSentence;
  }
  if (title.includes("旅行规划")) {
    return "旅行规划 agent 评估";
  }
  return compactText(title, 22);
}

function statusForJob({ job, state, daemonRunning, eventStatuses }) {
  const done = eventStatuses.find((event) => event.type === "done");
  const lastPollAge = secondsSince(state.lastPollAt);
  const staleAfter = Number(job.intervalSec || 30) * 3 + 90;

  if (state.cancelled) {
    return {
      label: "监控已取消",
      tone: "muted",
      detail: "本地监控已经被取消，不会再触发新的提醒。",
    };
  }

  if (done?.triggered) {
    if (done.delivery?.state === "delivered") {
      return {
        label: "已完成，通知成功",
        tone: "good",
        detail: "远端任务已结束，Codex 已接收通知。",
      };
    }
    if (done.delivery?.state === "failed") {
      return {
        label: "已完成，通知失败",
        tone: "bad",
        detail: done.delivery.reason || "远端任务已结束，但 Codex 没有成功接收通知。",
      };
    }
    if (hasAppServerBridge(job)) {
      return {
        label: "已完成，通知中",
        tone: "warn",
        detail: "远端任务已结束，正在等待通知结果。",
      };
    }
    return {
      label: "已完成",
      tone: "muted",
      detail: "远端任务已结束。",
    };
  }

  if (daemonRunning) {
    if (lastPollAge != null && lastPollAge > staleAfter) {
      return {
        label: "监控进程存在，但轮询停滞",
        tone: "warn",
        detail: "本地 daemon 仍在，但最后一次轮询时间偏久，建议查看 daemon 日志。",
      };
    }
    return {
      label: "运行中",
      tone: "good",
      detail: "本地 daemon 正在轮询远端 PID 和日志。",
    };
  }

  if (state.lastPollAt) {
    return {
      label: "监控进程已停止，远端任务状态未知",
      tone: "bad",
      detail: "没有看到完成事件，本地 daemon 也不在运行。远端任务可能仍在运行，也可能已经结束但没有触发提醒。",
    };
  }

  return {
    label: "已创建，尚未开始轮询",
    tone: "warn",
    detail: "监控任务文件已经存在，但还没有轮询记录。",
  };
}

function summarizeJob(jobFile, deliveryRecords, threadMetadata) {
  const job = safeReadJson(jobFile);
  if (!job?.id) {
    return null;
  }
  const state = safeReadJson(job.stateFile) || {
    cancelled: false,
    polls: 0,
    triggered: {},
  };
  const daemonRunning = localPidRunning(job.daemonPid);
  const events = readJsonLines(job.eventLog);
  const eventsByType = latestByType(events);
  const eventStatuses = expectedEventTypes(job, eventsByType).map((type) => {
    const event = eventsByType.get(type) || null;
    const deliveryRecord = deliveryForEvent(deliveryRecords, job.id, type);
    const thread = deliveryRecord?.threadId ? threadMetadata.get(deliveryRecord.threadId) : null;
    return {
      type,
      label: eventLabel(type),
      triggered: Boolean(event || state.triggered?.[type]),
      eventAt: event?.timestamp || null,
      message: event?.message || "",
      delivery: classifyDelivery(deliveryRecord),
      deliveryAt: deliveryRecord?.createdAt || null,
      deliveryFile: deliveryRecord?.deliveryFile || null,
      threadId: deliveryRecord?.threadId || null,
      threadTitle: compactThreadTitle(deliveryRecord?.threadId, deliveryRecord?.threadTitle || thread?.title || null),
      threadPath: deliveryRecord?.threadPath || thread?.rolloutPath || null,
      turnId: deliveryRecord?.turnId || null,
      promptLength: deliveryRecord?.promptLength || null,
    };
  });
  const latestEvent = events.at(-1) || null;
  const progressEntries = [
    ...parseProgress(latestEvent?.processLines || ""),
    ...parseProgress(eventsByType.get("progress")?.processLines || ""),
  ];
  const progress = progressEntries.at(-1) || null;
  const status = statusForJob({ job, state, daemonRunning, eventStatuses });

  return {
    id: job.id,
    name: job.name || job.id,
    host: job.host,
    remotePid: job.pid,
    daemonPid: job.daemonPid || null,
    daemonRunning,
    remoteDir: job.remoteDir,
    remoteLog: job.remoteLog,
    remoteEventLog: job.remoteEventLog || job.remoteLog,
    intervalSec: job.intervalSec,
    polls: state.polls || 0,
    cancelled: Boolean(state.cancelled),
    createdAt: state.createdAt || null,
    lastPollAt: state.lastPollAt || null,
    lastEventAt: state.lastEventAt || null,
    lastPollAgeSec: secondsSince(state.lastPollAt),
    status,
    progress,
    events: eventStatuses,
    latestEvent,
    paths: {
      jobFile,
      stateFile: job.stateFile,
      daemonLog: job.daemonLog,
      eventLog: job.eventLog,
    },
    tails: {
      daemon: tailText(job.daemonLog, 40),
      events: tailText(job.eventLog, 20),
    },
  };
}

function isCompletedJob(job) {
  return Boolean(job.cancelled || job.events?.some((event) => event.type === "done" && event.triggered));
}

function isAttentionJob(job) {
  return Boolean(job.daemonRunning || job.status?.tone === "bad" || job.status?.tone === "warn");
}

function isRecentCompletedJob(job, hours = recentCompletedHours) {
  if (!isCompletedJob(job)) {
    return false;
  }
  const lastActivity = lastActivityMs(job);
  return lastActivity > 0 && Date.now() - lastActivity <= hours * 60 * 60 * 1000;
}

function isDefaultVisibleJob(job) {
  if (isAttentionJob(job)) {
    return true;
  }
  if (!isCompletedJob(job)) {
    return true;
  }
  return isRecentCompletedJob(job);
}

function annotateJobView(job) {
  const completed = isCompletedJob(job);
  const recentCompleted = isRecentCompletedJob(job);
  const current = isDefaultVisibleJob(job);
  const progressDisplay = progressDisplayForJob(job, completed);
  return {
    ...job,
    completed,
    recentCompleted,
    progressDisplay,
    view: current ? "current" : "history",
  };
}

function progressDisplayForJob(job, completed) {
  if (completed) {
    return {
      state: "complete",
      percent: 100,
      label: "任务已完成",
      detail: "",
    };
  }

  if (job.progress) {
    const percent = job.progress.total
      ? Math.min(99, Math.round((job.progress.index / job.progress.total) * 100))
      : 0;
    return {
      state: "running",
      percent,
      label: `进度 ${job.progress.index} / ${job.progress.total}`,
      detail: `成功 ${job.progress.success} / ${job.progress.evaluated}`,
    };
  }

  return {
    state: job.daemonRunning ? "waiting" : "unknown",
    percent: 0,
    label: job.daemonRunning ? "等待进度行" : "暂无进度行",
    detail: job.daemonRunning ? "本地监控正在运行，但还没有解析到 Process 进度。" : "没有可解析的 Process 进度行。",
  };
}

function loadJobs(root) {
  const actualJobsDir = join(root, ".codex-monitor", "jobs");
  const deliveryRecords = loadDeliveryRecords(root);
  const threadMetadata = loadThreadMetadata(deliveryRecords.map((record) => record.threadId));
  const jobs = listFiles(actualJobsDir, (name) => name.endsWith(".json"))
    .map((path) => summarizeJob(path, deliveryRecords, threadMetadata))
    .filter(Boolean)
    .map(annotateJobView)
    .sort((a, b) => {
      return String(b.createdAt || b.lastPollAt || "").localeCompare(String(a.createdAt || a.lastPollAt || ""));
    });
  const counts = {
    total: jobs.length,
    current: jobs.filter((job) => job.view === "current").length,
    history: jobs.filter((job) => job.view === "history").length,
    completed: jobs.filter((job) => job.completed).length,
    healthy: jobs.filter((job) => job.status.tone === "good").length,
    warning: jobs.filter((job) => job.status.tone === "warn").length,
    needsAttention: jobs.filter((job) => job.status.tone === "bad").length,
    runningDaemons: jobs.filter((job) => job.daemonRunning).length,
  };
  return {
    generatedAt: new Date().toISOString(),
    monitorRoot: join(root, ".codex-monitor"),
    counts,
    jobs,
  };
}

function moveIfExists(path, targetDir) {
  if (!path || !existsSync(path)) {
    return null;
  }
  const target = join(targetDir, basename(path));
  renameSync(path, target);
  return target;
}

function archiveOneJob(root, job) {
  const archivedAt = new Date().toISOString();
  const safeTimestamp = archivedAt.replace(/[:.]/g, "-");
  const targetDir = join(root, ".codex-monitor", "archived", `${safeTimestamp}-${job.id}`);
  mkdirSync(targetDir, { recursive: true });

  const deliveryFiles = job.events
    .map((event) => event.deliveryFile)
    .filter(Boolean);
  const localFiles = [
    job.paths.jobFile,
    job.paths.stateFile,
    job.paths.daemonLog,
    job.paths.eventLog,
    ...deliveryFiles,
  ];
  const movedFiles = [];
  for (const path of [...new Set(localFiles)]) {
    const moved = moveIfExists(path, targetDir);
    if (moved) {
      movedFiles.push(moved);
    }
  }

  writeFileSync(
    join(targetDir, "archive.json"),
    JSON.stringify({
      archivedAt,
      reason: "completed monitor history archived from dashboard",
      jobId: job.id,
      jobName: job.name,
      lastEventAt: job.lastEventAt,
      lastPollAt: job.lastPollAt,
      status: job.status,
      movedFiles,
    }, null, 2),
  );
  return { id: job.id, name: job.name, targetDir, movedFiles: movedFiles.length };
}

function archiveCompletedJobs(root, olderThanHours = archiveDefaultHours) {
  const cutoffMs = Date.now() - Math.max(1, Number(olderThanHours) || archiveDefaultHours) * 60 * 60 * 1000;
  const data = loadJobs(root);
  const candidates = data.jobs.filter((job) => {
    if (!job.completed || job.daemonRunning) {
      return false;
    }
    if (job.status.tone === "bad" || job.status.tone === "warn") {
      return false;
    }
    const lastActivity = lastActivityMs(job);
    return lastActivity > 0 && lastActivity <= cutoffMs;
  });

  const archived = [];
  for (const job of candidates) {
    archived.push(archiveOneJob(root, job));
  }

  return {
    archivedAt: new Date().toISOString(),
    olderThanHours: Math.max(1, Number(olderThanHours) || archiveDefaultHours),
    archivedCount: archived.length,
    archived,
  };
}

function sendJson(response, data, statusCode = 200) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data, null, 2));
}

function sendText(response, text, contentType = "text/html; charset=utf-8", statusCode = 200) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(text);
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Monitor Bridge</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #1f2933;
      --muted: #667085;
      --line: #d7dde5;
      --good: #16794c;
      --good-bg: #e8f6ee;
      --warn: #9a5a00;
      --warn-bg: #fff3d8;
      --bad: #b42318;
      --bad-bg: #fee9e7;
      --info: #245b9a;
      --info-bg: #e8f1fb;
      --soft: #eef1f5;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      letter-spacing: 0;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.92);
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(10px);
    }
    .wrap {
      width: min(1480px, calc(100% - 40px));
      margin: 0 auto;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding: 18px 0;
    }
    h1 {
      font-size: 20px;
      line-height: 1.2;
      margin: 0;
      font-weight: 720;
    }
    .subtitle {
      color: var(--muted);
      font-size: 13px;
      margin-top: 4px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .segmented {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--soft);
    }
    button, input {
      height: 36px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 6px;
      font: inherit;
      font-size: 14px;
    }
    button {
      padding: 0 12px;
      cursor: pointer;
    }
    button:hover { border-color: #aab3bf; }
    .segmented button {
      height: 30px;
      border: 0;
      background: transparent;
      border-radius: 6px;
      padding: 0 10px;
    }
    .segmented button.active {
      background: var(--panel);
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
      color: var(--info);
      font-weight: 650;
    }
    button.archive {
      color: var(--muted);
    }
    button.archive:hover {
      color: var(--text);
    }
    input {
      width: min(320px, 45vw);
      padding: 0 11px;
    }
    main {
      padding: 22px 0 34px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 13px 14px;
      min-height: 74px;
    }
    .metric .value {
      font-size: 24px;
      font-weight: 760;
      line-height: 1.1;
    }
    .metric .label {
      color: var(--muted);
      font-size: 13px;
      margin-top: 8px;
    }
    .jobs {
      display: grid;
      gap: 12px;
    }
    .job {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .job-head {
      display: grid;
      grid-template-columns: minmax(220px, 1.5fr) minmax(180px, 0.8fr) minmax(280px, 1.25fr) minmax(260px, 1.1fr);
      gap: 18px;
      align-items: center;
      padding: 16px 18px;
    }
    .job-title {
      min-width: 0;
    }
    .name {
      font-size: 16px;
      font-weight: 720;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .id {
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      width: fit-content;
      max-width: 100%;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 650;
      line-height: 1.2;
    }
    .status.good { color: var(--good); background: var(--good-bg); }
    .status.warn { color: var(--warn); background: var(--warn-bg); }
    .status.bad { color: var(--bad); background: var(--bad-bg); }
    .status.muted { color: var(--muted); background: var(--soft); }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      flex: 0 0 auto;
    }
    .small {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
      line-height: 1.35;
    }
    .status-note {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
      line-height: 1.35;
    }
    .status-note.good { display: none; }
    .facts {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 7px 14px;
      color: var(--muted);
      font-size: 12px;
    }
    .fact strong {
      color: var(--text);
      font-weight: 650;
    }
    .progress {
      display: grid;
      gap: 7px;
    }
    .bar {
      height: 8px;
      background: var(--soft);
      border-radius: 999px;
      overflow: hidden;
    }
    .fill {
      height: 100%;
      background: #2f7dbd;
      width: 0%;
    }
    .fill.complete { background: var(--good); }
    .fill.waiting { background: #98a2b3; }
    .events {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .event-pill {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 999px;
      padding: 5px 8px;
      font-size: 12px;
      color: var(--muted);
    }
    .event-pill.good { color: var(--good); border-color: #b9dfca; background: var(--good-bg); }
    .event-pill.warn { color: var(--warn); border-color: #eacb84; background: var(--warn-bg); }
    .event-pill.bad { color: var(--bad); border-color: #f0b5af; background: var(--bad-bg); }
    .event-pill.muted { color: var(--muted); border-color: var(--line); background: var(--soft); }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 32px;
      text-align: center;
      color: var(--muted);
      background: var(--panel);
    }
    @media (max-width: 1040px) {
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .job-head { grid-template-columns: 1fr; }
      .detail-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      .wrap { width: min(100% - 24px, 1480px); }
      .topbar { align-items: flex-start; flex-direction: column; }
      .toolbar { width: 100%; justify-content: stretch; }
      input { width: 100%; }
      .metrics { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap topbar">
      <div>
        <h1>Codex Monitor Bridge 控制面板</h1>
        <div class="subtitle" id="meta">正在读取监控状态</div>
      </div>
      <div class="toolbar">
        <div class="segmented" id="view-mode">
          <button data-view="current">关注</button>
          <button data-view="history">历史</button>
          <button data-view="all">全部</button>
        </div>
        <input id="filter" placeholder="按任务名、ID、日志路径筛选" />
        <button class="archive" id="archive-old" title="归档 24 小时前已正常结束的本地记录">归档旧记录</button>
        <button id="refresh">刷新</button>
      </div>
    </div>
  </header>
  <main class="wrap">
    <section class="metrics" id="metrics"></section>
    <section class="jobs" id="jobs"></section>
  </main>
  <script>
    const state = { data: null, filter: "", view: "current", notice: "" };
    const $ = (id) => document.getElementById(id);

    function fmtTime(iso) {
      if (!iso) return "无记录";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "无记录";
      return date.toLocaleString("zh-CN", { hour12: false });
    }

    function ago(iso) {
      if (!iso) return "无记录";
      const date = new Date(iso).getTime();
      if (Number.isNaN(date)) return "无记录";
      const sec = Math.max(0, Math.floor((Date.now() - date) / 1000));
      if (sec < 60) return sec + " 秒前";
      const min = Math.floor(sec / 60);
      if (min < 60) return min + " 分钟前";
      const hour = Math.floor(min / 60);
      if (hour < 48) return hour + " 小时前";
      return Math.floor(hour / 24) + " 天前";
    }

    function text(value) {
      return value == null || value === "" ? "无" : String(value);
    }

    function shortId(id) {
      if (!id) return "";
      return String(id).slice(0, 8);
    }

    function compact(value, maxLength = 84) {
      const valueText = String(value || "").replace(/\\s+/g, " ").trim();
      if (valueText.length <= maxLength) return valueText;
      return valueText.slice(0, Math.max(0, maxLength - 3)) + "...";
    }

    function targetEvent(job) {
      return job.events.find((event) => event.type === "done" && event.delivery)
        || job.events.find((event) => event.delivery)
        || null;
    }

    function targetLabel(event) {
      if (!event) return "无";
      return compact(event.threadTitle || "未知会话", 28);
    }

    function visibleEvents(job) {
      if (job.completed) {
        return job.events.filter((event) => event.triggered || event.delivery?.state === "failed");
      }
      return job.events;
    }

    function el(tag, attrs = {}, children = []) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else node.setAttribute(key, value);
      }
      for (const child of Array.isArray(children) ? children : [children]) {
        if (child == null) continue;
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      }
      return node;
    }

    function metric(value, label) {
      return el("div", { class: "metric" }, [
        el("div", { class: "value", text: value }),
        el("div", { class: "label", text: label }),
      ]);
    }

    function renderMetrics(data) {
      $("metrics").replaceChildren(
        metric(data.counts.current, "关注任务"),
        metric(data.counts.runningDaemons, "正在运行"),
        metric(data.counts.warning, "需要留意"),
        metric(data.counts.needsAttention, "需要处理"),
        metric(data.counts.history, "历史记录"),
      );
    }

    function eventTone(event) {
      if (!event.triggered) return "muted";
      if (!event.delivery) return "warn";
      return event.delivery.tone || "warn";
    }

    function eventText(event) {
      if (!event.triggered) return event.label + "未触发";
      if (!event.delivery) return event.label + "已触发";
      if (event.delivery.state === "delivered") return event.label + "成功";
      return event.label + "失败";
    }

    function renderProgress(job) {
      const display = job.progressDisplay || {
        state: job.completed ? "complete" : "unknown",
        percent: job.completed ? 100 : 0,
        label: job.completed ? "任务已完成" : "暂无进度行",
        detail: "",
      };
      const fillClass = "fill " + (display.state === "complete" ? "complete" : display.state === "waiting" ? "waiting" : "");
      const fill = el("div", { class: fillClass });
      const percent = Math.max(0, Math.min(100, Number(display.percent) || 0));
      fill.style.width = percent + "%";
      return el("div", { class: "progress" }, [
        el("div", { class: "small", text: display.detail ? display.label + "，" + display.detail : display.label }),
        el("div", { class: "bar" }, fill),
      ]);
    }

    function renderJob(job) {
      const status = el("div", { class: "status " + job.status.tone }, [
        el("span", { class: "dot" }),
        el("span", { text: job.status.label }),
      ]);
      const delivered = targetEvent(job);
      const events = el("div", { class: "events" },
        visibleEvents(job).map((event) => el("span", { class: "event-pill " + eventTone(event), text: eventText(event) }))
      );
      const head = el("div", { class: "job-head" }, [
        el("div", { class: "job-title" }, [
          el("div", { class: "name", text: job.name }),
          el("div", { class: "id", text: job.id }),
        ]),
        el("div", {}, [
          status,
          el("div", { class: "status-note " + job.status.tone, text: job.status.detail }),
        ]),
        el("div", { class: "facts" }, [
          el("div", { class: "fact" }, [el("strong", { text: "远端" }), " " + text(job.host) + " / PID " + text(job.remotePid)]),
          el("div", { class: "fact" }, [el("strong", { text: "本地监控" }), " " + (job.daemonRunning ? "运行中" : "未运行")]),
          el("div", { class: "fact" }, [el("strong", { text: "最近更新" }), " " + ago(job.lastEventAt || job.lastPollAt)]),
          el("div", { class: "fact" }, [el("strong", { text: "目标会话" }), " " + targetLabel(delivered)]),
        ]),
        el("div", {}, [
          renderProgress(job),
          el("div", { class: "small" }, events),
        ]),
      ]);

      return el("article", { class: "job" }, [head]);
    }

    function matches(job, filter) {
      if (!filter) return true;
      const haystack = [
        job.id,
        job.name,
        job.remoteLog,
        job.remoteEventLog,
        job.status.label,
        job.status.detail,
        ...job.events.map((event) => [event.threadTitle, event.threadId, event.threadPath].join(" ")),
      ].join(" ").toLowerCase();
      return haystack.includes(filter.toLowerCase());
    }

    function jobsForView(data) {
      if (state.view === "history") {
        return data.jobs.filter((job) => job.view === "history");
      }
      if (state.view === "all") {
        return data.jobs;
      }
      return data.jobs.filter((job) => job.view === "current");
    }

    function viewName() {
      if (state.view === "history") return "历史记录";
      if (state.view === "all") return "全部任务";
      return "关注任务";
    }

    function syncViewButtons() {
      document.querySelectorAll("[data-view]").forEach((button) => {
        button.classList.toggle("active", button.dataset.view === state.view);
        if (state.data) {
          const count = state.data.counts[button.dataset.view] ?? state.data.counts.total;
          const base = button.dataset.view === "current" ? "关注" : button.dataset.view === "history" ? "历史" : "全部";
          button.textContent = base + " " + count;
        }
      });
    }

    function render() {
      const data = state.data;
      if (!data) return;
      const notice = state.notice ? " · " + state.notice : "";
      $("meta").textContent = "运行态目录：" + data.monitorRoot + " · 更新时间：" + fmtTime(data.generatedAt) + notice;
      renderMetrics(data);
      syncViewButtons();
      const scoped = jobsForView(data);
      const visible = scoped.filter((job) => matches(job, state.filter));
      if (!visible.length) {
        const emptyText = data.jobs.length
          ? viewName() + "里没有匹配的监控任务"
          : "还没有监控任务";
        $("jobs").replaceChildren(el("div", { class: "empty", text: emptyText }));
        return;
      }
      $("jobs").replaceChildren(...visible.map(renderJob));
    }

    async function load() {
      const response = await fetch("/api/jobs", { cache: "no-store" });
      if (!response.ok) throw new Error("读取状态失败");
      state.data = await response.json();
      render();
    }

    $("refresh").addEventListener("click", () => load().catch((error) => {
      $("meta").textContent = error.message;
    }));
    $("filter").addEventListener("input", (event) => {
      state.filter = event.target.value;
      render();
    });
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => {
        state.view = button.dataset.view;
        render();
      });
    });
    $("archive-old").addEventListener("click", async () => {
      if (!confirm("归档 24 小时前已正常结束的本地记录？")) {
        return;
      }
      const response = await fetch("/api/archive-completed?olderThanHours=24", { method: "POST", cache: "no-store" });
      if (!response.ok) {
        $("meta").textContent = "归档失败";
        return;
      }
      const result = await response.json();
      state.notice = "已归档 " + result.archivedCount + " 条旧记录";
      await load();
    });
    load().catch((error) => {
      $("meta").textContent = error.message;
    });
    setInterval(() => load().catch(() => {}), 5000);
  </script>
</body>
</html>`;
}

function createDashboardServer(root) {
  return createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/jobs") {
      sendJson(response, loadJobs(root));
      return;
    }
    if (url.pathname === "/api/archive-completed") {
      if (request.method !== "POST") {
        sendJson(response, { error: "Method not allowed" }, 405);
        return;
      }
      const olderThanHours = Number(url.searchParams.get("olderThanHours") || archiveDefaultHours);
      try {
        sendJson(response, archiveCompletedJobs(root, olderThanHours));
      } catch (error) {
        sendJson(response, { error: error.message || "Archive failed" }, 500);
      }
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      sendText(response, dashboardHtml());
      return;
    }
    sendJson(response, { error: "Not found" }, 404);
  });
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const root = resolve(options.root || repoRoot);
const host = String(options.host || "127.0.0.1");
const port = Number(options.port || 17888);

if (!existsSync(join(root, ".codex-monitor"))) {
  console.warn(`监控运行态目录不存在：${join(root, ".codex-monitor")}`);
}

const server = createDashboardServer(root);
server.listen(port, host, () => {
  console.log(`Codex Monitor Bridge 控制面板已启动：http://${host}:${port}`);
});

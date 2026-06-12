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
    progress: "进度",
    done: "完成",
    oom: "显存",
  };
  return labels[type] || String(type || "事件");
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
  const failedDelivery = eventStatuses.find((event) => event.triggered && event.delivery?.state === "failed");
  const exceptional = eventStatuses.find((event) => event.triggered && isExceptionalEventType(event.type));
  const lastPollAge = secondsSince(state.lastPollAt);
  const staleAfter = Number(job.intervalSec || 30) * 3 + 90;

  if (state.cancelled) {
    return {
      label: "取消",
      tone: "muted",
      detail: "本地监控已经被取消，不会再触发新的提醒。",
    };
  }

  if (exceptional) {
    return {
      label: "异常",
      tone: "bad",
      detail: exceptional.delivery?.reason || `${exceptional.label}事件已触发。`,
    };
  }

  if (failedDelivery) {
    return {
      label: "异常",
      tone: "bad",
      detail: failedDelivery.delivery?.reason || `${failedDelivery.label}通知没有成功送达 Codex。`,
    };
  }

  if (done?.triggered) {
    if (done.delivery?.state === "delivered") {
      return {
        label: "完成",
        tone: "good",
        detail: "完成通知已送达 Codex。",
      };
    }
    if (done.delivery?.state === "failed") {
      return {
        label: "异常",
        tone: "bad",
        detail: done.delivery.reason || "远端任务已结束，但 Codex 没有成功接收通知。",
      };
    }
    if (hasAppServerBridge(job)) {
      return {
        label: "留意",
        tone: "warn",
        detail: "远端任务已结束，正在等待通知结果。",
      };
    }
    return {
      label: "完成",
      tone: "good",
      detail: "远端任务已结束。",
    };
  }

  if (daemonRunning) {
    if (lastPollAge != null && lastPollAge > staleAfter) {
      return {
        label: "留意",
        tone: "warn",
        detail: "本地 daemon 仍在，但最后一次轮询时间偏久，建议查看 daemon 日志。",
      };
    }
    return {
      label: "运行",
      tone: "running",
      detail: "本地 daemon 正在轮询远端 PID 和日志。",
    };
  }

  if (state.lastPollAt) {
    return {
      label: "异常",
      tone: "bad",
      detail: "没有看到完成事件，本地 daemon 也不在运行。远端任务可能仍在运行，也可能已经结束但没有触发提醒。",
    };
  }

  return {
    label: "等待",
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
    displayName: readableJobName(job),
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

function readableJobName(job) {
  const name = String(job.name || "").trim();
  if (name && !/^remote-\d+$/.test(name)) {
    return name;
  }
  const base = basename(String(job.remoteEventLog || job.remoteLog || name || job.id));
  const cleaned = base
    .replace(/\.(log|txt|jsonl?)$/i, "")
    .replace(/[_-]?(20\d{6}T?\d{4,6}Z?|20\d{2}[-_]?\d{2}[-_]?\d{2}[-_]?\d{4,6})$/i, "")
    .replace(/[_-]?(master|event|events|run)$/i, "")
    .replace(/[_-]+$/g, "")
    .trim();
  return cleaned || name || job.id;
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
  const plannedEvents = job.events.filter((event) => !isExceptionalEventType(event.type));
  const plannedTotal = Math.max(1, plannedEvents.length);
  const triggeredCount = plannedEvents.filter((event) => event.triggered).length;
  const businessProgress = businessProgressText(job);
  const doneEvent = job.events.find((event) => event.type === "done");

  if (completed) {
    const failedDone = doneEvent?.delivery?.state === "failed";
    return {
      state: failedDone ? "error" : "complete",
      percent: 100,
      label: failedDone ? "完成，通知失败" : doneEvent?.delivery?.state === "delivered" ? "完成，已送达" : "完成",
      detail: businessProgress,
    };
  }

  if (job.status?.tone === "bad") {
    return {
      state: "error",
      percent: Math.max(8, Math.min(100, Math.round((triggeredCount / plannedTotal) * 100))),
      label: "出问题",
      detail: businessProgress,
    };
  }

  if (job.daemonRunning || triggeredCount > 0) {
    const percent = triggeredCount > 0
      ? Math.min(92, Math.round((triggeredCount / plannedTotal) * 100))
      : 8;
    const label = triggeredCount > 0
      ? `提醒 ${triggeredCount} / ${plannedTotal}`
      : "监控中";
    return {
      state: "running",
      percent,
      label,
      detail: businessProgress,
    };
  }

  return {
    state: "waiting",
    percent: 0,
    label: "",
    detail: businessProgress,
  };
}

function isExceptionalEventType(type) {
  return new Set(["oom", "error", "fail", "failed", "failure"]).has(String(type || "").toLowerCase());
}

function businessProgressText(job) {
  if (!job.progress) {
    return "";
  }
  return `任务 ${job.progress.index} / ${job.progress.total}，成功 ${job.progress.success} / ${job.progress.evaluated}`;
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
      color-scheme: dark;
      --bg: #1e2030;
      --bg-deep: #181926;
      --panel: #24273a;
      --panel-2: #2b2f45;
      --text: #cad3f5;
      --muted: #a5adcb;
      --quiet: #7f849c;
      --line: #363a4f;
      --line-strong: #494d64;
      --good: #a6da95;
      --good-bg: rgba(166, 218, 149, 0.12);
      --running: #eed49f;
      --running-bg: rgba(238, 212, 159, 0.12);
      --warn: #eed49f;
      --warn-bg: rgba(238, 212, 159, 0.12);
      --bad: #ed8796;
      --bad-bg: rgba(237, 135, 150, 0.13);
      --info: #8aadf4;
      --info-bg: rgba(138, 173, 244, 0.12);
      --soft: #303446;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg-deep);
      color: var(--text);
      letter-spacing: 0;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: rgba(30, 32, 48, 0.94);
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(12px);
    }
    .wrap {
      width: min(980px, calc(100% - 24px));
      margin: 0 auto;
    }
    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 10px;
      padding: 12px 0;
    }
    h1 {
      font-size: 15px;
      line-height: 1.2;
      margin: 0;
      font-weight: 720;
    }
    .subtitle {
      color: var(--muted);
      font-size: 12px;
      margin-top: 3px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-start;
    }
    .segmented {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(36, 39, 58, 0.88);
    }
    button, input {
      height: 30px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 8px;
      font: inherit;
      font-size: 12px;
    }
    button {
      padding: 0 10px;
      cursor: pointer;
    }
    button:hover {
      border-color: var(--line-strong);
      background: var(--panel-2);
    }
    button:focus-visible,
    input:focus-visible {
      outline: 2px solid rgba(138, 173, 244, 0.55);
      outline-offset: 2px;
    }
    .segmented button {
      height: 26px;
      border: 0;
      background: transparent;
      border-radius: 999px;
      padding: 0 9px;
      color: var(--muted);
    }
    .segmented button.active {
      background: var(--info-bg);
      color: var(--text);
      font-weight: 650;
    }
    button.archive {
      color: var(--quiet);
    }
    button.archive:hover {
      color: var(--text);
    }
    input {
      width: min(100%, 260px);
      padding: 0 10px;
      color: var(--text);
    }
    input::placeholder { color: var(--quiet); }
    main {
      padding: 12px 0 24px;
    }
    .metrics {
      margin-bottom: 10px;
    }
    .summary {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .summary strong {
      color: var(--text);
      font-weight: 720;
    }
    .summary .split {
      width: 1px;
      height: 14px;
      background: var(--line-strong);
    }
    .jobs {
      display: grid;
      gap: 8px;
    }
    .job {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
    }
    .job-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px 12px;
      align-items: start;
      padding: 10px 12px;
    }
    .job-title {
      min-width: 0;
    }
    .name {
      font-size: 14px;
      font-weight: 720;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta-line {
      display: flex;
      align-items: center;
      gap: 7px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
      line-height: 1.35;
    }
    .meta-line .dot-sep {
      width: 3px;
      height: 3px;
      border-radius: 50%;
      background: var(--line-strong);
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      width: fit-content;
      max-width: 100%;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 650;
      line-height: 1.2;
    }
    .status.good { color: var(--good); background: var(--good-bg); }
    .status.running { color: var(--running); background: var(--running-bg); }
    .status.warn { color: var(--warn); background: var(--warn-bg); }
    .status.bad { color: var(--bad); background: var(--bad-bg); }
    .status.muted { color: var(--muted); background: var(--soft); }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      flex: 0 0 auto;
    }
    .small {
      color: var(--muted);
      font-size: 12px;
      margin-top: 5px;
      line-height: 1.35;
    }
    .job-note {
      grid-column: 1 / -1;
      color: var(--warn);
      font-size: 12px;
      line-height: 1.35;
    }
    .stages {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .stage {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      padding: 3px 7px;
      border-radius: 999px;
      font-size: 11px;
      line-height: 1.2;
      background: var(--soft);
      color: var(--muted);
    }
    .stage.good { color: var(--good); background: var(--good-bg); }
    .stage.running { color: var(--running); background: var(--running-bg); }
    .stage.warn { color: var(--warn); background: var(--warn-bg); }
    .stage.bad { color: var(--bad); background: var(--bad-bg); }
    .diag {
      grid-column: 1 / -1;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(24, 25, 38, 0.42);
      padding: 6px 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }
    .diag summary {
      cursor: pointer;
      color: var(--text);
      font-weight: 650;
    }
    .diag p {
      margin: 6px 0 0;
    }
    .progress {
      grid-column: 1 / -1;
      display: grid;
      gap: 5px;
      margin-top: 2px;
    }
    .bar {
      height: 5px;
      background: var(--soft);
      border-radius: 999px;
      overflow: hidden;
    }
    .fill {
      height: 100%;
      background: var(--info);
      width: 0%;
    }
    .fill.complete { background: var(--good); }
    .fill.running { background: var(--running); }
    .fill.waiting { background: var(--quiet); }
    .fill.error { background: var(--bad); }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 10px;
      padding: 22px;
      text-align: center;
      color: var(--muted);
      background: var(--panel);
    }
    @media (max-width: 720px) {
      .wrap { width: min(100% - 20px, 980px); }
      .toolbar { align-items: stretch; }
      .segmented { order: 1; }
      input { order: 2; flex: 1 1 100%; width: 100%; }
      #archive-old, #refresh { order: 3; }
      .job-head { padding: 10px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap topbar">
      <div>
        <h1>Codex Monitor</h1>
        <div class="subtitle" id="meta">正在读取监控状态</div>
      </div>
      <div class="toolbar">
        <div class="segmented" id="view-mode">
          <button data-view="current">关注</button>
          <button data-view="history">历史</button>
          <button data-view="all">全部</button>
        </div>
        <input id="filter" placeholder="筛选任务名或日志" />
        <button class="archive" id="archive-old" title="归档 24 小时前已正常结束的本地记录">归档</button>
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

    function renderMetrics(data) {
      $("metrics").replaceChildren(el("div", { class: "summary" }, [
        el("span", {}, ["关注 ", el("strong", { text: data.counts.current })]),
        el("span", { class: "split" }),
        el("span", {}, ["运行 ", el("strong", { text: data.counts.runningDaemons })]),
        el("span", { class: "split" }),
        el("span", {}, ["留意 ", el("strong", { text: data.counts.warning })]),
        el("span", { class: "split" }),
        el("span", {}, ["异常 ", el("strong", { text: data.counts.needsAttention })]),
        el("span", { class: "split" }),
        el("span", {}, ["历史 ", el("strong", { text: data.counts.history })]),
      ]));
    }

    function eventTone(event) {
      if (!event.triggered) return "muted";
      if (!event.delivery) return "running";
      return event.delivery.tone || "warn";
    }

    function eventText(event) {
      if (!event.triggered) return event.label + "待触发";
      if (!event.delivery) return event.label + "已触发";
      if (event.delivery.state === "delivered") return event.label + "已送达";
      return event.label + "失败";
    }

    function isExceptionalEventType(type) {
      return ["oom", "error", "fail", "failed", "failure"].includes(String(type || "").toLowerCase());
    }

    function renderStages(job) {
      const events = job.events.filter((event) => {
        return !isExceptionalEventType(event.type) || event.triggered || event.delivery;
      });
      if (!events.length) return null;
      return el("div", { class: "stages" }, events.map((event) => {
        const tone = eventTone(event);
        return el("span", { class: "stage " + tone, title: event.delivery?.reason || event.message || "" }, [
          el("span", { class: "dot" }),
          el("span", { text: eventText(event) }),
        ]);
      }));
    }

    function diagnosticForJob(job) {
      const failed = job.events.find((event) => event.triggered && event.delivery?.state === "failed");
      const exceptional = job.events.find((event) => event.triggered && isExceptionalEventType(event.type));
      const event = failed || exceptional;
      if (!event && job.status.tone !== "bad" && job.status.tone !== "warn") return null;
      const reason = event?.delivery?.reason || job.status.detail || event?.message || "需要查看本地 monitor 记录。";
      const suggestion = reason.includes("上下文")
        ? "建议压缩目标会话，或降低事件 payload 长度后重试通知。"
        : reason.includes("没有返回")
          ? "建议确认 Codex app-server 正常，并检查目标会话是否卡在上一轮回复。"
          : isExceptionalEventType(event?.type)
            ? "建议按这类异常对应的 prompt 处理远端任务，再重新启动需要的实验。"
            : "建议确认 app-server daemon 正在运行，并查看本地失败记录。";
      return { reason, suggestion, event };
    }

    function renderProgress(job) {
      const display = job.progressDisplay || {
        state: job.completed ? "complete" : "unknown",
        percent: job.completed ? 100 : 0,
        label: job.completed ? "完成" : "",
        detail: "",
      };
      if (!display.label) {
        return null;
      }
      const fillClass = "fill " + (
        display.state === "complete" ? "complete" :
        display.state === "running" ? "running" :
        display.state === "error" ? "error" :
        display.state === "waiting" ? "waiting" :
        ""
      );
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
      const progress = renderProgress(job);
      const stages = renderStages(job);
      const diagnostic = diagnosticForJob(job);
      const meta = [
        text(job.host) + (job.remotePid ? " / PID " + text(job.remotePid) : ""),
        ago(job.lastEventAt || job.lastPollAt),
        targetLabel(delivered),
      ].filter((value) => value && value !== "无");
      const note = job.status.tone === "bad" || job.status.tone === "warn"
        ? el("div", { class: "job-note", text: compact(job.status.detail, 92) })
        : null;
      const head = el("div", { class: "job-head" }, [
        el("div", { class: "job-title" }, [
          el("div", { class: "name", text: job.displayName || job.name, title: job.name + " · " + shortId(job.id) }),
          el("div", { class: "meta-line" }, meta.flatMap((item, index) => {
            return index === 0 ? [item] : [el("span", { class: "dot-sep" }), item];
          })),
        ]),
        status,
        note,
        stages,
        progress,
        diagnostic ? el("details", { class: "diag" }, [
          el("summary", { text: "诊断" }),
          el("p", { text: "原因：" + compact(diagnostic.reason, 160) }),
          el("p", { text: diagnostic.suggestion }),
        ]) : null,
      ]);

      return el("article", { class: "job" }, [head]);
    }

    function matches(job, filter) {
      if (!filter) return true;
      const haystack = [
        job.id,
        job.name,
        job.displayName,
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
      $("meta").textContent = "更新时间：" + fmtTime(data.generatedAt) + notice;
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

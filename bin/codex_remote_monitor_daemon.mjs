#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const monitorRoot = join(repoRoot, ".codex-monitor");
const jobsDir = join(monitorRoot, "jobs");

function usage() {
  console.log(`Usage:
  node bin/codex_remote_monitor_daemon.mjs launch-remote --remote-dir <path> --command <shell-cmd> [options]
  node bin/codex_remote_monitor_daemon.mjs watch-existing --pid <pid> --remote-log <path> [options]
  node bin/codex_remote_monitor_daemon.mjs list
  node bin/codex_remote_monitor_daemon.mjs status --job <job-id-or-json>
  node bin/codex_remote_monitor_daemon.mjs events [--job <job-id-or-json>] [--lines <n>]
  node bin/codex_remote_monitor_daemon.mjs check-log --log <local-log> [options]
  node bin/codex_remote_monitor_daemon.mjs cancel --job <job-id-or-json> [--kill-remote]
  node bin/codex_remote_monitor_daemon.mjs run --job <job.json>

Common options:
  --host <ssh-host>                  default: 3090
  --remote-dir <path>                remote working directory
  --remote-log <path>                remote log path
  --remote-event-log <path>          optional shorter log used for event tail
  --interval-sec <seconds>           default: 30
  --progress-index <n>               default: 8
  --total <n>                        default: 10
  --rules-file <path>                optional JSON rules file; overrides default progress rule
  --oom-regex <regex>                optional tail regex that triggers an "oom" event
  --oom-message <message>            optional message for the "oom" event
  --done-message <message>           optional message for the final "done" event
  --job-name <name>                  optional
  --on-event-command <shell-cmd>     optional local command run once per event
  --bridge-app-server                send events to Codex app-server through the local bridge
  --app-server-thread-id <id>        optional existing app-server thread to resume
  --app-server-thread-file <path>    optional saved app-server thread file
  --app-server-transport <mode>      proxy or stdio; default: proxy
  --app-server-socket <path>         optional app-server control socket path
  --app-server-timeout-sec <seconds> default: 180
  --app-server-compact-timeout-sec <seconds>
                                    default: same as app-server timeout
  --app-server-compact-before-turn   compact the target Codex thread before sending
  --app-server-no-compact-on-context-exceeded
                                    do not compact/retry after contextWindowExceeded
  --app-server-max-tail-chars <n>    default: bridge default
  --app-server-max-process-lines-chars <n>
                                    default: bridge default
  --app-server-max-prompt-chars <n>  default: bridge default
  --app-server-prompt-template <path>
                                    optional bridge prompt template for all events
  --app-server-prompt-template-dir <dir>
                                    optional dir containing <event-type>.md or default.md
  --app-server-prompt-template-<type> <path>
                                    optional bridge prompt template for one event type

launch-remote options:
  --command <shell-cmd>              remote shell command to run with nohup
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

function ensureDirs() {
  mkdirSync(jobsDir, { recursive: true });
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runSsh(host, remoteCommand, timeoutMs = 60_000) {
  const result = spawnSync("ssh", [host, remoteCommand], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function resolveJobFile(jobRef) {
  if (!jobRef) {
    throw new Error("--job is required");
  }
  if (jobRef.endsWith(".json") || jobRef.includes("/")) {
    return resolve(jobRef);
  }
  return join(jobsDir, `${jobRef}.json`);
}

function loadState(job) {
  if (!existsSync(job.stateFile)) {
    return {
      cancelled: false,
      createdAt: new Date().toISOString(),
      polls: 0,
      triggered: {},
    };
  }
  return readJson(job.stateFile);
}

function saveState(job, state) {
  writeJson(job.stateFile, state);
}

function eventLine(event) {
  return JSON.stringify({ ...event, timestamp: new Date().toISOString() });
}

function runOnEventCommand(job, line, event) {
  if (!job.onEventCommand) {
    return;
  }
  const child = spawn("/bin/sh", ["-lc", job.onEventCommand], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CODEX_MONITOR_DAEMON_LOG: job.daemonLog,
      CODEX_MONITOR_EVENT_JSON: line,
      CODEX_MONITOR_EVENT_LOG: job.eventLog,
      CODEX_MONITOR_EVENT_TYPE: event.type,
      CODEX_MONITOR_JOB_ID: job.id,
      CODEX_MONITOR_REMOTE_LOG: job.remoteLog,
      CODEX_MONITOR_REMOTE_PID: String(job.pid),
    },
  });
  child.unref();
}

function appendEvent(job, state, event) {
  const fullEvent = {
    jobId: job.id,
    jobName: job.name,
    host: job.host,
    pid: job.pid,
    remoteLog: job.remoteLog,
    remoteEventLog: job.remoteEventLog || job.remoteLog,
    type: event.type,
    remoteStatus: event.remoteStatus || "",
    message: event.message,
    processLines: event.processLines ?? "",
    tail: event.tail ?? "",
  };
  const line = eventLine(fullEvent);
  appendFileSync(join(monitorRoot, "events.jsonl"), `${line}\n`);
  appendFileSync(job.eventLog, `${line}\n`);
  state.triggered[event.type] = true;
  state.lastEventAt = new Date().toISOString();
  saveState(job, state);
  runOnEventCommand(job, line, event);
}

function parseCheckOutput(stdout) {
  const statusMatch = stdout.match(/^__MONITOR_STATUS__=(.+)$/m);
  const processStart = stdout.indexOf("__MONITOR_PROCESS_LINES_BEGIN__");
  const processEnd = stdout.indexOf("__MONITOR_PROCESS_LINES_END__");
  const tailStart = stdout.indexOf("__MONITOR_TAIL_BEGIN__");
  const tailEnd = stdout.indexOf("__MONITOR_TAIL_END__");
  const processLines =
    processStart >= 0 && processEnd > processStart
      ? stdout.slice(processStart + "__MONITOR_PROCESS_LINES_BEGIN__".length, processEnd).trim()
      : "";
  const tail =
    tailStart >= 0 && tailEnd > tailStart
      ? stdout.slice(tailStart + "__MONITOR_TAIL_BEGIN__".length, tailEnd).trim()
      : stdout;
  return {
    status: statusMatch?.[1]?.trim() || "unknown",
    processLines,
    tail,
  };
}

function parseProgress(processLines) {
  const progress = [];
  const pattern = /^(\d+):Process \[(\d+)\/(\d+)\], Success \[(\d+)\/(\d+)\]:/gm;
  let match;
  while ((match = pattern.exec(processLines)) !== null) {
    progress.push({
      line: Number(match[1]),
      index: Number(match[2]),
      total: Number(match[3]),
      success: Number(match[4]),
      evaluated: Number(match[5]),
      raw: match[0],
    });
  }
  return progress;
}

function remoteCheckCommand(job) {
  const eventLog = job.remoteEventLog || job.remoteLog;
  return [
    `cd ${shQuote(job.remoteDir)}`,
    `if kill -0 ${shQuote(job.pid)} 2>/dev/null; then STATUS=running; else STATUS=done; fi`,
    `printf '%s\\n' "__MONITOR_STATUS__=$STATUS"`,
    `printf '%s\\n' "__MONITOR_PROCESS_LINES_BEGIN__"`,
    `grep -n '^Process \\[' ${shQuote(job.remoteLog)} 2>/dev/null | tail -20 || true`,
    `printf '%s\\n' "__MONITOR_PROCESS_LINES_END__"`,
    `printf '%s\\n' "__MONITOR_TAIL_BEGIN__"`,
    `tail -200 ${shQuote(eventLog)} 2>&1 || true`,
    `printf '\\n%s\\n' "__MONITOR_TAIL_END__"`,
  ].join("; ");
}

function defaultRules(options) {
  const progressIndex = Number(options["progress-index"] || 8);
  const total = Number(options.total || 10);
  const rules = [
    {
      type: "progress",
      kind: "progressIndex",
      index: progressIndex,
      total,
      message: `Remote run reached process [${progressIndex}/${total}]; it is close to finishing.`,
    },
  ];
  if (typeof options["oom-regex"] === "string") {
    rules.push({
      type: "oom",
      kind: "regex",
      source: "tail",
      regex: options["oom-regex"],
      message: options["oom-message"] || "Remote run appears to have hit an out-of-memory error.",
    });
  }
  return rules;
}

function rulesFromOptions(options) {
  if (typeof options["rules-file"] !== "string") {
    return defaultRules(options);
  }
  const loaded = readJson(resolve(options["rules-file"]));
  const rules = Array.isArray(loaded) ? loaded : loaded.rules;
  if (!Array.isArray(rules)) {
    throw new Error("--rules-file must contain a JSON array or an object with a rules array");
  }
  return rules;
}

function appServerBridgeCommand(options) {
  const script = join(repoRoot, "bin", "codex_app_server_event_bridge.mjs");
  const threadId = typeof options["app-server-thread-id"] === "string" ? options["app-server-thread-id"] : null;
  const parts = [
    "node",
    shQuote(script),
    "--cwd",
    shQuote(repoRoot),
    "--transport",
    shQuote(options["app-server-transport"] || "proxy"),
    "--timeout-sec",
    shQuote(options["app-server-timeout-sec"] || "180"),
  ];
  if (threadId) {
    parts.push("--thread-id", shQuote(threadId));
  }
  if (typeof options["app-server-socket"] === "string") {
    parts.push("--socket", shQuote(resolve(options["app-server-socket"])));
  }
  if (options["app-server-compact-before-turn"]) {
    parts.push("--compact-before-turn");
  }
  if (options["app-server-no-compact-on-context-exceeded"]) {
    parts.push("--no-compact-on-context-exceeded");
  }
  if (typeof options["app-server-compact-timeout-sec"] === "string") {
    parts.push("--compact-timeout-sec", shQuote(options["app-server-compact-timeout-sec"]));
  }
  if (typeof options["app-server-max-tail-chars"] === "string") {
    parts.push("--max-tail-chars", shQuote(options["app-server-max-tail-chars"]));
  }
  if (typeof options["app-server-max-process-lines-chars"] === "string") {
    parts.push("--max-process-lines-chars", shQuote(options["app-server-max-process-lines-chars"]));
  }
  if (typeof options["app-server-max-prompt-chars"] === "string") {
    parts.push("--max-prompt-chars", shQuote(options["app-server-max-prompt-chars"]));
  }
  if (typeof options["app-server-thread-file"] === "string") {
    parts.push("--thread-file", shQuote(resolve(options["app-server-thread-file"])));
  }
  if (typeof options["app-server-prompt-template"] === "string") {
    parts.push("--prompt-template", shQuote(resolve(options["app-server-prompt-template"])));
  }
  if (typeof options["app-server-prompt-template-dir"] === "string") {
    parts.push("--prompt-template-dir", shQuote(resolve(options["app-server-prompt-template-dir"])));
  }
  const eventTemplatePrefix = "app-server-prompt-template-";
  for (const [key, value] of Object.entries(options)) {
    if (!key.startsWith(eventTemplatePrefix) || !value || key === "app-server-prompt-template-dir") {
      continue;
    }
    const eventType = key.slice(eventTemplatePrefix.length);
    if (!eventType) {
      continue;
    }
    parts.push(`--prompt-template-${eventType}`, shQuote(resolve(String(value))));
  }
  return parts.join(" ");
}

function eventCommandFromOptions(options) {
  if (typeof options["on-event-command"] === "string") {
    return options["on-event-command"];
  }
  if (options["bridge-app-server"]) {
    return appServerBridgeCommand(options);
  }
  return null;
}

function ruleMatches(rule, parsed) {
  if (rule.kind === "progressIndex") {
    return parseProgress(parsed.processLines).some((entry) => {
      return entry.index >= Number(rule.index) && entry.total === Number(rule.total);
    });
  }
  const sourceText = rule.source === "tail" ? parsed.tail : parsed.processLines;
  return new RegExp(rule.regex).test(sourceText);
}

function makeJob({
  host,
  pid,
  remoteDir,
  remoteLog,
  remoteEventLog,
  name,
  intervalSec,
  onEventCommand,
  rules,
  doneMessage,
  split,
}) {
  ensureDirs();
  const idSeed = `${host}:${pid}:${remoteLog}:${Date.now()}`;
  const id = createHash("sha1").update(idSeed).digest("hex").slice(0, 12);
  const jobFile = join(jobsDir, `${id}.json`);
  const job = {
    id,
    name,
    host,
    pid: String(pid),
    remoteDir,
    remoteLog,
    remoteEventLog,
    split,
    rules,
    doneMessage,
    intervalSec,
    sshTimeoutMs: 60_000,
    onEventCommand,
    jobFile,
    stateFile: join(monitorRoot, `${id}.state.json`),
    daemonLog: join(monitorRoot, `${id}.daemon.log`),
    eventLog: join(monitorRoot, `${id}.events.log`),
  };
  writeJson(jobFile, job);
  return job;
}

function startDetached(job) {
  closeSync(openSync(job.daemonLog, "a"));
  closeSync(openSync(job.eventLog, "a"));
  const outFd = openSync(job.daemonLog, "a");
  const errFd = openSync(job.daemonLog, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", "--job", job.jobFile], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", outFd, errFd],
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  job.daemonPid = child.pid;
  writeJson(job.jobFile, job);
  return child.pid;
}

async function runJob(jobPath) {
  const job = readJson(jobPath);
  closeSync(openSync(job.daemonLog, "a"));
  closeSync(openSync(job.eventLog, "a"));
  let state = loadState(job);

  const scheduleNext = () => {
    setTimeout(poll, job.intervalSec * 1000);
  };

  const poll = () => {
    state = loadState(job);
    if (state.cancelled) {
      appendFileSync(job.daemonLog, `[${new Date().toISOString()}] job cancelled; daemon exiting\n`);
      process.exit(0);
    }
    state.polls += 1;
    state.lastPollAt = new Date().toISOString();
    saveState(job, state);

    let check;
    try {
      check = runSsh(job.host, remoteCheckCommand(job), job.sshTimeoutMs);
    } catch (error) {
      appendFileSync(job.daemonLog, `[${new Date().toISOString()}] ssh check failed: ${error.message}\n`);
      scheduleNext();
      return;
    }

    if (check.status !== 0) {
      appendFileSync(job.daemonLog, `[${new Date().toISOString()}] ssh check exit=${check.status}\n${check.stderr}\n`);
    }

    const parsed = parseCheckOutput(check.stdout);
    for (const rule of job.rules || []) {
      if (!state.triggered[rule.type] && ruleMatches(rule, parsed)) {
        appendEvent(job, state, {
          type: rule.type,
          remoteStatus: parsed.status,
          message: rule.message,
          tail: parsed.tail,
          processLines: parsed.processLines,
        });
      }
    }

    if (parsed.status === "done") {
      if (!state.triggered.done) {
        appendEvent(job, state, {
          type: "done",
          remoteStatus: parsed.status,
          message: job.doneMessage,
          tail: parsed.tail,
          processLines: parsed.processLines,
        });
      }
      appendFileSync(job.daemonLog, `[${new Date().toISOString()}] job complete; daemon exiting\n`);
      process.exit(0);
    }

    scheduleNext();
  };

  appendFileSync(job.daemonLog, `[${new Date().toISOString()}] daemon started for job ${job.id}, pid ${job.pid}\n`);
  poll();
}

function launchRemote(options) {
  const host = options.host || "3090";
  const remoteDir = options["remote-dir"];
  const remoteCommand = options.command;
  if (!remoteDir || !remoteCommand) {
    throw new Error("launch-remote requires --remote-dir and --command");
  }
  const intervalSec = Number(options["interval-sec"] || 30);
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const remoteLog = options["remote-log"] || `${remoteDir}/codex-monitor-${now}.log`;

  const launchScript = `
cd ${shQuote(remoteDir)}
LOG_PATH=${shQuote(remoteLog)}
mkdir -p "$(dirname "$LOG_PATH")"
nohup bash -lc ${shQuote(remoteCommand)} > "$LOG_PATH" 2>&1 &
printf '%s\\n' "PID=$!"
printf '%s\\n' "LOG=$LOG_PATH"
`;

  const launched = runSsh(host, `bash -lc ${shQuote(launchScript)}`, 60_000);
  if (launched.status !== 0) {
    throw new Error(`remote launch failed (${launched.status})\n${launched.stderr}\n${launched.stdout}`);
  }
  const pid = launched.stdout.match(/^PID=(.+)$/m)?.[1]?.trim();
  const log = launched.stdout.match(/^LOG=(.+)$/m)?.[1]?.trim();
  if (!pid || !log) {
    throw new Error(`could not parse launch output:\n${launched.stdout}\n${launched.stderr}`);
  }

  const job = makeJob({
    host,
    pid,
    remoteDir,
    remoteLog: log,
    remoteEventLog: options["remote-event-log"] || log,
    split: null,
    intervalSec,
    name: options["job-name"] || `remote-${pid}`,
    onEventCommand: eventCommandFromOptions(options),
    rules: rulesFromOptions(options),
    doneMessage: options["done-message"] || "Remote process finished; inspect the results and continue with the next step.",
  });
  const daemonPid = startDetached(job);
  console.log(JSON.stringify({ jobId: job.id, daemonPid, remotePid: pid, remoteLog: log, jobFile: job.jobFile }, null, 2));
}

function watchExisting(options) {
  const host = options.host || "3090";
  const pid = options.pid;
  const remoteLog = options["remote-log"];
  if (!pid || !remoteLog) {
    throw new Error("watch-existing requires --pid and --remote-log");
  }
  const remoteDir = options["remote-dir"] || dirname(remoteLog);
  const intervalSec = Number(options["interval-sec"] || 30);
  const job = makeJob({
    host,
    pid,
    remoteDir,
    remoteLog,
    remoteEventLog: options["remote-event-log"] || remoteLog,
    intervalSec,
    name: options["job-name"] || `remote-${pid}`,
    onEventCommand: eventCommandFromOptions(options),
    rules: rulesFromOptions(options),
    doneMessage: options["done-message"] || "Remote process finished; inspect the results.",
  });
  const daemonPid = startDetached(job);
  console.log(JSON.stringify({ jobId: job.id, daemonPid, remotePid: pid, remoteLog, jobFile: job.jobFile }, null, 2));
}

function jobFiles() {
  if (!existsSync(jobsDir)) {
    return [];
  }
  return readdirSync(jobsDir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("._"))
    .map((name) => join(jobsDir, name))
    .sort();
}

function localPidRunning(pid) {
  if (!pid) {
    return false;
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() !== "";
}

function summarizeJob(jobFile) {
  const job = readJson(jobFile);
  const state = loadState(job);
  return {
    id: job.id,
    name: job.name,
    daemonPid: job.daemonPid ?? null,
    daemonRunning: localPidRunning(job.daemonPid),
    remotePid: job.pid,
    remoteLog: job.remoteLog,
    remoteEventLog: job.remoteEventLog || job.remoteLog,
    polls: state.polls ?? 0,
    triggered: state.triggered ?? {},
    cancelled: Boolean(state.cancelled),
    lastPollAt: state.lastPollAt ?? null,
    lastEventAt: state.lastEventAt ?? null,
  };
}

function listJobs() {
  console.log(JSON.stringify(jobFiles().map(summarizeJob), null, 2));
}

function statusJob(options) {
  const jobFile = resolveJobFile(options.job);
  console.log(JSON.stringify(summarizeJob(jobFile), null, 2));
}

function readTail(path, lines) {
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

function showEvents(options) {
  const lines = Number(options.lines || 20);
  const path = options.job ? readJson(resolveJobFile(options.job)).eventLog : join(monitorRoot, "events.jsonl");
  const output = readTail(path, lines);
  if (output) {
    console.log(output);
  }
}

function checkLocalLog(options) {
  const logPath = options.log;
  if (!logPath) {
    throw new Error("check-log requires --log");
  }
  const text = readFileSync(resolve(logPath), "utf8");
  const processLines = text
    .split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.startsWith("Process ["))
    .slice(-20)
    .map(({ line, index }) => `${index}:${line}`)
    .join("\n");
  const parsed = { processLines, tail: text.split("\n").slice(-200).join("\n") };
  const rules = rulesFromOptions(options);
  console.log(
    JSON.stringify(
      {
        progress: parseProgress(processLines),
        rules: rules.map((rule) => ({
          type: rule.type,
          matched: ruleMatches(rule, parsed),
          rule,
        })),
      },
      null,
      2,
    ),
  );
}

function cancelJob(options) {
  const job = readJson(resolveJobFile(options.job));
  const state = loadState(job);
  state.cancelled = true;
  state.cancelledAt = new Date().toISOString();
  saveState(job, state);
  if (job.daemonPid && localPidRunning(job.daemonPid)) {
    spawnSync("kill", [String(job.daemonPid)]);
  }
  if (options["kill-remote"]) {
    runSsh(job.host, `kill ${shQuote(job.pid)} 2>/dev/null || true`, 30_000);
  }
  console.log(JSON.stringify({ cancelled: true, jobId: job.id, killedRemote: Boolean(options["kill-remote"]) }, null, 2));
}

const [command, ...rest] = process.argv.slice(2);
const options = parseArgs(rest);

try {
  if (command === "launch-remote") {
    launchRemote(options);
  } else if (command === "watch-existing") {
    watchExisting(options);
  } else if (command === "run") {
    await runJob(resolveJobFile(options.job));
  } else if (command === "list") {
    listJobs();
  } else if (command === "status") {
    statusJob(options);
  } else if (command === "events") {
    showEvents(options);
  } else if (command === "check-log") {
    checkLocalLog(options);
  } else if (command === "cancel") {
    cancelJob(options);
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}

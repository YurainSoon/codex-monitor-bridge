#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const monitorRoot = join(repoRoot, ".codex-monitor");
const responsesDir = join(monitorRoot, "app-server-responses");
const bridgeLog = join(monitorRoot, "app-server-bridge.log");
const defaultThreadFile = join(monitorRoot, "app-server-thread.json");

function usage() {
  console.log(`Usage:
  node bin/codex_app_server_event_bridge.mjs [options]

Options:
  --event-json <json>          event payload; defaults to CODEX_MONITOR_EVENT_JSON
  --event-file <path>          read event payload from file
  --thread-id <id>             app-server thread id to resume
  --thread-file <path>         default: .codex-monitor/app-server-thread.json
  --cwd <path>                 default: current repository root
  --transport <proxy|stdio>    default: proxy
  --socket <path>              default: ~/.codex/app-server-control/app-server-control.sock
  --timeout-sec <seconds>      default: 180
  --compact-timeout-sec <sec>  default: same as --timeout-sec
  --retry-sec <seconds>        default: 15
  --max-retries <n>            default: 8
  --no-quota-preflight         skip Codex usage/rate-limit check before sending
  --no-defer-on-usage-limit    fail immediately instead of waiting for quota reset
  --quota-limit-id <id>        default: codex
  --quota-max-defer-sec <sec>  default: 21600; max time to wait for quota reset
  --quota-resume-buffer-sec <sec>
                              default: 60; wait this many extra seconds after reset
  --quota-min-primary-remaining-percent <n>
                              default: 1
  --quota-min-secondary-remaining-percent <n>
                              default: 1
  --quota-min-individual-remaining-percent <n>
                              default: 1
  --compact-before-turn        compact the target thread before sending
  --no-compact-on-context-exceeded
                              do not compact/retry after contextWindowExceeded
  --effort <value>             optional app-server reasoning effort for monitor turns
  --effort-<type> <value>      optional effort override for one event type, e.g. --effort-done low
  --max-tail-chars <n>         default: 2000
  --max-process-lines-chars <n>
                              default: 2000
  --max-prompt-chars <n>       default: 12000; 0 disables prompt cap
  --prompt-template <path>     optional template file for all events
  --prompt-template-dir <dir>  optional dir containing <event-type>.md or default.md
  --prompt-template-<type> <path>
                              optional template file for a specific event type
  --dry-run                    write the prompt that would be sent, do not call app-server

Template placeholders:
  {{event_json}}               compact event JSON with long fields truncated
  {{event_json_full}}          original event JSON; can be very large
  {{event.type}}               any event field by dot path
  {{tail}}, {{message}}, ...   shorthand for top-level compact event fields
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
  mkdirSync(monitorRoot, { recursive: true });
  mkdirSync(responsesDir, { recursive: true });
}

function timestamp() {
  return new Date().toISOString();
}

function log(line) {
  appendFileSync(bridgeLog, `[${timestamp()}] ${line}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function loadEvent(options) {
  const raw =
    typeof options["event-json"] === "string"
      ? options["event-json"]
      : typeof options["event-file"] === "string"
        ? readFileSync(resolve(options["event-file"]), "utf8")
        : process.env.CODEX_MONITOR_EVENT_JSON;
  if (!raw) {
    throw new Error("No event JSON found. Pass --event-json/--event-file or set CODEX_MONITOR_EVENT_JSON.");
  }
  return JSON.parse(raw);
}

function readNonNegativeInt(value, defaultValue) {
  if (value == null || value === true) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

function readNonNegativeNumber(value, defaultValue) {
  if (value == null || value === true) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

function promptLimits(options = {}) {
  return {
    maxTailChars: readNonNegativeInt(options["max-tail-chars"], 2000),
    maxProcessLinesChars: readNonNegativeInt(options["max-process-lines-chars"], 2000),
    maxStringChars: readNonNegativeInt(options["max-string-chars"], 2000),
    maxPromptChars: readNonNegativeInt(options["max-prompt-chars"], 12000),
  };
}

function truncate(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function compactValueForPrompt(value, limits, key = "") {
  if (typeof value === "string") {
    if (key === "tail") {
      return truncate(value, limits.maxTailChars);
    }
    if (key === "processLines") {
      return truncate(value, limits.maxProcessLinesChars);
    }
    if (/log|trace|stdout|stderr|tail/i.test(key)) {
      return truncate(value, limits.maxTailChars);
    }
    return truncate(value, limits.maxStringChars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactValueForPrompt(item, limits));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        compactValueForPrompt(childValue, limits, childKey),
      ]),
    );
  }
  return value;
}

function compactEventForPrompt(event, options = {}) {
  return compactValueForPrompt(event, promptLimits(options));
}

function getPathValue(source, dottedPath) {
  return String(dottedPath)
    .split(".")
    .reduce((value, key) => {
      if (value == null || typeof value !== "object") {
        return undefined;
      }
      return value[key];
    }, source);
}

function capPrompt(text, options = {}) {
  const maxPromptChars = promptLimits(options).maxPromptChars;
  if (maxPromptChars === 0 || text.length <= maxPromptChars) {
    return text;
  }
  const omitted = text.length - maxPromptChars;
  const suffix = `\n\n...[monitor bridge truncated prompt by ${omitted} chars to stay under --max-prompt-chars]`;
  const keep = Math.max(0, maxPromptChars - suffix.length);
  return `${text.slice(0, keep)}${suffix}`;
}

function renderTemplate(template, event, options = {}) {
  const compactEvent = compactEventForPrompt(event, options);
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    if (key === "event_json") {
      return JSON.stringify(compactEvent, null, 2);
    }
    if (key === "event_json_full") {
      return JSON.stringify(event, null, 2);
    }
    const value = key.startsWith("event.")
      ? getPathValue(compactEvent, key.slice("event.".length))
      : compactEvent[key];
    if (value == null) {
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
}

function selectPromptTemplate(options, event) {
  const eventType = String(event.type || "event");
  const eventSpecificKey = `prompt-template-${eventType}`;
  if (typeof options[eventSpecificKey] === "string") {
    return readFileSync(resolve(options[eventSpecificKey]), "utf8");
  }

  if (typeof options["prompt-template-dir"] === "string") {
    const templateDir = resolve(options["prompt-template-dir"]);
    const eventPath = join(templateDir, `${eventType}.md`);
    if (existsSync(eventPath)) {
      return readFileSync(eventPath, "utf8");
    }
    const defaultPath = join(templateDir, "default.md");
    if (existsSync(defaultPath)) {
      return readFileSync(defaultPath, "utf8");
    }
  }

  if (typeof options["prompt-template"] === "string") {
    return readFileSync(resolve(options["prompt-template"]), "utf8");
  }

  return null;
}

function buildPrompt(event, options = {}) {
  const customTemplate = selectPromptTemplate(options, event);
  if (customTemplate) {
    return capPrompt(renderTemplate(customTemplate, event, options), options);
  }

  const compactEvent = compactEventForPrompt(event, options);

  return capPrompt([
    "A background monitor event fired for the ChinaTravel remote experiment.",
    "",
    "Please acknowledge the event in Chinese in 1-3 short paragraphs.",
    "For a progress event, say that the run reached the configured near-finish checkpoint.",
    "For a done event, summarize whether the event summary looks successful and say that results can be inspected.",
    "Do not run commands for this bridge notification; this message is only a signal delivery test.",
    "",
    "Event JSON:",
    "```json",
    JSON.stringify(compactEvent, null, 2),
    "```",
  ].join("\n"), options);
}

function codexErrorInfoFrom(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const knownCodes = [
      "contextWindowExceeded",
      "usageLimitExceeded",
      "serverOverloaded",
      "responseTooManyFailedAttempts",
      "internalServerError",
      "streamDisconnected",
    ];
    return knownCodes.find((code) => value.includes(code)) || null;
  }
  return (
    value.codexErrorInfo ||
    value.code ||
    value.error?.codexErrorInfo ||
    value.error?.code ||
    codexErrorInfoFrom(value.message) ||
    null
  );
}

function isContextWindowExceeded(value) {
  return codexErrorInfoFrom(value) === "contextWindowExceeded";
}

function isUsageLimitExceeded(value) {
  return codexErrorInfoFrom(value) === "usageLimitExceeded";
}

function appServerErrorFromPayload(payload, prefix = "app-server error") {
  const message = payload?.message || payload?.error?.message || JSON.stringify(payload);
  const error = new Error(`${prefix}: ${message}`);
  error.appServerError = payload;
  error.codexErrorInfo = codexErrorInfoFrom(payload);
  if (error.codexErrorInfo) {
    error.code = error.codexErrorInfo;
  }
  return error;
}

function deliveryError(message, code, appServerErrors = [], details = {}) {
  const error = new Error(message);
  error.code = code;
  error.codexErrorInfo = code;
  error.appServerErrors = appServerErrors;
  Object.assign(error, details);
  return error;
}

function appServerErrorsFrom(error) {
  if (!error) {
    return [];
  }
  if (Array.isArray(error.appServerErrors)) {
    return error.appServerErrors;
  }
  if (error.appServerError) {
    return [error.appServerError];
  }
  return [];
}

function shouldRejectTurnForAppServerError(payload) {
  return (
    isContextWindowExceeded(payload) ||
    isUsageLimitExceeded(payload) ||
    payload?.willRetry === false
  );
}

function isRetryableDeliveryError(error) {
  if (!error) {
    return false;
  }
  const code = error.code || error.codexErrorInfo;
  if ([
    "contextWindowExceeded",
    "emptyAgentText",
    "usageLimitExceeded",
    "usageLimitDeferred",
    "usageLimitBlocked",
    "quotaReadFailed",
    "appServerRejected",
  ].includes(code)) {
    return false;
  }
  return !appServerErrorsFrom(error).some((entry) => entry?.willRetry === false);
}

function quotaConfig(options = {}) {
  return {
    enabled: options["no-quota-preflight"] !== true,
    deferOnLimit: options["no-defer-on-usage-limit"] !== true,
    limitId: typeof options["quota-limit-id"] === "string" ? options["quota-limit-id"] : "codex",
    minPrimaryRemainingPercent: readNonNegativeNumber(options["quota-min-primary-remaining-percent"], 1),
    minSecondaryRemainingPercent: readNonNegativeNumber(options["quota-min-secondary-remaining-percent"], 1),
    minIndividualRemainingPercent: readNonNegativeNumber(options["quota-min-individual-remaining-percent"], 1),
    maxDeferSec: readNonNegativeNumber(options["quota-max-defer-sec"], 21_600),
    resumeBufferSec: readNonNegativeNumber(options["quota-resume-buffer-sec"], 60),
  };
}

function normalizeResetMs(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function selectRateLimitSnapshot(response, limitId = "codex") {
  return response?.rateLimitsByLimitId?.[limitId] || response?.rateLimits || null;
}

function summarizeRateLimitWindow(window) {
  if (!window || typeof window !== "object") {
    return null;
  }
  return {
    usedPercent: typeof window.usedPercent === "number" ? window.usedPercent : null,
    windowDurationMins: window.windowDurationMins ?? null,
    resetsAt: window.resetsAt ?? null,
  };
}

function summarizeRateLimitSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }
  return {
    limitId: snapshot.limitId || null,
    limitName: snapshot.limitName || null,
    planType: snapshot.planType || null,
    rateLimitReachedType: snapshot.rateLimitReachedType || null,
    primary: summarizeRateLimitWindow(snapshot.primary),
    secondary: summarizeRateLimitWindow(snapshot.secondary),
    credits: snapshot.credits
      ? {
          hasCredits: snapshot.credits.hasCredits ?? null,
          balance: snapshot.credits.balance ?? null,
        }
      : null,
    individualLimit: snapshot.individualLimit
      ? {
          limit: snapshot.individualLimit.limit ?? null,
          used: snapshot.individualLimit.used ?? null,
          remainingPercent: snapshot.individualLimit.remainingPercent ?? null,
          resetsAt: snapshot.individualLimit.resetsAt ?? null,
        }
      : null,
  };
}

function quotaDecision(response, config) {
  const snapshot = selectRateLimitSnapshot(response, config.limitId);
  if (!snapshot) {
    return {
      blocked: true,
      code: "quotaUnavailable",
      label: "无法读取 Codex 用量",
      reasons: ["app-server did not return a Codex rate-limit snapshot"],
      retryAfterAt: null,
      waitMs: null,
      snapshot: null,
    };
  }

  const reasons = [];
  const resetMsCandidates = [];
  const addReset = (value) => {
    const resetMs = normalizeResetMs(value);
    if (resetMs != null) {
      resetMsCandidates.push(resetMs);
    }
  };
  const checkWindow = (name, window, minRemainingPercent) => {
    if (!window || typeof window.usedPercent !== "number") {
      return;
    }
    const remaining = Math.max(0, 100 - window.usedPercent);
    if (window.usedPercent >= 100 || remaining <= minRemainingPercent) {
      reasons.push(`${name} quota remaining ${remaining.toFixed(2)}%`);
      addReset(window.resetsAt);
    }
  };

  if (snapshot.rateLimitReachedType) {
    reasons.push(`Codex reported ${snapshot.rateLimitReachedType}`);
    const reachedType = String(snapshot.rateLimitReachedType).toLowerCase();
    if (reachedType.includes("primary")) {
      addReset(snapshot.primary?.resetsAt);
    } else if (reachedType.includes("secondary")) {
      addReset(snapshot.secondary?.resetsAt);
    } else if (reachedType.includes("individual") || reachedType.includes("spend")) {
      addReset(snapshot.individualLimit?.resetsAt);
    } else {
      addReset(snapshot.primary?.resetsAt);
      addReset(snapshot.secondary?.resetsAt);
      addReset(snapshot.individualLimit?.resetsAt);
    }
  }
  checkWindow("primary", snapshot.primary, config.minPrimaryRemainingPercent);
  checkWindow("secondary", snapshot.secondary, config.minSecondaryRemainingPercent);
  if (
    snapshot.individualLimit &&
    typeof snapshot.individualLimit.remainingPercent === "number" &&
    snapshot.individualLimit.remainingPercent <= config.minIndividualRemainingPercent
  ) {
    reasons.push(`individual quota remaining ${snapshot.individualLimit.remainingPercent.toFixed(2)}%`);
    addReset(snapshot.individualLimit.resetsAt);
  }

  if (!reasons.length) {
    return {
      blocked: false,
      code: "quotaAvailable",
      label: "Codex 用量可用",
      reasons: [],
      retryAfterAt: null,
      waitMs: null,
      snapshot: summarizeRateLimitSnapshot(snapshot),
    };
  }

  const resetMs = resetMsCandidates.length ? Math.max(...resetMsCandidates) : null;
  const retryMs = resetMs == null ? null : resetMs + config.resumeBufferSec * 1000;
  return {
    blocked: true,
    code: "usageLimitBlocked",
    label: "Codex 用量限制，稍后推送",
    reasons,
    retryAfterAt: retryMs == null ? null : new Date(retryMs).toISOString(),
    waitMs: retryMs == null ? null : Math.max(0, retryMs - Date.now()),
    snapshot: summarizeRateLimitSnapshot(snapshot),
  };
}

class AppServerClient {
  constructor({ timeoutMs, transport, socketPath }) {
    this.timeoutMs = timeoutMs;
    this.transport = transport;
    this.socketPath = socketPath;
    this.nextId = 1;
    this.pending = new Map();
    this.agentText = "";
    this.turnWaiters = [];
    this.compactWaiters = [];
    this.appServerErrors = [];
    this.stderr = "";
    this.child = null;
    this.socket = null;
    this.wsBuffer = Buffer.alloc(0);
    this.ready = transport === "proxy" ? this.startWebSocket() : this.startStdio();
  }

  startStdio() {
    this.child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });

    this.child.on("exit", (code, signal) => {
      const error = new Error(`app-server exited before completing request (code=${code}, signal=${signal})`);
      this.failAll(error);
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleRawMessage(line));
    return Promise.resolve();
  }

  startWebSocket() {
    return new Promise((resolveReady, rejectReady) => {
      let settled = false;
      let handshake = Buffer.alloc(0);
      const timeout = setTimeout(() => {
        rejectOnce(new Error(`timed out connecting to app-server control socket ${this.socketPath}`));
      }, this.timeoutMs);

      const rejectOnce = (error) => {
        if (settled) {
          this.failAll(error);
          return;
        }
        settled = true;
        clearTimeout(timeout);
        rejectReady(error);
      };

      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolveReady();
      };

      this.socket = createConnection(this.socketPath);

      this.socket.on("connect", () => {
        const key = randomBytes(16).toString("base64");
        const request = [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n");
        this.socket.write(request);
      });

      this.socket.on("data", (chunk) => {
        if (!settled) {
          handshake = Buffer.concat([handshake, chunk]);
          const headerEnd = handshake.indexOf("\r\n\r\n");
          if (headerEnd === -1) {
            return;
          }
          const header = handshake.slice(0, headerEnd).toString("utf8");
          if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
            rejectOnce(new Error(`app-server WebSocket upgrade failed: ${header.split("\r\n")[0] || header}`));
            return;
          }
          const rest = handshake.slice(headerEnd + 4);
          resolveOnce();
          if (rest.length > 0) {
            this.handleWebSocketData(rest);
          }
          return;
        }
        this.handleWebSocketData(chunk);
      });

      this.socket.on("error", (error) => rejectOnce(error));
      this.socket.on("close", () => this.failAll(new Error("app-server WebSocket closed")));
      this.socket.on("end", () => this.failAll(new Error("app-server WebSocket ended")));
    });
  }

  failAll(error) {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters) {
      waiter.reject(error);
    }
    this.turnWaiters = [];
    for (const waiter of this.compactWaiters) {
      waiter.reject(error);
    }
    this.compactWaiters = [];
  }

  handleRawMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      log(`invalid app-server message: ${String(raw).slice(0, 500)}`);
      return;
    }

    if (message.id != null && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(waiter.timeout);
      if (message.error) {
        waiter.reject(appServerErrorFromPayload(message.error, "app-server request failed"));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      this.agentText += message.params?.delta || "";
      return;
    }

    if (message.method === "turn/completed") {
      const remaining = [];
      for (const waiter of this.turnWaiters) {
        const threadId = message.params?.threadId;
        if (waiter.threadId && waiter.threadId !== threadId) {
          remaining.push(waiter);
          continue;
        }
        clearTimeout(waiter.timeout);
        waiter.resolve(message.params);
      }
      this.turnWaiters = remaining;
      return;
    }

    if (message.method === "error") {
      this.appServerErrors.push(message.params);
      log(`app-server notification error: ${JSON.stringify(message.params)}`);
      if (shouldRejectTurnForAppServerError(message.params)) {
        const error = appServerErrorFromPayload(message.params, "app-server notification error");
        const threadId = message.params?.threadId;
        const remaining = [];
        for (const waiter of this.turnWaiters) {
          if (waiter.threadId && threadId && waiter.threadId !== threadId) {
            remaining.push(waiter);
            continue;
          }
          clearTimeout(waiter.timeout);
          waiter.reject(error);
        }
        this.turnWaiters = remaining;
      }
      return;
    }

    if (message.method === "thread/compacted") {
      const remaining = [];
      for (const waiter of this.compactWaiters) {
        const threadId = message.params?.threadId;
        if (waiter.threadId && waiter.threadId !== threadId) {
          remaining.push(waiter);
          continue;
        }
        clearTimeout(waiter.timeout);
        waiter.resolve(message.params);
      }
      this.compactWaiters = remaining;
    }
  }

  handleWebSocketData(chunk) {
    this.wsBuffer = Buffer.concat([this.wsBuffer, chunk]);
    while (this.wsBuffer.length >= 2) {
      const first = this.wsBuffer[0];
      const second = this.wsBuffer[1];
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      const masked = (second & 0x80) !== 0;
      let offset = 2;
      if (length === 126) {
        if (this.wsBuffer.length < offset + 2) {
          return;
        }
        length = this.wsBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.wsBuffer.length < offset + 8) {
          return;
        }
        const bigLength = this.wsBuffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.failAll(new Error("app-server WebSocket frame is too large"));
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }
      const maskLength = masked ? 4 : 0;
      const frameEnd = offset + maskLength + length;
      if (this.wsBuffer.length < frameEnd) {
        return;
      }

      let payload = this.wsBuffer.slice(offset + maskLength, frameEnd);
      if (masked) {
        const mask = this.wsBuffer.slice(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.wsBuffer = this.wsBuffer.slice(frameEnd);

      if (opcode === 0x1) {
        this.handleRawMessage(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        this.failAll(new Error("app-server WebSocket sent close frame"));
        this.socket?.end();
        return;
      } else if (opcode === 0x9) {
        this.writeWebSocketFrame(0x0a, payload);
      }
    }
  }

  writeWebSocketFrame(opcode, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
    let header;
    if (body.length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | body.length;
    } else if (body.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    const mask = randomBytes(4);
    const masked = Buffer.alloc(body.length);
    for (let index = 0; index < body.length; index += 1) {
      masked[index] = body[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  writeMessage(payload) {
    const text = JSON.stringify(payload);
    if (this.transport === "proxy") {
      this.writeWebSocketFrame(0x1, text);
    } else {
      this.child.stdin.write(`${text}\n`);
    }
  }

  async request(method, params) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const payload = { method, id, params };
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.writeMessage(payload);
    return response;
  }

  async notify(method, params) {
    await this.ready;
    const payload = params === undefined ? { method } : { method, params };
    this.writeMessage(payload);
  }

  resetTurnState() {
    this.agentText = "";
    this.appServerErrors = [];
  }

  makeWaiter(listName, threadId, timeoutMs, timeoutMessage) {
    let waiter;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this[listName] = this[listName].filter((candidate) => candidate !== waiter);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      waiter = { resolve, reject, timeout, threadId };
      this[listName].push(waiter);
    });
    return {
      promise,
      cancel: () => {
        if (!waiter) {
          return;
        }
        clearTimeout(waiter.timeout);
        this[listName] = this[listName].filter((candidate) => candidate !== waiter);
      },
    };
  }

  waitForTurnCompleted(threadId = null) {
    return this.makeWaiter("turnWaiters", threadId, this.timeoutMs, "timed out waiting for turn/completed");
  }

  waitForThreadCompacted(threadId = null, timeoutMs = this.timeoutMs) {
    return this.makeWaiter("compactWaiters", threadId, timeoutMs, "timed out waiting for thread/compacted");
  }

  close() {
    if (this.transport === "proxy") {
      try {
        this.writeWebSocketFrame(0x8, Buffer.alloc(0));
      } catch {
        // The socket may already be closed.
      }
      this.socket?.end();
      this.socket?.destroy();
      return;
    }
    this.child?.kill();
  }
}

function defaultSocketPath() {
  return join(process.env.HOME || "", ".codex", "app-server-control", "app-server-control.sock");
}

function savedThreadId(threadFile) {
  if (!existsSync(threadFile)) {
    return null;
  }
  try {
    return readJson(threadFile).threadId || null;
  } catch {
    return null;
  }
}

async function getThread(client, { threadId, threadFile, cwd }) {
  const baseInstructions =
    "You are a Codex app-server monitor-notification handler. Respond briefly in Chinese. Do not run commands unless the user explicitly asks in the incoming message.";

  if (threadId) {
    const resumed = await client.request("thread/resume", {
      threadId,
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      baseInstructions,
    });
    return resumed.thread;
  }

  const fromFile = savedThreadId(threadFile);
  if (fromFile) {
    try {
      const resumed = await client.request("thread/resume", {
        threadId: fromFile,
        cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        baseInstructions,
      });
      return resumed.thread;
    } catch (error) {
      log(`failed to resume saved thread ${fromFile}: ${error.message}; creating a new thread`);
    }
  }

  const started = await client.request("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    baseInstructions,
  });
  const thread = started.thread;
  writeJson(threadFile, {
    threadId: thread.id,
    path: thread.path,
    cwd,
    createdAt: timestamp(),
  });
  try {
    await client.request("thread/name/set", {
      threadId: thread.id,
      name: "ChinaTravel Monitor Bridge",
    });
  } catch (error) {
    log(`thread/name/set failed for ${thread.id}: ${error.message}`);
  }
  return thread;
}

function responsePath(event) {
  const safeType = String(event.type || "event").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeJob = String(event.jobId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  return join(responsesDir, `${stamp}-${safeJob}-${safeType}.json`);
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function effortForEvent(options, event) {
  const eventType = String(event?.type || "event");
  const eventSpecific = options[`effort-${eventType}`];
  const effort = typeof eventSpecific === "string"
    ? eventSpecific
    : typeof options.effort === "string"
      ? options.effort
      : null;
  const trimmed = String(effort || "").trim();
  return trimmed || null;
}

async function readCodexRateLimits({ timeoutMs, transport, socketPath }) {
  if (transport === "proxy" && !existsSync(socketPath)) {
    throw new Error(
      `app-server control socket not found at ${socketPath}; run "codex app-server daemon bootstrap --remote-control" with a standalone Codex install, or pass --transport stdio`,
    );
  }
  const client = new AppServerClient({ timeoutMs, transport, socketPath });
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "codex-monitor-bridge",
        title: "Codex Monitor Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    await client.notify("initialized");
    return await client.request("account/rateLimits/read");
  } finally {
    client.close();
  }
}

function writeQuotaDeferred(outPath, event, { promptLength, transport, socketPath, decision, attempt }) {
  writeJson(outPath, {
    createdAt: timestamp(),
    deliveryState: "deferred_usage_limit",
    delivered: null,
    replyCompleted: false,
    attempt,
    event,
    promptLength,
    transport,
    socketPath: transport === "proxy" ? socketPath : null,
    quotaDecision: decision,
    retryAfterAt: decision.retryAfterAt,
    message: "Codex 用量限制，稍后推送。",
  });
}

async function waitForQuotaAvailability({ options, event, outPath, promptLength, timeoutMs, transport, socketPath }) {
  const config = quotaConfig(options);
  if (!config.enabled) {
    return {
      enabled: false,
      attempts: 0,
      decision: null,
    };
  }

  const startedAt = Date.now();
  const deadline = startedAt + config.maxDeferSec * 1000;
  let attempt = 0;
  while (true) {
    attempt += 1;
    let response;
    try {
      response = await readCodexRateLimits({ timeoutMs, transport, socketPath });
    } catch (error) {
      throw deliveryError(
        `could not read Codex usage before sending monitor event: ${error.message}`,
        "quotaReadFailed",
        appServerErrorsFrom(error),
        { deliveryState: "failed_quota_read" },
      );
    }

    const decision = quotaDecision(response, config);
    if (!decision.blocked) {
      return {
        enabled: true,
        attempts: attempt,
        decision,
      };
    }

    writeQuotaDeferred(outPath, event, {
      promptLength,
      transport,
      socketPath,
      decision,
      attempt,
    });
    log(`quota preflight deferred ${event.type || "event"} for job ${event.jobId || "unknown"}: ${decision.reasons.join("; ")}`);

    if (!config.deferOnLimit || !decision.retryAfterAt || decision.waitMs == null) {
      throw deliveryError(
        "Codex usage limit blocks delivery and no automatic defer is available",
        "usageLimitBlocked",
        [],
        {
          deliveryState: "blocked_usage_limit",
          quotaDecision: decision,
          retryAfterAt: decision.retryAfterAt,
        },
      );
    }
    const waitMs = Math.max(1000, decision.waitMs);
    if (Date.now() + waitMs > deadline) {
      throw deliveryError(
        `Codex usage limit reset is outside --quota-max-defer-sec (${config.maxDeferSec}s)`,
        "usageLimitDeferred",
        [],
        {
          deliveryState: "deferred_usage_limit",
          quotaDecision: decision,
          retryAfterAt: decision.retryAfterAt,
        },
      );
    }
    await delay(waitMs);
  }
}

async function compactThread(client, threadId, timeoutMs) {
  const waiter = client.waitForThreadCompacted(threadId, timeoutMs);
  waiter.promise.catch(() => {});
  try {
    await client.request("thread/compact/start", { threadId });
    await waiter.promise;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
}

async function sendTurnAndWait(client, thread, prompt, cwd, { effort = null } = {}) {
  client.resetTurnState();
  const waiter = client.waitForTurnCompleted(thread.id);
  waiter.promise.catch(() => {});
  let turnStart;
  let turnCompleted;
  try {
    const turnParams = {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: prompt,
          text_elements: [],
        },
      ],
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
    if (effort) {
      turnParams.effort = effort;
    }
    turnStart = await client.request("turn/start", turnParams);
    turnCompleted = await waiter.promise;
  } catch (error) {
    waiter.cancel();
    throw error;
  }

  const contextError = client.appServerErrors.find((entry) => isContextWindowExceeded(entry));
  if (contextError) {
    throw deliveryError(
      "app-server reported contextWindowExceeded while handling the monitor event",
      "contextWindowExceeded",
      client.appServerErrors,
    );
  }

  const usageError = client.appServerErrors.find((entry) => isUsageLimitExceeded(entry));
  if (usageError) {
    throw deliveryError(
      "app-server reported usageLimitExceeded while handling the monitor event",
      "usageLimitExceeded",
      client.appServerErrors,
    );
  }

  const terminalError = client.appServerErrors.find((entry) => entry?.willRetry === false);
  if (terminalError) {
    throw deliveryError(
      "app-server rejected the monitor event without retry",
      codexErrorInfoFrom(terminalError) || "appServerRejected",
      client.appServerErrors,
    );
  }

  const agentText = client.agentText.trim();
  if (!agentText) {
    throw deliveryError(
      "app-server completed the turn without assistant text",
      "emptyAgentText",
      client.appServerErrors,
    );
  }

  return {
    turnStart,
    turnCompleted,
    agentText,
    appServerErrors: [...client.appServerErrors],
  };
}

async function deliverOnce({ options, event, prompt, cwd, threadFile, timeoutMs, compactTimeoutMs, transport, socketPath }) {
  const explicitThreadId = typeof options["thread-id"] === "string" ? options["thread-id"] : null;
  if (transport === "proxy" && !existsSync(socketPath)) {
    throw new Error(
      `app-server control socket not found at ${socketPath}; run "codex app-server daemon bootstrap --remote-control" with a standalone Codex install, or pass --transport stdio for a detached monitor thread`,
    );
  }
  if (transport === "proxy" && !explicitThreadId) {
    throw new Error("--thread-id is required in proxy mode so the bridge does not create or target the wrong UI thread");
  }
  const client = new AppServerClient({ timeoutMs, transport, socketPath });
  let thread;
  let turnStart = null;
  let turnCompleted = null;
  let delivery = null;
  const effort = effortForEvent(options, event);
  let compactedBeforeTurn = false;
  let compactedAfterContextExceeded = false;
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "codex-monitor-bridge",
        title: "Codex Monitor Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    await client.notify("initialized");

    thread = await getThread(client, {
      threadId: explicitThreadId,
      threadFile,
      cwd,
    });

    if (options["compact-before-turn"]) {
      await compactThread(client, thread.id, compactTimeoutMs);
      compactedBeforeTurn = true;
    }

    try {
      delivery = await sendTurnAndWait(client, thread, prompt, cwd, { effort });
    } catch (error) {
      const shouldCompactAndRetry =
        options["no-compact-on-context-exceeded"] !== true && isContextWindowExceeded(error);
      if (!shouldCompactAndRetry) {
        throw error;
      }
      log(`contextWindowExceeded for thread ${thread.id}; compacting thread and retrying monitor event once`);
      await compactThread(client, thread.id, compactTimeoutMs);
      compactedAfterContextExceeded = true;
      delivery = await sendTurnAndWait(client, thread, prompt, cwd, { effort });
    }
    turnStart = delivery.turnStart;
    turnCompleted = delivery.turnCompleted;
  } finally {
    client.close();
  }

  return {
    createdAt: timestamp(),
    threadId: thread?.id || null,
    threadPath: thread?.path || null,
    turnId: turnStart?.turn?.id || turnCompleted?.turn?.id || null,
    transport,
    socketPath: transport === "proxy" ? socketPath : null,
    effort,
    event,
    promptLength: prompt.length,
    compactedBeforeTurn,
    compactedAfterContextExceeded,
    appServerErrors: delivery?.appServerErrors || [],
    agentText: delivery?.agentText || "",
    appServerStderr: client.stderr.trim(),
  };
}

function writeFailure(outPath, event, error, attempt) {
  const failure = {
    createdAt: timestamp(),
    deliveryState: error.deliveryState || "failed",
    delivered: false,
    replyCompleted: false,
    attempt,
    event,
    errorCode: error.code || error.codexErrorInfo || null,
    appServerErrors: error.appServerErrors || (error.appServerError ? [error.appServerError] : []),
    quotaDecision: error.quotaDecision || null,
    retryAfterAt: error.retryAfterAt || null,
    error: error.stack || error.message,
  };
  const failurePath = outPath.replace(/\.json$/, ".failed.json");
  writeJson(failurePath, failure);
  appendFileSync(join(monitorRoot, "app-server-failures.jsonl"), `${JSON.stringify(failure)}\n`);
  return failurePath;
}

function writePending(outPath, event, { promptLength, transport, socketPath, quotaPreflight }) {
  writeJson(outPath, {
    createdAt: timestamp(),
    deliveryState: "pending",
    delivered: null,
    replyCompleted: false,
    event,
    promptLength,
    transport,
    socketPath: transport === "proxy" ? socketPath : null,
    quotaPreflight,
    message: "Monitor event was sent to Codex; waiting for turn/completed.",
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  ensureDirs();
  const event = loadEvent(options);
  const cwd = resolve(options.cwd || repoRoot);
  const threadFile = resolve(options["thread-file"] || defaultThreadFile);
  const prompt = buildPrompt(event, options);
  const outPath = responsePath(event);

  if (options["dry-run"]) {
    writeJson(outPath, {
      dryRun: true,
      event,
      prompt,
      promptLength: prompt.length,
      createdAt: timestamp(),
    });
    console.log(JSON.stringify({ dryRun: true, output: outPath }, null, 2));
    return;
  }

  const timeoutMs = Number(options["timeout-sec"] || 180) * 1000;
  const compactTimeoutMs = Number(options["compact-timeout-sec"] || options["timeout-sec"] || 180) * 1000;
  const retryMs = Number(options["retry-sec"] || 15) * 1000;
  const maxRetries = Number(options["max-retries"] || 8);
  const transport = String(options.transport || "proxy");
  if (!["proxy", "stdio"].includes(transport)) {
    throw new Error("--transport must be proxy or stdio");
  }
  const socketPath = resolve(options.socket || defaultSocketPath());
  let quotaPreflight;
  try {
    quotaPreflight = await waitForQuotaAvailability({
      options,
      event,
      outPath,
      promptLength: prompt.length,
      timeoutMs,
      transport,
      socketPath,
    });
  } catch (error) {
    const failurePath = writeFailure(outPath, event, error, 0);
    console.error(JSON.stringify({ delivered: false, output: failurePath, errorCode: error.code || null }, null, 2));
    process.exit(1);
  }
  writePending(outPath, event, {
    promptLength: prompt.length,
    transport,
    socketPath,
    quotaPreflight,
  });
  let result;
  let lastError;
  let finalAttempt = 0;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    finalAttempt = attempt;
    try {
      result = await deliverOnce({
        options,
        event,
        prompt,
        cwd,
        threadFile,
        timeoutMs,
        compactTimeoutMs,
        transport,
        socketPath,
      });
      break;
    } catch (error) {
      lastError = error;
      log(`delivery attempt ${attempt} failed for ${event.type || "event"} job ${event.jobId || "unknown"}: ${error.message}`);
      if (attempt <= maxRetries && isRetryableDeliveryError(error)) {
        await delay(retryMs);
      } else {
        break;
      }
    }
  }

  if (!result) {
    const failurePath = writeFailure(outPath, event, lastError || new Error("delivery failed"), finalAttempt || maxRetries + 1);
    console.error(JSON.stringify({ delivered: false, output: failurePath }, null, 2));
    process.exit(1);
  }

  result.quotaPreflight = quotaPreflight;
  result.delivered = true;
  result.replyCompleted = true;
  result.deliveryState = "replied";
  writeJson(outPath, result);
  appendFileSync(join(monitorRoot, "app-server-responses.jsonl"), `${JSON.stringify(result)}\n`);
  log(`delivered ${event.type || "event"} for job ${event.jobId || "unknown"} to thread ${result.threadId}; response ${outPath}`);
  console.log(JSON.stringify({ delivered: true, output: outPath, threadId: result.threadId }, null, 2));
}

main().catch((error) => {
  ensureDirs();
  log(`bridge failed: ${error.stack || error.message}`);
  console.error(error.stack || error.message);
  process.exit(1);
});

# Codex Monitor Bridge

Codex Monitor Bridge is a small, open-source bridge for waking a specific Codex
session when a long-running remote job reaches a meaningful event, such as a
progress checkpoint, an out-of-memory failure, or completion.

It is designed for researchers, engineers, and agent builders who run expensive
experiments, evaluations, training jobs, or batch workflows and want Codex to
stay useful without actively occupying a chat turn just to watch logs.

The core idea is simple: let a lightweight local daemon monitor the job, then
send a compact, structured event back into the right Codex thread only when
there is something worth handling.

## Why This Exists

Modern AI coding assistants are increasingly used to manage work that outlives
a single interactive turn: model training, benchmark runs, CI-like experiments,
remote GPU jobs, overnight evaluations, and data pipelines. Without a monitor,
users often fall into one of two awkward patterns:

- keep an assistant turn open while it repeatedly checks logs
- leave the job unattended and manually remember to come back later

Codex Monitor Bridge offers a third pattern. The assistant can stop waiting, the
user can keep working, and Codex can be woken later with the right context when
an event actually happens.

This helps the broader agent ecosystem by making long-running work more
observable, interruptible, and reproducible without requiring every project to
invent its own one-off monitoring script.

## Core Capabilities

- Monitor an existing remote PID or launch a new remote command.
- Watch remote logs for configurable events such as progress checkpoints and
  OOM errors.
- Send event-specific prompts into a target Codex session through app-server
  remote control.
- Track whether Codex merely received the event, is still replying, completed
  the reply, or failed to produce a usable response.
- Provide a compact local dashboard for active jobs, recent completions,
  failures, and notification stages.
- Keep prompt payloads small with truncation, prompt caps, and automatic
  compact-and-retry after context-window failures.
- Use plain files for runtime state so the system is easy to inspect, debug,
  copy, and adapt.

## Who It Helps

Codex Monitor Bridge is useful for:

- ML researchers running training or evaluation jobs on remote GPU machines
- open-source maintainers who want agents to react to long tests or benchmarks
- developers using Codex as an experiment operator across multiple sessions
- agent-tool authors exploring event-driven workflows outside active turns
- teams that want transparent local automation instead of a hosted service

## What It Does

The flow is:

1. A remote command runs with `nohup`, or you attach to an existing remote PID.
2. A local daemon checks the remote PID and log at an interval.
3. When a rule matches, the daemon emits an event.
4. The bridge sends that event into a target Codex session through app-server
   remote control.
5. Codex wakes up and handles the event using the prompt template for that
   event type.

Important: this wakeup arrives as a Codex user message, not as a tool result.
Codex currently exposes `turn/start` for this kind of external wakeup, and that
API accepts user input. Tool results normally require Codex to have called a
tool first.

## Project Status

The project is currently early but usable. It was extracted from real remote
experiment workflows and is being shaped into a general-purpose utility for the
Codex community. The current focus is reliability, clear status reporting, and
safe prompt payloads for long-running jobs.

## Requirements

- Node.js 18+
- SSH access to the remote machine
- Standalone Codex CLI with app-server remote control

Check Codex:

```bash
codex --version
```

Bootstrap and start app-server remote control:

```bash
codex app-server daemon bootstrap --remote-control
codex app-server daemon start
codex app-server daemon version
```

The socket should exist:

```bash
ls -la ~/.codex/app-server-control/app-server-control.sock
```

## Files

```text
codex-monitor-bridge/
  bin/
    codex_remote_monitor_daemon.mjs
    codex_app_server_event_bridge.mjs
    codex_monitor_dashboard.mjs
  prompts/
    progress.md
    oom.md
    done.md
  rules/
    rules_with_oom.json
  README.md
  LICENSE
```

Runtime state is written under:

```text
codex-monitor-bridge/.codex-monitor/
```

Do not include `.codex-monitor/` when sharing the package. It contains local
runtime state, job logs, bridge responses, and sometimes SSHFS temporary files.

## Quick Start: Monitor An Existing Remote PID

Start your remote job however you normally do, making sure it writes an
unbuffered log:

```bash
ssh 3090 '
cd /path/to/project
source /conda/etc/profile.d/conda.sh
conda activate kg
nohup python -u train.py > /path/to/project/train.log 2>&1 &
echo $!
'
```

Then attach the monitor:

```bash
cd codex-monitor-bridge

node bin/codex_remote_monitor_daemon.mjs watch-existing \
  --host 3090 \
  --pid <REMOTE_PID> \
  --remote-dir /path/to/project \
  --remote-log /path/to/project/train.log \
  --interval-sec 30 \
  --bridge-app-server \
  --app-server-thread-id "$CODEX_THREAD_ID" \
  --rules-file rules/rules_with_oom.json \
  --app-server-prompt-template-dir prompts
```

`CODEX_THREAD_ID` is available inside a Codex session. If you run this from a
normal terminal, copy the target thread id from the Codex session context or
pass it explicitly.

## Quick Start: Launch And Monitor A Remote Command

You can also let the daemon launch the command:

```bash
cd codex-monitor-bridge

node bin/codex_remote_monitor_daemon.mjs launch-remote \
  --host 3090 \
  --remote-dir /path/to/project \
  --remote-log /path/to/project/train.log \
  --command 'source /conda/etc/profile.d/conda.sh && conda activate kg && python -u train.py' \
  --interval-sec 30 \
  --bridge-app-server \
  --app-server-thread-id "$CODEX_THREAD_ID" \
  --rules-file rules/rules_with_oom.json \
  --app-server-prompt-template-dir prompts
```

The remote command is wrapped in `nohup bash -lc ...` and the monitor returns
immediately with a local job id, local daemon PID, remote PID, and remote log
path.

## Event Rules

Rules decide when an event fires. Each event type fires once per job.

Example:

```json
{
  "rules": [
    {
      "type": "progress",
      "kind": "progressIndex",
      "index": 8,
      "total": 10,
      "message": "Run reached process [8/10]; it is close to finishing."
    },
    {
      "type": "oom",
      "kind": "regex",
      "source": "tail",
      "regex": "CUDA out of memory|OutOfMemoryError|RuntimeError:.*out of memory|Out of memory",
      "message": "The remote run appears to have hit an out-of-memory error."
    }
  ]
}
```

Supported rule kinds:

- `progressIndex`: matches log lines like `Process [8/10]`
- `regex`: matches a regular expression against either `tail` or
  `processLines`

The monitor always emits `done` when the remote PID exits.

For a quick OOM rule without a rules file:

```bash
--oom-regex 'CUDA out of memory|OutOfMemoryError|RuntimeError:.*out of memory'
```

## Prompt Templates

Events and prompts are separate:

- event: structured facts, such as `type=oom`, `pid`, `remoteLog`, and log tail
- prompt: the instruction sent to Codex for that event

With:

```bash
--app-server-prompt-template-dir prompts
```

the bridge looks for:

```text
prompts/<event-type>.md
prompts/default.md
```

So an OOM event uses `prompts/oom.md`, a completion event uses
`prompts/done.md`, and a progress event uses `prompts/progress.md`.

Useful placeholders:

```text
{{event_json}}       compact event JSON with long fields truncated
{{event_json_full}}  original event JSON; avoid this for large logs
{{event.type}}       any event field by dot path
{{message}}          top-level event message
{{tail}}             captured remote log tail, truncated by the bridge
{{remoteLog}}        remote log path
```

Example `prompts/oom.md`:

````markdown
后台监控检测到疑似 OOM。

请检查日志，并优先通过降低 batch size、gradient accumulation、序列长度或
worker 数来避免 OOM。不要改动和 OOM 无关的实验逻辑。

事件信息：

```json
{{event_json}}
```
````

## Prompt Size And Context Safety

Monitor messages should be small. Prefer sending identifiers and artifact paths,
then let Codex inspect the files after it wakes up.

The bridge now protects the target Codex thread in three ways:

- `{{event_json}}`, `{{tail}}`, and `{{event.tail}}` use a compact event object.
  Long strings are truncated before they enter the prompt.
- The full prompt is capped by `--max-prompt-chars` so an accidental verbose
  template cannot flood the context window.
- If app-server reports `contextWindowExceeded`, the bridge requests
  `thread/compact/start` on the target thread and retries the event once.

Useful size controls:

```bash
--app-server-max-tail-chars 1200
--app-server-max-process-lines-chars 1200
--app-server-max-prompt-chars 8000
```

`--app-server-compact-before-turn` is available when you intentionally want to
compact before every monitor event. In normal use, leave it off and rely on the
automatic compact-and-retry path after `contextWindowExceeded`.

For scoring or evaluation jobs, avoid monitoring a huge master log as the event
payload. Use `--remote-log` for the main progress log and `--remote-event-log`
for a short scoring log or summary log; the daemon uses the short event log for
the event tail. A completion prompt should usually mention only fields such as
`jobId`, `pid`, `remoteLog`, `remoteEventLog`, `scorePath`, and `summaryPath`,
not a full log tail.

## Reasoning Effort

The app-server protocol supports an optional reasoning effort override on
`turn/start`. Pass it through the daemon when monitor notifications do not need
the target thread's default effort:

```bash
--app-server-effort low
```

You can also override one event type:

```bash
--app-server-effort-progress low
--app-server-effort-done medium
--app-server-effort-oom medium
```

Common values are model dependent, but `low`, `medium`, and `high` are the
usual choices. Leave this unset to use the target Codex thread's current
setting.

Important: app-server describes `effort` as applying to this turn and
subsequent turns. If you send monitor events into a normal working thread, an
explicit low effort may remain selected for later manual messages in that
thread. Use this option deliberately, or use a dedicated monitor thread if you
want to avoid changing a working session's settings.

## Monitor Dashboard

For day-to-day use, start the local dashboard:

```bash
node bin/codex_monitor_dashboard.mjs --port 17888
```

Then open:

```text
http://127.0.0.1:17888
```

The dashboard shows every known monitor job with compact Chinese statuses, for
example:

- `运行`
- `完成`
- `留意`
- `异常`

It shows the current monitor state, remote PID, recent update time, notification
result, and the short target Codex thread title. Each card also includes compact
stage chips such as `进度待回复`, `进度已回复`, `完成待触发`, or `显存回复失败`,
so you can tell which monitor event fired and whether Codex actually finished
the reply for that event. Detailed paths and raw logs stay in `.codex-monitor/`
for debugging but are not shown in the main dashboard.

The dashboard opens in the `关注` view. This does not mean every listed job is
still running. It shows running jobs, failed or stale jobs, jobs that still need
attention, and jobs that completed in the last two hours. Older successful jobs
move to the `历史` view so the panel does not grow forever during normal use.
Use `全部` when you want to inspect everything. The `正在运行` metric is the true
count of active local monitor daemons.

The main progress bar shows monitor notification stages, not the raw business
progress from the remote program. For example, a job with one `progress` rule
and the final `done` event shows `提醒 1 / 2` after the progress reminder fires,
then `完成` after the done reminder fires. Exceptional rules such as `oom` are
not counted as normal stages; if they fire, the job moves to an attention state.
If a runner also prints `Process [x/y]` lines, that business progress is shown as
small supplemental text and remains available through `/api/jobs` and local
event files when debugging.

The app-server bridge writes a pending delivery record before it starts a Codex
turn. The dashboard shows this as `待回复`. After app-server emits
`turn/completed` and the assistant text is non-empty, the bridge overwrites the
record as `已回复`. If Codex is closed, interrupted, times out, or completes with
empty assistant text, the event becomes `回复失败`.

When `--job-name` is omitted, new jobs use a readable name derived from the
remote log filename instead of a bare `remote-<pid>` label whenever possible.

The `归档旧记录` button moves successful completed jobs older than 24 hours into
`.codex-monitor/archived/`. It does not delete remote logs or active monitors.
Use the CLI commands below for cancellation or manual inspection.

## Inspect Jobs

```bash
node bin/codex_remote_monitor_daemon.mjs list
node bin/codex_remote_monitor_daemon.mjs status --job <JOB_ID>
node bin/codex_remote_monitor_daemon.mjs events --job <JOB_ID> --lines 5
```

Bridge delivery records:

```text
.codex-monitor/app-server-responses.jsonl
.codex-monitor/app-server-responses/<timestamp>-<job>-<event>.json
.codex-monitor/app-server-failures.jsonl
```

Cancel only the local monitor:

```bash
node bin/codex_remote_monitor_daemon.mjs cancel --job <JOB_ID>
```

Cancel the local monitor and also kill the remote process:

```bash
node bin/codex_remote_monitor_daemon.mjs cancel --job <JOB_ID> --kill-remote
```

## Dry Run A Prompt

Preview the prompt for an event without sending it to Codex:

```bash
node bin/codex_app_server_event_bridge.mjs \
  --dry-run \
  --prompt-template-dir prompts \
  --event-json '{"jobId":"demo","type":"oom","message":"OOM","tail":"CUDA out of memory"}'
```

## Troubleshooting

If delivery fails with a missing socket, start app-server remote control:

```bash
codex app-server daemon bootstrap --remote-control
codex app-server daemon start
```

If a message appears in a separate detached thread, you are probably using
`--app-server-transport stdio`. For a real current-session wakeup, use the
default `proxy` transport and pass:

```bash
--app-server-thread-id <THREAD_ID>
```

If the remote job finishes but Codex is not notified, check:

```bash
node bin/codex_remote_monitor_daemon.mjs status --job <JOB_ID>
tail -50 .codex-monitor/<JOB_ID>.daemon.log
tail -50 .codex-monitor/app-server-bridge.log
```

If `app-server-bridge.log` contains `contextWindowExceeded`, the bridge should
compact the target thread and retry once. If the retry still fails, the event is
recorded under:

```text
.codex-monitor/app-server-failures.jsonl
.codex-monitor/app-server-responses/<timestamp>-<job>-<event>.failed.json
```

An empty assistant response is also treated as delivery failure, because it can
mean app-server rejected the input before Codex produced a real turn.

## Roadmap

The project is actively evolving around practical long-running-agent workflows.
Planned work includes:

- **Richer remote diagnostics**: persist SSH failures, remote PID state, log
  readability, and last successful remote check so the dashboard can distinguish
  "remote unreachable" from "daemon stopped" and "job finished without event".
- **Configurable event taxonomies**: let users define which events are normal
  stages, warnings, failures, retries, or recovery actions instead of relying on
  built-in names like `progress`, `oom`, and `done`.
- **Safer retry and recovery flows**: support event-specific retry policies,
  recovery prompts, and optional follow-up actions such as lowering batch size
  after OOM or launching the next experiment after successful completion.
- **Portable project templates**: provide examples for ML training,
  benchmarking, data processing, and CI-style workflows so new users can adapt
  the bridge without reading all internals first.
- **Dashboard polish**: add better filtering, accessible status labels,
  archived-job browsing, and clearer "needs attention" summaries for many
  concurrent monitors.
- **Packaging improvements**: add npm-friendly metadata, versioned releases,
  and installation scripts for users who do not want to copy the repository
  manually.
- **Codex integration tracking**: follow Codex app-server changes and update
  the bridge when more direct monitor, automation, or tool-result primitives
  become available.

## Community Value

This project aims to make agent-driven development more useful for workflows
that do not fit into a short request-response loop. The monitor bridge is small
on purpose: it is inspectable, file-based, and easy to adapt for local policies
or private infrastructure.

Potential community benefits include:

- a reference pattern for event-driven Codex workflows
- reusable monitor rules and prompt templates for common long-running tasks
- better UX expectations around agent wakeups, reply completion, and failure
  visibility
- a practical example of combining local daemons, remote jobs, and Codex
  app-server control without a hosted backend

Contributions are welcome in the form of bug reports, monitor rules, prompt
templates, dashboard improvements, documentation examples, and portability
fixes for different shells or remote environments.

## Design Notes

This package deliberately keeps monitoring outside the active Codex turn. The
daemon is a normal local background process. It polls the remote log/PID, and
only contacts Codex when an event fires.

That means Codex is free between events, and the user can keep chatting or work
in other sessions. When the monitor event fires, Codex receives a new turn in
the specified session.

## License

Codex Monitor Bridge is released under the MIT License. See [LICENSE](LICENSE).

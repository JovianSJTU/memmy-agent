# Computer History shared recording core

## Modules

| Module | Responsibility |
| --- | --- |
| `platform.ts` | Native collector preparation, process launch, optional screenshot capture, stop gesture, permission UI and application icons. These are the injected OS boundary. |
| `capture-process.ts` | Validate the helper stream, wait for ready, supervise heartbeat, serialize messages, drain on stop, escalate timeouts and reject abnormal exits. |
| `recording-pipeline.ts` | Observation policy, password/credential filtering, text bursts, authorized UI deltas, v2 JSONL and segment sequence continuity. |
| `recorder.ts` | Host a pipeline and collector in the Node recorder process; expose readiness and graceful shutdown to the parent service through IPC. |
| `history-service.ts` | Observation state, ten-minute segmentation, pause/resume/rotation, retention, pinning, summaries and history/workflow APIs. |
| `summarize-history.ts`, `summary-writer.ts`, `rollup.ts` | v1/v2 readers, summary evidence and model narration, six-hour summaries. |

## Platform integration

A platform recorder entry point calls `runRecorder(args, platform)` with a
`CapturePlatform`. `prepare()` performs native permission checks and prepares
the helper before returning a `PreparedCollector`. `start()` launches a fresh
helper with stdin/stdout/stderr pipes. stdout must contain only capture protocol
v1 NDJSON. The collector does not write history files.

The `HistoryServicePlatform` provides the recorder command, permission actions
and icon lookup. Construct `ComputerHistoryService({ platform, ...paths })` to
reuse the same service on another OS. The existing desktop permission fields
remain logical capabilities; a Windows adapter must report whether it can
capture UI and input, rather than trying to open macOS permission settings.

The core uses `application.id` (`bundle:`, `exe:`, or `aumid:`) and semantic
`UiNode.role`. Browser/system-surface classification belongs to the collector.
Legacy AX names and bundle IDs remain supported only for old records and
compatibility normalization APIs. `nativeRole` is diagnostic information, not
the basis for decisions about new protocol events.

## Two process boundaries

1. **Service → Node recorder**: start the platform entry point with an IPC
   channel. The recorder emits
   `{type: "computer-history-ready", runId, controlProtocol: 1}` after helper
   readiness and startup persistence. Send `{type: "computer-history-stop"}`
   to stop without relying on POSIX signals. This is used for pause, rotation
   and service shutdown. Legacy recorders without `controlProtocol` retain the
   signal fallback.
2. **Node recorder → native helper**: protocol v1 ready/event/gap/heartbeat/
   stopped messages and the stdin `{v: 1, type: "stop"}` command. The default
   ready timeout is 10 seconds and inactivity timeout is 90 seconds. Graceful
   shutdown waits 8 seconds, then SIGTERM/termination and SIGKILL with two-second
   bounds each. Forced termination is reported as failure if the protocol did
   not complete. The service allows 15 seconds for this drain before its own
   force-kill fallback.

## Mac compatibility and verification

`mac/record-human-history.ts` owns Swift compilation, permissions, screencapture,
Mac stop-key matching and legacy CLI bundle ID normalization. Mac API and summary
entry points remain as wrappers, so existing desktop routes and packaged paths
continue to work. No live OS capture runs in automated tests.

Tests in `tests/tools/computer-history/core` exercise Windows-shaped events,
protocol failures and real Node IPC across service → recorder → simulated
collector. Existing Mac tests cover native fixture semantics, policy changes,
rotation/recovery and v1 readers. The actual Windows C#/FlaUI collector and its
desktop registration are separate work and are not implemented here.

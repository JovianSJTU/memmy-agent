import readline from "node:readline";
import { CaptureStreamSession } from "./capture-session.js";
import type { CaptureMessage, CaptureEvent } from "./capture-protocol.js";
import type { PreparedCollector } from "./platform.js";

export interface CaptureProcessOptions {
  platform: "macos" | "windows";
  readyTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  stopTimeoutMs?: number;
  killTimeoutMs?: number;
  isStopEvent(event: CaptureEvent): boolean;
  onReady(message: Extract<CaptureMessage, { type: "ready" }>): Promise<void>;
  onEvent(event: CaptureEvent): Promise<void>;
  onGap(message: Extract<CaptureMessage, { type: "gap" }>): Promise<void>;
  onStderr?(text: string): void;
}

/** Supervise one protocol run, independent of the native collector or storage. */
export function startCaptureProcess(collector: PreparedCollector, options: CaptureProcessOptions) {
  const child = collector.start();
  const session = new CaptureStreamSession();
  let failure: Error | null = null;
  let closed = false;
  let stopping = false;
  let requestedReason: string | null = null;
  let stoppedReason: string | null = null;
  let queue = Promise.resolve();
  let stopPromise: Promise<void> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveDone!: (reason: string) => void;
  let rejectDone!: (error: Error) => void;
  let resolveClosed!: () => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise<string>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const childClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  // Either promise may reject before the caller starts awaiting it.
  void ready.catch(() => undefined);
  void done.catch(() => undefined);

  const waitForClose = async (milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        childClosed.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const clearTimers = () => {
    clearTimeout(readyTimer);
    clearTimeout(heartbeatTimer);
  };
  const stop = (reason = "user_interrupt"): Promise<void> => {
    if (stopPromise) return stopPromise;
    requestedReason = reason;
    stopping = true;
    clearTimers();
    stopPromise = (async () => {
      if (!closed && !session.isStopped && child.stdin?.writable) {
        child.stdin.write(`${JSON.stringify({ v: 1, type: "stop" })}\n`);
      }
      if (!await waitForClose(options.stopTimeoutMs ?? 8_000)) {
        child.kill("SIGTERM");
        if (!await waitForClose(options.killTimeoutMs ?? 2_000)) {
          child.kill("SIGKILL");
          if (!await waitForClose(options.killTimeoutMs ?? 2_000)) {
            const error = new Error("capture helper did not exit after SIGKILL");
            rejectReady(error);
            rejectDone(error);
            throw error;
          }
        }
      }
      await done;
    })();
    void stopPromise.catch(() => undefined);
    return stopPromise;
  };
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    rejectReady(failure);
    void stop("capture_error");
  };
  const armHeartbeat = () => {
    clearTimeout(heartbeatTimer);
    if (closed || stopping || session.isStopped) return;
    heartbeatTimer = setTimeout(() => fail(new Error("capture helper heartbeat timed out")), options.heartbeatTimeoutMs ?? 90_000);
    heartbeatTimer.unref?.();
  };
  const accept = async (line: string) => {
    if (failure) return;
    const message = session.accept(line);
    armHeartbeat();
    switch (message.type) {
      case "ready":
        if (message.platform !== options.platform) throw new Error(`expected ${options.platform} helper, got ${message.platform}`);
        await options.onReady(message);
        clearTimeout(readyTimer);
        resolveReady();
        break;
      case "event":
        if (options.isStopEvent(message)) void stop("stop_hotkey");
        else await options.onEvent(message);
        break;
      case "gap": await options.onGap(message); break;
      case "fatal": throw new Error(`capture helper ${message.code}: ${message.message}`);
      case "stopped":
        clearTimers();
        stoppedReason = message.reason === "hotkey" ? "stop_hotkey"
          : message.reason === "permission_lost" ? "permission_lost" : requestedReason ?? "user_interrupt";
        // A valid stopped message must be followed by process termination.
        void stop(stoppedReason);
        break;
      case "heartbeat": break;
    }
  };
  const readyTimer = setTimeout(() => fail(new Error("capture helper ready handshake timed out")), options.readyTimeoutMs ?? 10_000);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line: string) => { queue = queue.then(() => accept(line)).catch(fail); });
  child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8")));
  child.stdin?.on("error", (error) => { if (!session.isStopped && !closed) fail(error); });
  child.once("error", fail);
  child.once("close", (code, signal) => {
    closed = true;
    clearTimers();
    resolveClosed();
    void queue.then(() => {
      if (failure) throw failure;
      if (!session.currentRunId) throw new Error(`capture helper exited before ready (${code ?? signal ?? "unknown"})`);
      if (!session.isStopped) throw new Error("capture helper exited without a stopped message");
      if ((typeof code === "number" && code !== 0) || signal) throw new Error(`capture helper exited abnormally (${code ?? signal})`);
      resolveDone(stoppedReason ?? requestedReason ?? "user_interrupt");
    }).catch((error: Error) => { rejectReady(error); rejectDone(error); });
  });
  return { ready, done, stop, fail };
}

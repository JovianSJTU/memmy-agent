import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCaptureProcess } from "../../../../src/tools/computer-history/core/capture-process.js";

const runId = "c16d2b43-2a78-4992-b96f-707a98d48f73";
const ready = { v: 1, type: "ready", runId, platform: "windows", capabilities: ["pointer"] };
const stopped = { v: 1, type: "stopped", runId, lastSequence: 0, reason: "requested" };
function fixture(options: Partial<Parameters<typeof startCaptureProcess>[1]> = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const onReady = vi.fn(async () => {});
  const capture = startCaptureProcess({ display: { width: 1, height: 1 },
    start: () => child as unknown as ChildProcessWithoutNullStreams,
  }, { platform: "windows", onReady, onEvent: async () => {}, onGap: async () => {},
    isStopEvent: () => false, readyTimeoutMs: 100, heartbeatTimeoutMs: 200,
    stopTimeoutMs: 50, killTimeoutMs: 25, ...options,
  });
  return { child, capture, onReady, send: (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`),
    close: (code = 0) => { child.stdout.end(); child.emit("close", code, null); } };
}
afterEach(() => vi.useRealTimers());
describe("platform-independent collector supervision", () => {
  it("waits for ready and drains the final message before accepting process close", async () => {
    const f = fixture();
    expect(f.onReady).not.toHaveBeenCalled();
    f.send(ready);
    await f.capture.ready;
    const commands: string[] = [];
    f.child.stdin.on("data", (data) => commands.push(String(data)));
    const stop = f.capture.stop("user_stop");
    f.send(stopped);
    f.close();
    await expect(f.capture.done).resolves.toBe("user_stop");
    await stop;
    expect(commands).toEqual(['{"v":1,"type":"stop"}\n']);
  });

  it.each([
    [{ ...ready, platform: "macos" }, /expected windows/],
    [{ ...ready, v: 2 }, /version/],
    [{ v: 1, type: "heartbeat", runId, lastSequence: 0 }, /ready first/],
  ])("rejects invalid startup %j", async (message, error) => {
    const f = fixture();
    f.send(message);
    f.close();
    await expect(f.capture.ready).rejects.toThrow(error as RegExp);
    await expect(f.capture.done).rejects.toThrow(error as RegExp);
  });

  it("fails an abnormal exit even after a valid stopped message", async () => {
    const f = fixture();
    f.send(ready);
    await f.capture.ready;
    f.send(stopped);
    f.close(2);
    await expect(f.capture.done).rejects.toThrow(/abnormally/);
  });

  it("reports spawn failure and missing stopped messages", async () => {
    const f = fixture();
    f.child.emit("error", new Error("ENOENT: missing collector"));
    f.close(1);
    await expect(f.capture.done).rejects.toThrow(/ENOENT/);
    const g = fixture();
    g.send(ready);
    await g.capture.ready;
    g.close();
    await expect(g.capture.done).rejects.toThrow(/without a stopped/);
  });

  it("times out readiness and escalates a stuck process without hanging", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = expect(f.capture.done).rejects.toThrow(/SIGKILL/);
    await vi.advanceTimersByTimeAsync(201);
    await expect(f.capture.ready).rejects.toThrow(/ready handshake timed out/);
    await result;
    expect(f.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    f.close(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes the watchdog on heartbeat and rejects silence", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.send(ready);
    await f.capture.ready;
    await vi.advanceTimersByTimeAsync(150);
    f.send({ v: 1, type: "heartbeat", runId, lastSequence: 0 });
    await vi.advanceTimersByTimeAsync(150);
    expect(f.child.stdin.read()).toBeNull();
    await vi.advanceTimersByTimeAsync(51);
    expect(String(f.child.stdin.read())).toContain('"stop"');
    f.close(1);
    await expect(f.capture.done).rejects.toThrow(/heartbeat timed out/);
    expect(vi.getTimerCount()).toBe(0);
  });
});

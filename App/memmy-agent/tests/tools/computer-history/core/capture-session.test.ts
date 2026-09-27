import { describe, expect, it } from "vitest";
import { CaptureProtocolError } from "../../../../src/tools/computer-history/core/capture-protocol.js";
import { CaptureStreamSession, captureEventToLegacy } from "../../../../src/tools/computer-history/core/capture-session.js";

const runId = "c16d2b43-2a78-4992-b96f-707a98d48f73";
const ready = JSON.stringify({ v: 1, type: "ready", runId, platform: "macos", capabilities: ["pointer", "keyboard", "ui_tree", "browser_url"] });
const context = {
  application: { id: "bundle:com.example.App", idKind: "bundle_id", name: "Example", pid: 42 },
  window: { id: "pid:42:window:1", title: "Example", isBrowser: false, page: { state: "unknown" } },
  privacy: { secureInput: false, passwordTarget: false, privateWindow: "unknown", systemSurface: false },
} as const;

describe("CaptureStreamSession", () => {
  it("requires ready and checks contiguous events, gaps, heartbeats and stop", () => {
    const session = new CaptureStreamSession();
    expect(() => session.accept(JSON.stringify({ v: 1, type: "heartbeat", runId, lastSequence: 0 })))
      .toThrow(CaptureProtocolError);
    expect(session.accept(ready).type).toBe("ready");
    session.accept(JSON.stringify({ v: 1, type: "event", runId, sequence: 1, occurredAt: "2026-09-24T08:20:03Z", kind: "window.changed", context, data: {} }));
    session.accept(JSON.stringify({ v: 1, type: "gap", runId, fromSequence: 2, toSequence: 3, reason: "overflow" }));
    session.accept(JSON.stringify({ v: 1, type: "heartbeat", runId, lastSequence: 3 }));
    session.accept(JSON.stringify({ v: 1, type: "stopped", runId, lastSequence: 3, reason: "requested" }));
    expect(session.currentSequence).toBe(3);
    expect(session.isStopped).toBe(true);
    expect(() => session.accept(JSON.stringify({ v: 1, type: "heartbeat", runId, lastSequence: 3 })))
      .toThrow(/after stopped/);
  });

  it("rejects sequence skips and a helper changing its run ID", () => {
    const session = new CaptureStreamSession();
    session.accept(ready);
    expect(() => session.accept(JSON.stringify({ v: 1, type: "event", runId, sequence: 2, occurredAt: "2026-09-24T08:20:03Z", kind: "window.changed", context, data: {} })))
      .toThrow(/does not follow/);
    expect(() => session.accept(JSON.stringify({ v: 1, type: "heartbeat", runId: "d16d2b43-2a78-4992-b96f-707a98d48f73", lastSequence: 0 })))
      .toThrow(/changed runId/);
  });

  it("maps protocol events into the existing Mac recorder semantics", () => {
    const legacy = captureEventToLegacy({
      v: 1, type: "event", runId, sequence: 7, occurredAt: "2026-09-24T08:20:03Z",
      kind: "pointer.click", context, data: {
        button: "right", clickCount: 1,
        target: { element: { role: "button", nativeRole: "AXButton", name: "Open", isPassword: false } },
      },
    });
    expect(legacy).toMatchObject({
      kind: "mouse.context_menu", app: { bundleIdentifier: "com.example.App" },
      mouse: { button: "right", target: { role: "AXButton", title: "Open" } },
      captureSource: { runId, sequence: 7 },
    });
  });

  it("never forwards selected text from a secure or password target", () => {
    const sensitiveContext = { ...context,
      privacy: { ...context.privacy, secureInput: false, passwordTarget: true } };
    const legacy = captureEventToLegacy({
      v: 1, type: "event", runId, sequence: 8, occurredAt: "2026-09-24T08:20:03Z",
      kind: "selection.changed", context: sensitiveContext, data: {
        selectedText: "do-not-retain", target: { element: { role: "text_field", isPassword: true } },
      },
    });
    expect(legacy.selection.selectedText).toBeNull();
    expect(JSON.stringify(legacy)).not.toContain("do-not-retain");
  });
});

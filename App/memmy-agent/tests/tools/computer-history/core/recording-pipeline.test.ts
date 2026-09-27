import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRecordingPipeline, type RecorderArgs } from "../../../../src/tools/computer-history/core/recording-pipeline.js";
import type { CaptureEvent, CaptureContext, UiNode } from "../../../../src/tools/computer-history/core/capture-protocol.js";
import { compactEventEvidence } from "../../../../src/tools/computer-history/core/summary-writer.js";
import { summarizeToFile } from "../../../../src/tools/computer-history/core/summarize-history.js";

const runId = "c16d2b43-2a78-4992-b96f-707a98d48f73";
const appId = "exe:c:\\program files\\example\\example.exe";
const context: CaptureContext = {
  application: { id: appId, idKind: "exe_path", name: "Example", pid: 42 },
  window: { id: "hwnd:1001", title: "Example", isBrowser: false, page: { state: "unknown" } },
  privacy: { secureInput: false, passwordTarget: false, privateWindow: "unknown", systemSurface: false },
};
let directory: string;
let pipeline: Awaited<ReturnType<typeof createRecordingPipeline>>;
let sequence: number;
const settings = { observation: { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [] } };
const event = (kind: CaptureEvent["kind"], data: unknown, ctx = context) => ({
  v: 1, type: "event", runId, sequence: ++sequence, occurredAt: "2026-09-27T10:00:00Z", kind, data, context: ctx,
}) as CaptureEvent;
const args = (): RecorderArgs => ({ out: path.join(directory, "events.jsonl"),
  observationSettings: path.join(directory, "settings.json"), allowApps: [appId], onlyApps: [],
  captureText: true, captureSearchText: true, screenshots: false });
const records = () => fs.readFileSync(args().out!, "utf8").trim().split("\n").map(line => JSON.parse(line));
async function create() {
  pipeline = await createRecordingPipeline(args(), { platform: "windows", defaultTitle: "Windows workflow",
    display: { width: 100, height: 100 }, onFailure: vi.fn() });
  await pipeline.start();
}
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "recording-core-"));
  sequence = 0;
  fs.writeFileSync(args().observationSettings!, JSON.stringify(settings));
  await create();
});
afterEach(() => { pipeline.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });

it("writes Windows IDs, semantic drag targets and merged text through the shared writer and readers", async () => {
  const target = { element: { role: "search_field", name: "Search", nativeRole: "UIA_EditControlTypeId", isPassword: false } };
  await pipeline.event(event("keyboard.text", { text: "hello ", target }));
  await pipeline.event(event("ui.snapshot", { windowKey: "1", nodes: [target.element] }));
  await pipeline.event(event("keyboard.text", { text: "world", target }));
  await pipeline.event(event("pointer.drag", { origin: target, destination: { element: { role: "button", name: "Save", isPassword: false } } }));
  await pipeline.stop("user_stop");
  const rows = records();
  expect(rows[0]).toMatchObject({ platform: "windows", schemaVersion: 2 });
  const text = rows.filter(row => row.eventType === "text_input");
  expect(text).toHaveLength(1);
  expect(text[0]).toMatchObject({ application: { id: appId }, details: { text: "hello world", characterCount: 11 } });
  expect(rows.find(row => row.eventType === "mouse_drag").details).toMatchObject({
    origin: { role: "search_field" }, destination: { role: "button", name: "Save" },
  });
  expect(compactEventEvidence(fs.readFileSync(args().out!, "utf8").trim().split("\n"))).toContain("hello world");
  const summary = path.join(directory, "summary.md");
  summarizeToFile({ file: args().out!, out: summary });
  expect(fs.readFileSync(summary, "utf8")).toContain(JSON.stringify(appId));
});

it("applies normalized application policy live and never emits excluded or password content", async () => {
  const target = { element: { role: "text_field", name: "Password", value: "password-value", isPassword: true } };
  await pipeline.event(event("keyboard.text", { text: "password-typed", target }));
  await pipeline.event(event("selection.changed", { selectedText: "password-selection", target }));
  await pipeline.event(event("pointer.click", { button: "left", clickCount: 1, target }));
  await pipeline.event(event("keyboard.text", { text: "pending excluded", target: null }));
  fs.writeFileSync(args().observationSettings!, JSON.stringify({ observation: { ...settings.observation,
    rules: [{ scope: "app", applicationId: appId, behavior: "do_not_observe" }],
  } }));
  await pipeline.event(event("ui.snapshot", { windowKey: "1", nodes: [{ role: "text", name: "excluded snapshot", isPassword: false }] }));
  await pipeline.stop("user_stop");
  const raw = fs.readFileSync(args().out!, "utf8");
  expect(raw).not.toMatch(/password-(value|typed|selection)|pending excluded|excluded snapshot/);
  expect(records().filter(row => row.eventType === "text_input")).toHaveLength(0);
});

it("requires fresh full UI after a gap or excluded interval and preserves sequence on resume", async () => {
  const nodes: UiNode[] = Array.from({ length: 10 }, (_, index) => ({ role: "text", name: `item ${index}`, isPassword: false }));
  const snapshot = (items: UiNode[]) => pipeline.event(event("ui.snapshot", { windowKey: "1", nodes: items }));
  await snapshot(nodes);
  const changed = [...nodes, { role: "button", name: "Save", isPassword: false }];
  await snapshot(changed);
  await pipeline.gap({ runId, fromSequence: 3, toSequence: 3, reason: "overflow" });
  await snapshot(changed);
  const blocked = { ...context, privacy: { ...context.privacy, systemSurface: true } };
  await pipeline.event(event("ui.snapshot", { windowKey: "1", nodes: [{ role: "text", name: "system-surface", isPassword: false }] }, blocked));
  await snapshot(changed);
  await pipeline.stop("user_stop");
  expect(records().filter(row => row.ui).map(row => row.ui.mode)).toEqual(["full", "diff", "full", "full"]);
  expect(fs.readFileSync(args().out!, "utf8")).not.toContain("system-surface");
  pipeline.dispose();
  await create();
  await snapshot(nodes);
  await pipeline.stop("user_stop");
  const numbers = records().filter(row => row.recordType === "human_event").map(row => row.sequence);
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => index + 1));
});

it("treats a browser with unknown URL as unobservable under website restrictions", async () => {
  fs.writeFileSync(args().observationSettings!, JSON.stringify({ observation: { ...settings.observation,
    rules: [{ scope: "url", urlDomain: "bank.com", behavior: "do_not_observe" }],
  } }));
  await pipeline.event(event("keyboard.text", { text: "unknown website", target: null }, {
    ...context, window: { ...context.window, isBrowser: true },
  }));
  await pipeline.stop("user_stop");
  expect(records().filter(row => row.eventType === "text_input")).toHaveLength(0);
});

it("propagates persistence failure to supervision instead of continuing silently", async () => {
  fs.unlinkSync(args().out!);
  fs.mkdirSync(args().out!);
  await expect(pipeline.event(event("window.changed", {}))).rejects.toMatchObject({ code: "EISDIR" });
});

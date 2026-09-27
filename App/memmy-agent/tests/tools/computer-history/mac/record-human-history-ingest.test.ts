import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test, vi } from "vitest";
import { nativePrivacyFixture } from "./native-privacy-fixture.js";
import { normalizeHistoryRecord } from "../../../../src/tools/computer-history/core/history-format.js";

const helper = vi.hoisted(() => ({
  events: [] as Record<string, any>[],
  afterEvent: undefined as ((index: number) => void) | undefined,
  onCommand: undefined as ((command: string, args: string[]) => void) | undefined,
}));
const fixtureRunId = "9d303f41-d994-4f5c-a907-5fb6e5fbe111";

function fixtureProtocolMessages(event: Record<string, any>, sequence: { value: number }): Record<string, any>[] {
  const app = event.app ?? { name: "Notes", bundleIdentifier: "com.apple.Notes", secureInput: false };
  const window = event.window ?? {};
  const bundleId = app.bundleIdentifier ?? "com.example.fixture";
  const context = {
    application: { id: `bundle:${bundleId}`, idKind: "bundle_id", name: app.name ?? "Fixture",
      pid: Number.isInteger(app.pid) && app.pid > 0 ? app.pid : 100 },
    window: { id: window.id ?? "fixture-window", title: window.title ?? null,
      // Match the Mac collector: browser identity is emitted by the platform,
      // including when the current URL is unavailable.
      isBrowser: window.browser === true || bundleId === "com.google.Chrome",
      page: typeof window.url === "string"
        ? { state: "known", url: window.url.replace(/[?#].*$/, "") }
        : { state: "unknown" } },
    privacy: { secureInput: app.secureInput === true, passwordTarget: false,
      privateWindow: window.privateBrowsing === true ? "yes" : "unknown", systemSurface: false },
  };
  const messages: Record<string, any>[] = [];
  const toNode = (value: Record<string, any>) => {
    const nativeRole = value.role ?? value.subrole ?? "AXUnknown";
    const password = nativeRole === "AXSecureTextField" || value.subrole === "AXSecureTextField";
    const role = ({ AXSearchField: "search_field", AXTextField: "text_field", AXButton: "button",
      AXStaticText: "text", AXLink: "link", AXWebArea: "document" } as Record<string, string>)[nativeRole] ?? "unknown";
    return { role, nativeRole, isPassword: password,
      ...(value.title ? { name: value.title } : {}),
      ...(value.description ? { description: value.description } : {}),
      ...(value.identifier ? { automationId: value.identifier } : {}),
      ...(!password && value.value ? { value: value.value } : {}) };
  };
  const toTarget = (value: Record<string, any> | null | undefined) => {
    if (!value) return null;
    const target = value.element ? value : { element: value };
    return { element: target.element ? toNode(target.element) : null,
      ...(target.ancestors ? { ancestors: target.ancestors.map(toNode) } : {}),
      ...(target.descendants ? { descendants: target.descendants.map(toNode) } : {}) };
  };
  const pushEvent = (kind: string, data: Record<string, any> = {}) => messages.push({
    v: 1, type: "event", runId: fixtureRunId, sequence: ++sequence.value,
    occurredAt: event.timestamp ?? "2026-09-24T00:00:00Z", kind, context, data,
  });
  if (event.gapBefore) {
    messages.push({ v: 1, type: "gap", runId: fixtureRunId,
      fromSequence: sequence.value + 1, toSequence: sequence.value + 1, reason: "overflow" });
    sequence.value += 1;
  }
  if (event.ax?.mode !== "diffFromPrevious" && typeof event.ax?.text === "string") {
    const nodes = event.ax.text.split("\n").filter(Boolean).map((line: string) => {
      const fields = line.replace(/^[+-] /, "").split("|");
      return toNode({ role: fields[0] || "AXUnknown", subrole: fields[1], title: fields[2],
        description: fields[3], identifier: fields[4], value: fields[5] });
    });
    pushEvent("ui.snapshot", { windowKey: event.ax.windowKey ?? "fixture-window", nodes });
  }
  switch (event.kind) {
    case "session.started":
    case "window.changed": pushEvent("window.changed"); break;
    case "page.changed": pushEvent("page.changed"); break;
    case "mouse.click":
    case "mouse.context_menu": pushEvent("pointer.click", {
      button: event.kind === "mouse.context_menu" ? "right" : event.mouse?.button ?? "left",
      clickCount: event.mouse?.clickCount ?? 1, target: null,
    }); break;
    case "keyboard.text_input":
      if (app.secureInput !== true && event.keyboard?.target?.subrole !== "AXSecureTextField") {
        pushEvent("keyboard.text", { text: event.keyboard?.text ?? "", target: toTarget(event.keyboard?.target) });
      }
      break;
    case "keyboard.shortcut": pushEvent("keyboard.shortcut", {
      key: event.keyboard?.keyEquivalent ?? "c",
      modifiers: (event.keyboard?.modifiers ?? []).map((value: string) => value === "cmd" ? "meta" : value === "option" ? "alt" : value),
      target: toTarget(event.keyboard?.target),
    }); break;
    case "keyboard.submit": pushEvent("keyboard.submit", { target: null }); break;
    case "selection.changed": pushEvent("selection.changed", {
      selectedText: event.selection?.selectedText ?? null, target: null,
    }); break;
    default: break;
  }
  return messages;
}

vi.mock("../../../../src/tools/computer-history/mac/native-helper.js", () => ({
  ensureNativeHistoryHelper: async () => "/fixture/human-recorder",
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, {
    value: async (command: string, args: string[]) => {
      helper.onCommand?.(command, args);
      return { stdout: JSON.stringify({ inputMonitoring: true, screenRecording: true,
        accessibility: true, mainDisplayWidth: 100, mainDisplayHeight: 100 }), stderr: "" };
    },
  });
  return {
    ...actual,
    execFile,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
        kill() { this.killed = true; return true; },
      });
      setImmediate(async () => {
        child.stdout.write(`${JSON.stringify({ v: 1, type: "ready", runId: fixtureRunId,
          platform: "macos", capabilities: ["pointer", "keyboard", "ui_tree", "selected_text", "browser_url", "private_window_detection"] })}\n`);
        const sequence = { value: 0 };
        for (const [index, event] of helper.events.entries()) {
          for (const message of fixtureProtocolMessages(event, sequence)) {
            child.stdout.write(`${JSON.stringify(message)}\n`);
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          helper.afterEvent?.(index);
        }
        child.stdout.write(`${JSON.stringify({ v: 1, type: "stopped", runId: fixtureRunId,
          lastSequence: sequence.value, reason: "requested" })}\n`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        child.stdout.end();
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    },
  };
});

import { isStopHotkey, run } from "../../../../src/tools/computer-history/mac/record-human-history.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let directory: string;
let existingSignals: Map<string, ((...args: unknown[]) => unknown)[]>;
beforeEach(() => {
  helper.afterEvent = undefined;
  helper.onCommand = undefined;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-ingest-"));
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  existingSignals = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, process.listeners(signal)]));
});
afterEach(() => {
  for (const [signal, original] of existingSignals) {
    for (const listener of process.listeners(signal)) {
      if (!original.includes(listener)) process.removeListener(signal, listener);
    }
  }
  Object.defineProperty(process, "platform", platform);
  fs.rmSync(directory, { recursive: true, force: true });
});

const app = { name: "Notes", bundleIdentifier: "com.apple.Notes", secureInput: false };
const stableLines = Array.from({ length: 10 }, (_, index) => `AXStaticText||Stable ${index}|||`);
const full = { mode: "fullTree", windowKey: "fixture-window", text: [...stableLines, "AXStaticText||Original document|||"].join("\n") };
const first = { mode: "diffFromPrevious", windowKey: full.windowKey, text: "+ AXStaticText||First change|||" };
const second = { mode: "diffFromPrevious", windowKey: full.windowKey, text: "+ AXStaticText||Second change|||" };
const third = { mode: "diffFromPrevious", windowKey: full.windowKey, text: "+ AXStaticText||Shortcut result|||" };
const firstTree = { ...full, text: `${full.text}\n${first.text.slice(2)}` };
const secondTree = { ...full, text: `${firstTree.text}\n${second.text.slice(2)}` };
const thirdTree = { ...full, text: `${secondTree.text}\n${third.text.slice(2)}` };
async function record(policy?: unknown, { screenshots = false, flags = [] as string[] } = {}) {
  const output = path.join(directory, "events.jsonl");
  const args = ["node", "test", "--out", output, ...flags];
  if (!screenshots) args.push("--no-screenshots");
  if (policy) {
    const settingsFile = path.join(directory, "settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify(policy));
    args.push("--observation-settings", settingsFile);
  }
  await run(args);
  return fs.readFileSync(output, "utf8").trim().split("\n")
    .map((line) => normalizeHistoryRecord(JSON.parse(line)));
}

test("resuming a segment preserves increasing disk sequence numbers", async () => {
  helper.events = [{ kind: "session.started", app, ax: full }];
  const firstRun = await record();
  const previousLast = firstRun.filter((event) => event.recordType === "human_event").at(-1)!.sequence;
  const resumed = await record();
  const sequences = resumed.filter((event) => event.recordType === "human_event").map((event) => event.sequence);
  assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));
  assert.ok(sequences.at(-1)! > previousLast);
});

test("persists startup fullTree and every diff across input bursts and shortcuts", async () => {
  helper.events = [
    { kind: "session.started", app, ax: full },
    { kind: "keyboard.text_input", app, keyboard: { text: "a" }, ax: firstTree },
    { kind: "keyboard.text_input", app, keyboard: { text: "b" }, ax: secondTree },
    { kind: "keyboard.text_input", app, keyboard: { text: "c" } },
    { kind: "keyboard.shortcut", app, keyboard: { keyEquivalent: "c", modifiers: ["cmd"] }, ax: thirdTree },
  ];
  const events = await record();
  assert.deepEqual(events.filter((event) => event.ax).map((event) => event.ax), [full, first, second, third]);
  assert.equal(events.find((event) => event.eventType === "text_input")!.details.characterCount, 3);
  assert.equal(events.find((event) => event.eventType === "recording_started")!.schemaVersion, 1);
  assert.equal(events.some((event) => event.eventType === "application_changed"), true);
  const persisted = fs.readFileSync(path.join(directory, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(persisted[0].recordType, "human_history_metadata");
  assert.equal(persisted[0].schemaVersion, 2);
  assert.equal(persisted[0].platform, "macos");
  assert.ok(persisted.slice(1).every((event: any) => event.recordType === "human_event" && event.schemaVersion === 2));
  assert.equal(persisted.find((event: any) => event.eventType === "text_input").application.id, "bundle:com.apple.Notes");
  const persistedSnapshot = persisted.find((event: any) => event.eventType === "accessibility_snapshot");
  assert.ok(persistedSnapshot.ui.nodes.every((node: any) => !node.role.startsWith("AX")));
});

test("filters startup and incremental AX before persistence, including unknown website context", async () => {
  const browser = { ...app, bundleIdentifier: "com.google.Chrome" };
  helper.events = [
    { kind: "session.started", app: browser, window: { url: "https://bank.com" }, ax: full },
    { kind: "keyboard.text_input", app: browser, window: { url: "https://bank.com" }, keyboard: { text: "x" }, ax: firstTree },
    { kind: "keyboard.shortcut", app: browser, window: {}, keyboard: { keyEquivalent: "c", modifiers: ["cmd"] }, ax: secondTree },
    { kind: "mouse.click", app: browser, window: { url: "https://example.com" }, ax: thirdTree },
  ];
  const events = await record({ observation: {
    defaultApplicationBehavior: "observe", defaultURLBehavior: "observe",
    rules: [{ scope: "url", urlDomain: "bank.com", behavior: "do_not_observe" }],
  } });
  assert.deepEqual(events.filter((event) => event.ax).map((event) => event.ax), [thirdTree]);
  assert.deepEqual(events.filter((event) => event.eventType === "page_context").map((event) => event.details.url), ["https://example.com/"]);
});

test("never persists a private startup snapshot or secure text input", async () => {
  helper.events = [
    { kind: "session.started", app, window: { privateBrowsing: true }, ax: full },
    { kind: "keyboard.text_input", app: { ...app, secureInput: true }, keyboard: { text: "sensitive" } },
  ];
  const events = await record();
  assert.equal(events.some((event) => event.ax || event.eventType === "text_input"), false);
});

const allow = { observation: {
  defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [],
} };
const chrome = { ...app, bundleIdentifier: "com.google.Chrome" };
const window = { browser: true, url: "https://example.com" };
const searchTarget = { role: "AXSearchField", description: "Search" };
const ordinaryTarget = { role: "AXTextField", description: "Customer ID" };

test("keeps the Mac stop chord working after protocol key normalization", () => {
  assert.equal(isStopHotkey({ kind: "keyboard.shortcut", keyboard: {
    keyEquivalent: "r", modifiers: ["cmd", "control", "option"],
  } }), true);
  assert.equal(isStopHotkey({ kind: "keyboard.shortcut", keyboard: {
    keyEquivalent: "r", modifiers: ["cmd", "option"],
  } }), false);
});

test.each([
  { scope: "app", bundleID: "com.google.Chrome", behavior: "do_not_observe" },
  { scope: "url", urlDomain: "example.com", behavior: "do_not_observe" },
])("applies a live $scope exclusion to buffered keys and later AX events without restarting", async (rule) => {
  helper.events = [
    { kind: "keyboard.text_input", app: chrome, window, keyboard: { text: "buffered", target: searchTarget } },
    { kind: "mouse.click", app: chrome, window, ax: firstTree },
    { kind: "mouse.click", app: chrome, window, ax: full },
  ];
  helper.afterEvent = (index) => {
    if (index < 2) fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify(index === 0
      ? { observation: { ...allow.observation, rules: [rule] } } : allow));
  };
  const events = await record(allow, { flags: ["--capture-search-text"] });
  assert.equal(events.some((event) => event.eventType === "text_input"), false);
  assert.deepEqual(events.filter((event) => event.ax).map((event) => event.ax), [full]);
  assert.equal(events.filter((event) => event.eventType === "mouse_click").length, 1);
});

test("drops buffered keys when settings become unreadable before the final flush", async () => {
  helper.events = [{ kind: "keyboard.text_input", app, keyboard: { text: "buffered", target: searchTarget } }];
  helper.afterEvent = () => fs.writeFileSync(path.join(directory, "settings.json"), "{");
  const events = await record(allow, { flags: ["--capture-search-text"] });
  assert.equal(events.some((event) => event.eventType === "text_input"), false);
});

test("removes an in-flight screenshot and its event when a new rule excludes the app", async () => {
  helper.events = [{ kind: "mouse.click", app }];
  const captured: string[] = [];
  helper.onCommand = (command, args) => {
    if (command !== "screencapture") return;
    const image = args.at(-1)!;
    captured.push(image);
    fs.writeFileSync(image, "synthetic screenshot bytes");
    fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ observation: {
      ...allow.observation, rules: [{ scope: "app", bundleID: app.bundleIdentifier, behavior: "do_not_observe" }],
    } }));
  };
  const events = await record(allow, { screenshots: true });
  assert.equal(captured.length, 1);
  assert.equal(captured.some((image) => fs.existsSync(image)), false);
  assert.equal(events.some((event) => event.eventType === "mouse_click" || event.screenshot), false);
});

test("uses each key's current target after Tab/window changes and keeps keyboard-focused searches", async () => {
  helper.events = [
    { kind: "mouse.click", app: chrome, mouse: { target: searchTarget } },
    { kind: "keyboard.shortcut", app: chrome, keyboard: { keyEquivalent: "tab" } },
    { kind: "keyboard.text_input", app: chrome, keyboard: { text: "private", target: ordinaryTarget } },
    { kind: "window.changed", app: chrome },
    { kind: "keyboard.text_input", app: chrome, keyboard: { text: "unknown", target: { role: "AXUnknown" } } },
    { kind: "keyboard.text_input", app: chrome, keyboard: { text: "real query", target: searchTarget } },
    { kind: "keyboard.text_input", app: chrome, keyboard: { text: "another private value", target: ordinaryTarget } },
  ];
  const events = await record(undefined, { flags: ["--capture-search-text"] });
  assert.deepEqual(events.filter((event) => event.eventType === "text_input").map((event) => ({
    text: event.details.text, redacted: event.details.redacted,
  })), [
    { text: "[REDACTED]", redacted: true },
    { text: "[REDACTED]", redacted: true },
    { text: "real query", redacted: false },
    { text: "[REDACTED]", redacted: true },
  ]);
});

test.runIf(platform.value === "darwin")("native snapshots cannot carry excluded baselines into permitted disk deltas, and queued focus cannot grant search access", async () => {
  const native = nativePrivacyFixture(directory);
  assert.equal(native.throttled, true);
  assert.equal(native.tapDidNoAXRead, true);
  assert.equal(native.blocked.mode, "fullTree");
  assert.equal(native.restored.mode, "fullTree");
  assert.equal(native.unchanged.mode, "fullTree");
  assert.deepEqual(native.keyboard.map((event: any) => event.keyboard.target.role), [
    "AXUnknown", "AXSearchField", "AXUnknown", "AXUnknown", "AXUnknown",
  ]);
  assert.deepEqual(native.keyboard[4].keyboard.target, { role: "AXUnknown" });
  const sameWindow = { browser: true, url: "https://example.com/", title: "Same document" };
  const blocked = { observation: { ...allow.observation,
    rules: [{ scope: "app", bundleID: chrome.bundleIdentifier, behavior: "do_not_observe" }],
  } };
  helper.events = [
    { kind: "session.started", app: chrome, window: sameWindow, ax: native.blocked },
    // A throttled native event after reallow has no AX; it cannot establish a baseline.
    { kind: "mouse.click", app: chrome, window: sameWindow },
    { kind: "mouse.click", app: chrome, window: sameWindow, ax: native.restored },
    { kind: "mouse.click", app: chrome, window: sameWindow, ax: native.unchanged },
    { kind: "mouse.click", app: chrome, window: sameWindow, ax: native.changed },
    { kind: "mouse.click", app: chrome, window: sameWindow, ax: native.otherWindow },
    ...native.keyboard.map((event: any) => ({ ...event, app: chrome, window: sameWindow })),
  ];
  helper.afterEvent = (index) => {
    if (index === 0) fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify(allow));
  };
  const events = await record(blocked, { flags: ["--capture-search-text"] });
  const snapshots = events.filter((event) => event.ax).map((event) => event.ax);
  assert.deepEqual(snapshots.map((ax) => ax.mode), ["fullTree", "diffFromPrevious", "fullTree"]);
  assert.equal(JSON.stringify(events).includes("SYNTHETIC_EXCLUDED_CUSTOMER_ID"), false);
  assert.deepEqual(snapshots[0], { mode: "fullTree", windowKey: native.restored.windowKey, text: native.restored.text });
  // The permitted delta exactly reconstructs the second permitted tree.
  const reconstructed = new Set<string>(snapshots[0].text.split("\n"));
  for (const line of snapshots[1].text.split("\n")) {
    if (line.startsWith("- ")) reconstructed.delete(line.slice(2));
    else if (line.startsWith("+ ")) reconstructed.add(line.slice(2));
  }
  assert.deepEqual([...reconstructed], native.changed.text.split("\n"));
  const typed = events.filter((event) => event.eventType === "text_input");
  assert.deepEqual(typed.map((event) => [event.details.text, event.details.redacted]), [
    ["[REDACTED]", true], ["allowed query", false], ["[REDACTED]", true],
  ]);
  assert.equal(JSON.stringify(events).includes("SYNTHETIC_ORDINARY_FIELD_TEXT"), false);
}, 65_000);

test("a protocol capture gap invalidates the baseline and requires a fresh full snapshot", async () => {
  helper.events = [
    { kind: "session.started", app, ax: full },
    { kind: "mouse.click", app, gapBefore: true },
    { kind: "mouse.click", app, ax: firstTree },
  ];
  const events = await record();
  assert.deepEqual(events.filter((event) => event.ax).map((event) => event.ax), [full, firstTree]);
  assert.equal(events.some((event) => event.eventType === "capture_gap"), true);
});

test("a policy change without an intervening excluded event requires a fresh full tree", async () => {
  helper.events = [
    { kind: "session.started", app, ax: full },
    { kind: "mouse.click", app },
    { kind: "mouse.click", app, ax: firstTree },
  ];
  helper.afterEvent = (index) => {
    if (index === 0) fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ observation: {
      ...allow.observation, rules: [{ scope: "app", bundleID: "other.app", behavior: "do_not_observe" }],
    } }));
  };
  const events = await record(allow);
  assert.deepEqual(events.filter((event) => event.ax).map((event) => event.ax), [full, firstTree]);
});

test("a failed final authorization invalidates an already committed baseline", async () => {
  helper.events = [{ kind: "mouse.click", app, ax: full }, { kind: "mouse.click", app, ax: firstTree }];
  let screenshots = 0;
  helper.onCommand = (command, args) => {
    if (command !== "screencapture") return;
    fs.writeFileSync(args.at(-1)!, "synthetic screenshot bytes");
    if (++screenshots === 1) fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ observation: {
      ...allow.observation, rules: [{ scope: "app", bundleID: app.bundleIdentifier, behavior: "do_not_observe" }],
    } }));
  };
  helper.afterEvent = (index) => {
    if (index === 0) fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify(allow));
  };
  const events = await record(allow, { screenshots: true });
  assert.deepEqual(events.filter((event) => event.ax).map((event) => event.ax), [full, firstTree]);
  assert.equal(events.filter((event) => event.eventType === "mouse_click").length, 1);
});

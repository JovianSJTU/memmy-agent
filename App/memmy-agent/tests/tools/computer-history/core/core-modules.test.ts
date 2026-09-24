import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CaptureProtocolError,
  MAX_CAPTURE_LINE_BYTES,
  parseCaptureMessage,
  serializeCaptureMessage,
  type CaptureMessage,
} from "../../../../src/tools/computer-history/core/capture-protocol.js";
import {
  DEFAULT_OBSERVATION_SETTINGS,
  ObservationSettingsError,
  evaluateObservation,
  parseObservationSettings,
} from "../../../../src/tools/computer-history/core/observation-settings.js";
import { ObservationSettingsStore } from "../../../../src/tools/computer-history/core/settings-store.js";

const temporaryDirectories: string[] = [];

function captureContext(overrides: Record<string, unknown> = {}) {
  return {
    application: {
      id: "exe:c:\\program files\\example\\example.exe",
      idKind: "exe_path",
      name: "Example",
      pid: 1234,
    },
    window: {
      id: "hwnd:0001008a",
      title: "Example",
      isBrowser: false,
      page: { state: "unknown" },
    },
    privacy: {
      secureInput: false,
      passwordTarget: false,
      privateWindow: "unknown",
      systemSurface: false,
      ...overrides,
    },
  };
}

function clickEvent() {
  return {
    v: 1,
    type: "event",
    runId: "c16d2b43-2a78-4992-b96f-707a98d48f73",
    sequence: 12,
    occurredAt: "2026-09-24T08:20:03.000Z",
    kind: "pointer.click",
    context: captureContext(),
    data: {
      button: "left",
      clickCount: 1,
      target: { element: { role: "button", name: "Save", isPassword: false } },
    },
  };
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("shared Computer History core modules", () => {
  it("parses typed capture events and rejects fields outside the protocol", () => {
    const parsed = parseCaptureMessage(clickEvent());
    expect(parsed).toMatchObject({
      type: "event",
      kind: "pointer.click",
      sequence: 12,
      data: { button: "left", clickCount: 1 },
    });

    const withCoordinates = clickEvent();
    (withCoordinates.data as Record<string, unknown>).x = 12;
    expect(() => parseCaptureMessage(withCoordinates)).toThrow(CaptureProtocolError);
  });

  it("rejects typed text from secure or password targets", () => {
    const secureTextEvent = {
      ...clickEvent(),
      kind: "keyboard.text",
      context: captureContext({ secureInput: true }),
      data: { text: "private", target: null },
    };
    expect(() => parseCaptureMessage(secureTextEvent)).toThrow(/secure input and password targets/);
  });

  it("enforces the NDJSON line byte limit before parsing", () => {
    expect(() => parseCaptureMessage(" ".repeat(MAX_CAPTURE_LINE_BYTES + 1)))
      .toThrow(/exceeds/);
  });

  it("round-trips a ready message with one newline", () => {
    const ready: CaptureMessage = {
      v: 1,
      type: "ready",
      runId: "c16d2b43-2a78-4992-b96f-707a98d48f73",
      platform: "windows",
      capabilities: ["pointer", "keyboard", "ui_tree"],
    };
    const line = serializeCaptureMessage(ready);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseCaptureMessage(line.trimEnd())).toEqual(ready);
  });

  it("keeps legacy Mac bundle rules separate from normalized executable IDs", () => {
    const settings = parseObservationSettings({
      observation: {
        defaultApplicationBehavior: "do_not_observe",
        defaultURLBehavior: "observe",
        rules: [
          { scope: "app", applicationId: "exe:c:\\program files\\example\\example.exe", behavior: "observe" },
          { scope: "app", bundleID: "com.example.Editor", behavior: "observe" },
        ],
      },
    });

    expect(evaluateObservation(settings, {
      applicationId: "exe:c:\\program files\\example\\example.exe",
    }).observe).toBe(true);
    expect(evaluateObservation(settings, { applicationId: "exe:c:\\other\\editor.exe" }).observe).toBe(false);
    expect(evaluateObservation(settings, { applicationId: "bundle:com.example.Editor" }).observe).toBe(true);
  });

  it("fails closed when application identity is unavailable", () => {
    expect(evaluateObservation(DEFAULT_OBSERVATION_SETTINGS, {})).toEqual({
      observe: false,
      reason: "application_not_allowed",
    });
  });

  it("uses defaults only for a missing settings file and rejects malformed files", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-computer-history-core-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "observation-settings.json");
    const store = new ObservationSettingsStore(file);
    expect(store.read()).toEqual(DEFAULT_OBSERVATION_SETTINGS);

    fs.writeFileSync(file, "not json", "utf8");
    expect(() => store.read()).toThrow(ObservationSettingsError);
  });
});

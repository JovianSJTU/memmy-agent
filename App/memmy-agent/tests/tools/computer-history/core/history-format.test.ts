import { describe, expect, it } from "vitest";
import { normalizeHistoryRecord, toHistoryV2Event } from "../../../../src/tools/computer-history/core/history-format.js";

describe("Computer History v2 persistence adapter", () => {
  it("writes the v2 envelope and maps full UI snapshots", () => {
    const event = toHistoryV2Event({
      sequence: 3,
      timestamp: "2026-09-24T08:20:03Z",
      eventType: "accessibility_snapshot",
      application: { name: "Example", bundleId: "com.example.App" },
      details: {},
      ax: { mode: "fullTree", windowKey: "42:1", nodes: [{ role: "button", nativeRole: "AXButton", name: "Save", isPassword: false }] },
      source: { runId: "c16d2b43-2a78-4992-b96f-707a98d48f73", sequence: 9 },
    });
    expect(event).toMatchObject({
      schemaVersion: 2, eventType: "accessibility_snapshot", application: { id: "bundle:com.example.App" },
      ui: { mode: "full", windowKey: "42:1", nodes: [{ role: "button", name: "Save" }] },
      source: { sequence: 9 },
    });
  });

  it("normalizes AX roles in persisted details and removes password values", () => {
    const event = toHistoryV2Event({
      sequence: 2,
      timestamp: "2026-09-24T08:20:03Z",
      eventType: "mouse_click",
      application: { name: "Notes", bundleId: "com.apple.Notes" },
      details: {
        accessibility: { role: "AXButton", title: "Save", value: "safe" },
        password: { role: "AXTextField", subrole: "AXSecureTextField", title: "Password", value: "secret" },
      },
    });
    expect(event.details).toEqual({
      accessibility: { role: "button", nativeRole: "AXButton", value: "safe", name: "Save" },
      password: { role: "text_field", nativeRole: "AXTextField", name: "Password", isPassword: true },
    });
    expect(JSON.stringify(event)).not.toContain("secret");
  });

  it("uses structured semantic nodes for v2 diffs and retains the password marker", () => {
    const event = toHistoryV2Event({
      sequence: 3,
      timestamp: "2026-09-24T08:20:03Z",
      eventType: "accessibility_snapshot",
      application: { name: "Notes", bundleId: "com.apple.Notes" },
      ax: {
        mode: "diffFromPrevious", windowKey: "window:1", text: "+ legacy line",
        addedNodes: [{ role: "text_field", nativeRole: "AXTextField", name: "Password", isPassword: true }],
        removedNodes: [{ role: "text", nativeRole: "AXStaticText", name: "Old", isPassword: false }],
      },
    });
    expect(event.ui).toMatchObject({
      mode: "diff",
      added: [{ role: "text_field", isPassword: true, name: "Password" }],
      removed: [{ role: "text", isPassword: false, name: "Old" }],
    });
    expect(normalizeHistoryRecord(event).ax?.text).toContain("AXTextField|AXSecureTextField|Password|||[REDACTED]");
  });

  it("normalizes v2 records for existing v1 readers without changing v1 records", () => {
    const v2 = normalizeHistoryRecord({
      recordType: "human_event", schemaVersion: 2, sequence: 1, timestamp: "2026-09-24T08:20:03Z",
      eventType: "accessibility_snapshot", application: { id: "bundle:com.example.App", name: "Example" }, details: {},
      ui: { mode: "diff", windowKey: "42:1", added: [{ role: "button", nativeRole: "AXButton", name: "Save", isPassword: false }], removed: [] },
    });
    expect(v2).toMatchObject({ schemaVersion: 1, application: { bundleId: "com.example.App" }, ax: { mode: "diffFromPrevious", text: "+ AXButton||Save|||" } });
    const v1 = { recordType: "human_event", schemaVersion: 1, application: { bundleId: "com.example.App" } };
    expect(normalizeHistoryRecord(v1)).toBe(v1);
  });
});

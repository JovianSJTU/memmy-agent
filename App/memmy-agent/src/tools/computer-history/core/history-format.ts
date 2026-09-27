import type { UiNode } from "./capture-protocol.js";

export type HistoryV2EventType =
  | "application_changed"
  | "page_context"
  | "mouse_click"
  | "mouse_drag"
  | "key_press"
  | "text_input"
  | "selection_changed"
  | "accessibility_snapshot"
  | "capture_gap"
  | "recording_started"
  | "recording_stopped";

export interface HistoryV2Metadata {
  recordType: "human_history_metadata";
  schemaVersion: 2;
  recordingId: string;
  title: string;
  createdAt: string;
  platform: "macos" | "windows";
  captureProtocolVersion: 1;
  display: { width: number; height: number };
  captureText: boolean;
  captureSearchText: boolean;
  allowedApplications: string[];
  captureScopeApplications: string[];
  privacy: string;
  contextUrl?: string;
}

export interface HistoryV2Event {
  recordType: "human_event";
  schemaVersion: 2;
  sequence: number;
  timestamp: string;
  eventType: HistoryV2EventType;
  application: { id: string; name: string };
  details: Record<string, unknown>;
  ui?:
    | { mode: "full"; windowKey: string; nodes: UiNode[] }
    | { mode: "diff"; windowKey: string; added: UiNode[]; removed: UiNode[] };
  source?: { runId: string; sequence: number };
  screenshot?: string;
}

const EVENT_TYPES: Record<string, HistoryV2EventType> = {
  application_changed: "application_changed",
  page_context: "page_context",
  mouse_click: "mouse_click",
  mouse_drag: "mouse_drag",
  key_press: "key_press",
  text_input: "text_input",
  selection_changed: "selection_changed",
  accessibility_snapshot: "accessibility_snapshot",
  capture_gap: "capture_gap",
  recording_started: "recording_started",
  recording_stopped: "recording_stopped",
};

const ACCESSIBILITY_ROLES: Record<string, string> = {
  AXApplication: "application", AXWindow: "window", AXButton: "button", AXPopUpButton: "button",
  AXMenuButton: "button", AXRadioButton: "radio_button", AXCheckBox: "checkbox",
  AXTextField: "text_field", AXTextArea: "text_field", AXComboBox: "text_field",
  AXSearchField: "search_field", AXLink: "link", AXMenuItem: "menu_item", AXTabButton: "tab",
  AXSlider: "slider", AXStaticText: "text", AXHeading: "heading", AXWebArea: "document",
  AXGroup: "group", AXLayoutArea: "group", AXTable: "table", AXRow: "row", AXCell: "cell",
  AXList: "list", AXUnknown: "unknown",
};

function semanticizeAccessibility(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticizeAccessibility);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const rawRole = typeof source.role === "string" ? source.role : undefined;
  const rawSubrole = typeof source.subrole === "string" ? source.subrole : undefined;
  const nativeRole = rawRole?.startsWith("AX") ? rawRole : rawSubrole?.startsWith("AX") ? rawSubrole : undefined;
  const isPassword = source.isPassword === true || rawSubrole === "AXSecureTextField" || nativeRole === "AXSecureTextField";
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(source)) {
    if (["subrole", "title", "identifier"].includes(key)) continue;
    if (key === "value" && isPassword) continue;
    if (key === "role" && nativeRole) {
      result.role = ACCESSIBILITY_ROLES[nativeRole] ?? "unknown";
      result.nativeRole = nativeRole;
      continue;
    }
    if (key === "name" && source.title !== undefined) continue;
    if (key === "automationId" && source.identifier !== undefined) continue;
    result[key] = semanticizeAccessibility(field);
  }
  if (source.name === undefined && typeof source.title === "string") result.name = source.title;
  if (source.automationId === undefined && typeof source.identifier === "string") result.automationId = source.identifier;
  if (rawRole === undefined && nativeRole) {
    result.role = ACCESSIBILITY_ROLES[nativeRole] ?? "unknown";
    result.nativeRole = nativeRole;
  }
  if (isPassword) result.isPassword = true;
  return result;
}

function legacyNode(line: string): UiNode {
  const [rawRole = "unknown", subrole, name, description, automationId, value] = line.split("|");
  const nativeRole = rawRole.startsWith("AX")
    ? rawRole : subrole && subrole !== "AXSecureTextField" ? subrole : undefined;
  const role = rawRole.startsWith("AX") ? ({
    AXApplication: "application", AXWindow: "window", AXButton: "button", AXPopUpButton: "button",
    AXMenuButton: "button", AXRadioButton: "radio_button", AXCheckBox: "checkbox",
    AXTextField: "text_field", AXTextArea: "text_field", AXComboBox: "text_field",
    AXSearchField: "search_field", AXLink: "link", AXMenuItem: "menu_item", AXTabButton: "tab",
    AXSlider: "slider", AXIncrementor: "button", AXList: "list",
    AXStaticText: "text", AXHeading: "heading", AXWebArea: "document",
    AXGroup: "group", AXLayoutArea: "group", AXCell: "cell", AXRow: "row", AXTable: "table",
  } as Record<string, string>)[rawRole] ?? "unknown" : rawRole;
  const node: UiNode = { role, isPassword: subrole === "AXSecureTextField" || rawRole === "AXSecureTextField" };
  if (nativeRole) node.nativeRole = nativeRole;
  if (name) node.name = name;
  if (description) node.description = description;
  if (automationId) node.automationId = automationId;
  if (value && !node.isPassword) node.value = value;
  return node;
}

/** Converts the current Mac recorder's in-memory event to the durable v2 envelope. */
export function toHistoryV2Event(input: {
  sequence: number;
  timestamp: string;
  eventType: string;
  application?: { name?: string; bundleId?: string };
  details?: Record<string, unknown>;
  ax?: {
    mode?: string;
    windowKey?: string;
    text?: string;
    nodes?: UiNode[];
    addedNodes?: UiNode[];
    removedNodes?: UiNode[];
  } | null;
  source?: { runId: string; sequence: number };
  screenshot?: string;
}): HistoryV2Event {
  const eventType = EVENT_TYPES[input.eventType];
  if (!eventType) throw new Error(`Unsupported Computer History event type: ${input.eventType}`);
  const bundleId = input.application?.bundleId ?? "unknown";
  const record: HistoryV2Event = {
    recordType: "human_event",
    schemaVersion: 2,
    sequence: input.sequence,
    timestamp: input.timestamp,
    eventType,
    application: {
      id: `bundle:${bundleId}`,
      name: input.application?.name ?? bundleId,
    },
    details: semanticizeAccessibility(input.details ?? {}) as Record<string, unknown>,
  };
  if (input.source) record.source = input.source;
  if (input.screenshot) record.screenshot = input.screenshot;
  if (input.ax?.text !== undefined || input.ax?.nodes !== undefined) {
    const windowKey = input.ax.windowKey ?? "unknown-window";
    if (input.ax.mode === "diffFromPrevious") {
      const lines = (input.ax.text ?? "").split("\n").filter(Boolean);
      record.ui = {
        mode: "diff",
        windowKey,
        removed: input.ax.removedNodes ?? lines.filter((line) => line.startsWith("- ")).map((line) => legacyNode(line.slice(2))),
        added: input.ax.addedNodes ?? lines.filter((line) => line.startsWith("+ ")).map((line) => legacyNode(line.slice(2))),
      };
    } else {
      record.ui = {
        mode: "full",
        windowKey,
        nodes: input.ax.nodes ?? (input.ax.text ?? "").split("\n").filter(Boolean).map(legacyNode),
      };
    }
  }
  return record;
}

function legacyText(node: UiNode): string {
  return [node.nativeRole ?? node.role, node.isPassword ? "AXSecureTextField" : "", node.name ?? "", node.description ?? "", node.automationId ?? "", node.isPassword ? "[REDACTED]" : node.value ?? ""]
    .join("|");
}

/** Normalizes v2 records in memory for the existing summary and workflow readers. */
export function normalizeHistoryRecord(record: Record<string, any>): Record<string, any> {
  if (record.recordType !== "human_history_metadata" && record.recordType !== "human_event") return record;
  if (record.schemaVersion !== 2) return record;
  if (record.recordType === "human_history_metadata") return {
    ...record,
    schemaVersion: 1,
    ...(record.platform === "macos" ? { platform: "macOS" } : {}),
  };

  const applicationId = typeof record.application?.id === "string" ? record.application.id : "";
  const application = {
    ...(typeof record.application?.name === "string" ? { name: record.application.name } : {}),
    ...(applicationId.startsWith("bundle:") ? { bundleId: applicationId.slice("bundle:".length) } : applicationId ? { bundleId: applicationId } : {}),
  };
  const details = record.details && typeof record.details === "object" ? record.details : {};
  let ax: Record<string, unknown> | undefined;
  if (record.ui?.mode === "full" && Array.isArray(record.ui.nodes)) {
    ax = { mode: "fullTree", windowKey: record.ui.windowKey, text: record.ui.nodes.map(legacyText).join("\n") };
  } else if (record.ui?.mode === "diff" && Array.isArray(record.ui.added) && Array.isArray(record.ui.removed)) {
    ax = {
      mode: "diffFromPrevious",
      windowKey: record.ui.windowKey,
      text: [
        ...record.ui.removed.map((node: UiNode) => `- ${legacyText(node)}`),
        ...record.ui.added.map((node: UiNode) => `+ ${legacyText(node)}`),
      ].join("\n"),
    };
  }
  return {
    ...record,
    schemaVersion: 1,
    application,
    details,
    ...(ax ? { ax } : {}),
  };
}

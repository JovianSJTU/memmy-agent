/** Shared NDJSON contract between native capture helpers and the Node core. */
export const CAPTURE_PROTOCOL_VERSION = 1 as const;
export const MAX_CAPTURE_LINE_BYTES = 1024 * 1024;
export const MAX_UI_SNAPSHOT_NODES = 400;

export type CaptureCapability =
  | "pointer"
  | "keyboard"
  | "ui_tree"
  | "selected_text"
  | "browser_url"
  | "private_window_detection";

export type CaptureEventKind =
  | "app.activated"
  | "window.changed"
  | "page.changed"
  | "pointer.click"
  | "pointer.drag"
  | "keyboard.shortcut"
  | "keyboard.submit"
  | "keyboard.text"
  | "selection.changed"
  | "ui.snapshot";

export interface UiNode {
  role: string;
  nativeRole?: string;
  name?: string;
  description?: string;
  automationId?: string;
  value?: string;
  isPassword: boolean;
}

export interface UiTarget {
  element: UiNode | null;
  ancestors?: UiNode[];
  descendants?: UiNode[];
}

export interface CaptureContext {
  application: {
    id: string;
    idKind: "bundle_id" | "exe_path" | "aumid";
    name: string;
    pid: number;
  };
  window: {
    id: string;
    title: string | null;
    isBrowser: boolean;
    page: { state: "known"; url: string } | { state: "unknown" };
  };
  privacy: {
    secureInput: boolean;
    passwordTarget: boolean;
    privateWindow: "yes" | "no" | "unknown";
    systemSurface: boolean;
  };
}

type EmptyEventData = Record<string, never>;
export interface CaptureEventDataByKind {
  "app.activated": EmptyEventData;
  "window.changed": EmptyEventData;
  "page.changed": EmptyEventData;
  "pointer.click": { button: "left" | "right" | "middle"; clickCount: number; target: UiTarget | null };
  "pointer.drag": { origin: UiTarget | null; destination: UiTarget | null };
  "keyboard.shortcut": {
    key: string;
    modifiers: Array<"control" | "alt" | "shift" | "meta">;
    target: UiTarget | null;
  };
  "keyboard.submit": { target: UiTarget | null };
  "keyboard.text": { text: string; target: UiTarget | null };
  "selection.changed": { selectedText: string | null; target: UiTarget | null };
  "ui.snapshot": { windowKey: string; nodes: UiNode[] };
}

export type CaptureEvent = {
  [Kind in CaptureEventKind]: {
    v: typeof CAPTURE_PROTOCOL_VERSION;
    type: "event";
    runId: string;
    sequence: number;
    occurredAt: string;
    kind: Kind;
    context: CaptureContext;
    data: CaptureEventDataByKind[Kind];
  }
}[CaptureEventKind];

export type CaptureMessage =
  | {
      v: typeof CAPTURE_PROTOCOL_VERSION;
      type: "ready";
      runId: string;
      platform: "macos" | "windows";
      capabilities: CaptureCapability[];
    }
  | CaptureEvent
  | { v: typeof CAPTURE_PROTOCOL_VERSION; type: "heartbeat"; runId: string; lastSequence: number }
  | {
      v: typeof CAPTURE_PROTOCOL_VERSION;
      type: "gap";
      runId: string;
      fromSequence: number;
      toSequence: number;
      reason: "overflow" | "enrichment_failed";
    }
  | {
      v: typeof CAPTURE_PROTOCOL_VERSION;
      type: "fatal";
      runId: string;
      code: string;
      message: string;
    }
  | {
      v: typeof CAPTURE_PROTOCOL_VERSION;
      type: "stopped";
      runId: string;
      lastSequence: number;
      reason: "requested" | "hotkey" | "permission_lost";
    };

export class CaptureProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureProtocolError";
  }
}

type ObjectValue = Record<string, unknown>;
const CAPABILITIES = new Set<CaptureCapability>([
  "pointer", "keyboard", "ui_tree", "selected_text", "browser_url", "private_window_detection",
]);
const EVENT_KINDS = new Set<CaptureEventKind>([
  "app.activated", "window.changed", "page.changed", "pointer.click", "pointer.drag",
  "keyboard.shortcut", "keyboard.submit", "keyboard.text", "selection.changed", "ui.snapshot",
]);
const MAX_SHORT_TEXT = 240;

function object(value: unknown, field: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CaptureProtocolError(`${field} must be an object`);
  }
  return value as ObjectValue;
}

function allowKeys(value: ObjectValue, field: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new CaptureProtocolError(`${field}.${unexpected} is not part of capture protocol v1`);
}

function string(value: unknown, field: string, maxLength = MAX_SHORT_TEXT, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new CaptureProtocolError(`${field} must be a${allowEmpty ? "" : " non-empty"} string of at most ${maxLength} characters`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CaptureProtocolError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new CaptureProtocolError(`${field} must be a boolean`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, options: T, field: string): T[number] {
  if (typeof value !== "string" || !options.includes(value)) {
    throw new CaptureProtocolError(`${field} has an unsupported value`);
  }
  return value as T[number];
}

function runId(value: unknown): string {
  const id = string(value, "runId", 36, false);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new CaptureProtocolError("runId must be a UUID");
  }
  return id;
}

function utcTimestamp(value: unknown): string {
  const timestamp = string(value, "occurredAt", 40, false);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))) {
    throw new CaptureProtocolError("occurredAt must be a UTC ISO 8601 timestamp ending in Z");
  }
  return timestamp;
}

function safePageUrl(value: unknown): string {
  const raw = string(value, "context.window.page.url", 4096, false);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CaptureProtocolError("context.window.page.url must be an absolute URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CaptureProtocolError("page URL must be http(s) without credentials, query, or fragment");
  }
  return parsed.toString();
}

function parseContext(value: unknown): CaptureContext {
  const source = object(value, "context");
  allowKeys(source, "context", ["application", "window", "privacy"]);
  const app = object(source.application, "context.application");
  allowKeys(app, "context.application", ["id", "idKind", "name", "pid"]);
  const idKind = oneOf(app.idKind, ["bundle_id", "exe_path", "aumid"] as const, "context.application.idKind");
  const id = string(app.id, "context.application.id", 2048, false);
  const idPrefix = idKind === "bundle_id" ? "bundle:" : idKind === "exe_path" ? "exe:" : "aumid:";
  if (!id.startsWith(idPrefix) || id.length === idPrefix.length) {
    throw new CaptureProtocolError(`context.application.id must use the ${idPrefix} prefix`);
  }
  const window = object(source.window, "context.window");
  allowKeys(window, "context.window", ["id", "title", "isBrowser", "page"]);
  const page = object(window.page, "context.window.page");
  const pageState = oneOf(page.state, ["known", "unknown"] as const, "context.window.page.state");
  allowKeys(page, "context.window.page", pageState === "known" ? ["state", "url"] : ["state"]);
  const privacy = object(source.privacy, "context.privacy");
  allowKeys(privacy, "context.privacy", ["secureInput", "passwordTarget", "privateWindow", "systemSurface"]);

  return {
    application: {
      id,
      idKind,
      name: string(app.name, "context.application.name", 240, false),
      pid: integer(app.pid, "context.application.pid", 1, 2_147_483_647),
    },
    window: {
      id: string(window.id, "context.window.id", 512, false),
      title: window.title === null ? null : string(window.title, "context.window.title", 240),
      isBrowser: boolean(window.isBrowser, "context.window.isBrowser"),
      page: pageState === "known"
        ? { state: "known", url: safePageUrl(page.url) }
        : { state: "unknown" },
    },
    privacy: {
      secureInput: boolean(privacy.secureInput, "context.privacy.secureInput"),
      passwordTarget: boolean(privacy.passwordTarget, "context.privacy.passwordTarget"),
      privateWindow: oneOf(privacy.privateWindow, ["yes", "no", "unknown"] as const, "context.privacy.privateWindow"),
      systemSurface: boolean(privacy.systemSurface, "context.privacy.systemSurface"),
    },
  };
}

function parseUiNode(value: unknown, field: string): UiNode {
  const node = object(value, field);
  allowKeys(node, field, ["role", "nativeRole", "name", "description", "automationId", "value", "isPassword"]);
  const result: UiNode = {
    role: string(node.role, `${field}.role`, 80, false),
    isPassword: boolean(node.isPassword, `${field}.isPassword`),
  };
  for (const key of ["nativeRole", "name", "description", "automationId", "value"] as const) {
    if (node[key] !== undefined) {
      const limit = key === "automationId" ? 512 : key === "nativeRole" ? 120 : MAX_SHORT_TEXT;
      result[key] = string(node[key], `${field}.${key}`, limit);
    }
  }
  return result;
}

function parseUiTarget(value: unknown, field: string): UiTarget | null {
  if (value === null) return null;
  const target = object(value, field);
  allowKeys(target, field, ["element", "ancestors", "descendants"]);
  if (!("element" in target)) throw new CaptureProtocolError(`${field}.element is required`);
  const result: UiTarget = {
    element: target.element === null ? null : parseUiNode(target.element, `${field}.element`),
  };
  for (const key of ["ancestors", "descendants"] as const) {
    const nodes = target[key];
    if (nodes !== undefined) {
      if (!Array.isArray(nodes) || nodes.length > 32) {
        throw new CaptureProtocolError(`${field}.${key} must contain at most 32 nodes`);
      }
      result[key] = nodes.map((node, index) => parseUiNode(node, `${field}.${key}[${index}]`));
    }
  }
  return result;
}

function parseEventData(kind: CaptureEventKind, value: unknown): CaptureEventDataByKind[CaptureEventKind] {
  const data = object(value, "data");
  switch (kind) {
    case "app.activated":
    case "window.changed":
    case "page.changed":
      allowKeys(data, "data", []);
      if (Object.keys(data).length !== 0) throw new CaptureProtocolError(`data for ${kind} must be empty`);
      return {} as CaptureEventDataByKind[CaptureEventKind];
    case "pointer.click":
      allowKeys(data, "data", ["button", "clickCount", "target"]);
      return {
        button: oneOf(data.button, ["left", "right", "middle"] as const, "data.button"),
        clickCount: integer(data.clickCount, "data.clickCount", 1, 10),
        target: parseUiTarget(data.target, "data.target"),
      } as CaptureEventDataByKind[CaptureEventKind];
    case "pointer.drag":
      allowKeys(data, "data", ["origin", "destination"]);
      return {
        origin: parseUiTarget(data.origin, "data.origin"),
        destination: parseUiTarget(data.destination, "data.destination"),
      } as CaptureEventDataByKind[CaptureEventKind];
    case "keyboard.shortcut": {
      allowKeys(data, "data", ["key", "modifiers", "target"]);
      if (!Array.isArray(data.modifiers) || data.modifiers.length > 4) {
        throw new CaptureProtocolError("data.modifiers must be an array of supported modifiers");
      }
      const modifiers = data.modifiers.map((value, index) =>
        oneOf(value, ["control", "alt", "shift", "meta"] as const, `data.modifiers[${index}]`));
      if (new Set(modifiers).size !== modifiers.length) {
        throw new CaptureProtocolError("data.modifiers must not contain duplicates");
      }
      return {
        key: string(data.key, "data.key", 80, false),
        modifiers,
        target: parseUiTarget(data.target, "data.target"),
      } as CaptureEventDataByKind[CaptureEventKind];
    }
    case "keyboard.submit":
      allowKeys(data, "data", ["target"]);
      return { target: parseUiTarget(data.target, "data.target") } as CaptureEventDataByKind[CaptureEventKind];
    case "keyboard.text":
      allowKeys(data, "data", ["text", "target"]);
      return {
        text: string(data.text, "data.text", 64 * 1024),
        target: parseUiTarget(data.target, "data.target"),
      } as CaptureEventDataByKind[CaptureEventKind];
    case "selection.changed":
      allowKeys(data, "data", ["selectedText", "target"]);
      return {
        selectedText: data.selectedText === null ? null : string(data.selectedText, "data.selectedText", 64 * 1024),
        target: parseUiTarget(data.target, "data.target"),
      } as CaptureEventDataByKind[CaptureEventKind];
    case "ui.snapshot":
      allowKeys(data, "data", ["windowKey", "nodes"]);
      if (!Array.isArray(data.nodes) || data.nodes.length > MAX_UI_SNAPSHOT_NODES) {
        throw new CaptureProtocolError(`data.nodes must contain at most ${MAX_UI_SNAPSHOT_NODES} nodes`);
      }
      return {
        windowKey: string(data.windowKey, "data.windowKey", 512, false),
        nodes: data.nodes.map((node, index) => parseUiNode(node, `data.nodes[${index}]`)),
      } as CaptureEventDataByKind[CaptureEventKind];
  }
}

/** Parse and validate one capture-stream line; the returned value contains only protocol fields. */
export function parseCaptureMessage(input: unknown): CaptureMessage {
  let raw: unknown = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_CAPTURE_LINE_BYTES) {
      throw new CaptureProtocolError(`capture line exceeds ${MAX_CAPTURE_LINE_BYTES} bytes`);
    }
    try {
      raw = JSON.parse(input);
    } catch {
      throw new CaptureProtocolError("capture line is not valid JSON");
    }
  } else {
    try {
      const encoded = JSON.stringify(input);
      if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_CAPTURE_LINE_BYTES) {
        throw new CaptureProtocolError(`capture line exceeds ${MAX_CAPTURE_LINE_BYTES} bytes`);
      }
    } catch (error) {
      if (error instanceof CaptureProtocolError) throw error;
      throw new CaptureProtocolError("capture message must be JSON serializable");
    }
  }

  const message = object(raw, "capture message");
  if (message.v !== CAPTURE_PROTOCOL_VERSION) throw new CaptureProtocolError("unsupported capture protocol version");
  const type = string(message.type, "type", 32, false);
  if (type === "ready") {
    allowKeys(message, "message", ["v", "type", "runId", "platform", "capabilities"]);
    if (!Array.isArray(message.capabilities)) throw new CaptureProtocolError("capabilities must be an array");
    const rawCapabilities: unknown[] = message.capabilities;
    const capabilities = rawCapabilities.map((capability, index) => {
      const parsed = oneOf(capability, [...CAPABILITIES] as CaptureCapability[], `capabilities[${index}]`);
      if (rawCapabilities.slice(0, index).includes(parsed)) {
        throw new CaptureProtocolError("capabilities must not contain duplicates");
      }
      return parsed;
    });
    return {
      v: CAPTURE_PROTOCOL_VERSION,
      type,
      runId: runId(message.runId),
      platform: oneOf(message.platform, ["macos", "windows"] as const, "platform"),
      capabilities,
    };
  }
  if (type === "event") {
    allowKeys(message, "message", ["v", "type", "runId", "sequence", "occurredAt", "kind", "context", "data"]);
    const kind = oneOf(message.kind, [...EVENT_KINDS] as CaptureEventKind[], "kind");
    const occurredAt = utcTimestamp(message.occurredAt);
    const context = parseContext(message.context);
    const data = parseEventData(kind, message.data);
    if (kind === "keyboard.text") {
      const target = (data as CaptureEventDataByKind["keyboard.text"]).target;
      if (context.privacy.secureInput || context.privacy.passwordTarget || target?.element?.isPassword) {
        throw new CaptureProtocolError("keyboard.text is forbidden for secure input and password targets");
      }
    }
    return {
      v: CAPTURE_PROTOCOL_VERSION,
      type,
      runId: runId(message.runId),
      sequence: integer(message.sequence, "sequence", 1),
      occurredAt,
      kind,
      context,
      data: data as never,
    } as CaptureEvent;
  }
  if (type === "heartbeat") {
    allowKeys(message, "message", ["v", "type", "runId", "lastSequence"]);
    return {
      v: CAPTURE_PROTOCOL_VERSION,
      type,
      runId: runId(message.runId),
      lastSequence: integer(message.lastSequence, "lastSequence"),
    };
  }
  if (type === "gap") {
    allowKeys(message, "message", ["v", "type", "runId", "fromSequence", "toSequence", "reason"]);
    const fromSequence = integer(message.fromSequence, "fromSequence", 1);
    const toSequence = integer(message.toSequence, "toSequence", fromSequence);
    return {
      v: CAPTURE_PROTOCOL_VERSION,
      type,
      runId: runId(message.runId),
      fromSequence,
      toSequence,
      reason: oneOf(message.reason, ["overflow", "enrichment_failed"] as const, "reason"),
    };
  }
  if (type === "fatal") {
    allowKeys(message, "message", ["v", "type", "runId", "code", "message"]);
    return {
      v: CAPTURE_PROTOCOL_VERSION,
      type,
      runId: runId(message.runId),
      code: string(message.code, "code", 80, false),
      message: string(message.message, "message", 4096),
    };
  }
  if (type === "stopped") {
    allowKeys(message, "message", ["v", "type", "runId", "lastSequence", "reason"]);
    return {
      v: CAPTURE_PROTOCOL_VERSION,
      type,
      runId: runId(message.runId),
      lastSequence: integer(message.lastSequence, "lastSequence"),
      reason: oneOf(message.reason, ["requested", "hotkey", "permission_lost"] as const, "reason"),
    };
  }
  throw new CaptureProtocolError(`unsupported capture message type: ${type}`);
}

export function isCaptureMessage(input: unknown): input is CaptureMessage {
  try {
    parseCaptureMessage(input);
    return true;
  } catch {
    return false;
  }
}

export function serializeCaptureMessage(input: CaptureMessage): string {
  const encoded = JSON.stringify(parseCaptureMessage(input));
  if (Buffer.byteLength(encoded, "utf8") > MAX_CAPTURE_LINE_BYTES) {
    throw new CaptureProtocolError(`capture line exceeds ${MAX_CAPTURE_LINE_BYTES} bytes`);
  }
  return `${encoded}\n`;
}

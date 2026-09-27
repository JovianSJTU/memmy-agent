import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { CaptureEvent, UiNode } from "./capture-protocol.js";
import type { PreparedCollector } from "./platform.js";
import { captureEventToRecordingEvent } from "./capture-session.js";
import { toHistoryV2Event } from "./history-format.js";
import { redactSensitive } from "./redaction.js";
import { DEFAULT_OBSERVATION_SETTINGS, evaluateObservation, parseObservationSettings, type ObservationSettings, type ObservationSubject } from "./observation-settings.js";
const DEFAULT_RECORDINGS_DIR = path.join(os.homedir(), ".memmy", "computer-history", "recordings");
const TEXT_IDLE_MS = 700;
const NAVIGATION_SETTLE_MS = 900;
/** An internal event (v1 fixtures or a normalized capture protocol event). Its fields depend on `kind`. */
type HelperEvent = Record<string, any>;

interface Application {
  name?: string;
  id?: string;
  bundleId?: string;
}

export interface RecorderArgs {
  allowApps: string[];
  onlyApps: string[];
  captureText: boolean;
  captureSearchText: boolean;
  screenshots: boolean;
  title?: string;
  out?: string;
  recordingsDir?: string;
  contextUrl?: string;
  observationSettings?: string;
  help?: boolean;
}

interface SearchInputContext {
  purpose: "search_query";
  role: string;
  label: string;
}

interface NormalizedEvent {
  eventType: string;
  application: Application;
  details: Record<string, unknown>;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

function defaultOutput(args: RecorderArgs, recordingId: string): string {
  const recordingsDir = path.resolve(expandHome(args.recordingsDir ?? DEFAULT_RECORDINGS_DIR));
  return path.join(recordingsDir, `${timestampForPath()}-${recordingId.slice(0, 8)}`, "events.jsonl");
}

function normalizedContextUrl(value: string | undefined): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--context-url must use http or https");
  if (url.username || url.password) throw new Error("--context-url must not contain credentials");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function appAllowed(application: Application | undefined, allowedApps: string[]): boolean {
  return Boolean(application && (application.id ? allowedApps.includes(application.id) : allowedApps.includes(application.bundleId ?? "")));
}

// The live protocol path supplies app.id. bundleIdentifier is accepted only
// for legacy callers of the exported normalization helpers.
export function appFrom(event: HelperEvent | undefined): Application {
  const app = event?.app ?? {};
  const application: Application = {};
  if (typeof app.name === "string") application.name = app.name;
  if (typeof app.id === "string") application.id = app.id;
  if (typeof app.bundleIdentifier === "string") application.bundleId = app.bundleIdentifier;
  return application;
}

export function isSecureInput(event: HelperEvent | undefined): boolean {
  return event?.app?.secureInput === true;
}

const SEARCH_INPUT_ROLES = new Set(["search_field", "AXSearchField"]);
const SEARCHABLE_TEXT_INPUT_ROLES = new Set(["text_field", "AXTextField", "AXComboBox"]);
const SEARCH_INPUT_HINT = /(?:\bsearch\b|\bquery\b|\bfind\b|address and search|搜索|检索|查找)/iu;

export function searchInputContextFromAccessibility(accessibility: any): SearchInputContext | null {
  if (!accessibility || typeof accessibility !== "object") return null;
  // Only the current target (or its explicitly focused element) grants text
  // retention. A search field elsewhere in a window is not evidence of focus.
  const node = accessibility.focused ?? accessibility;
  if (!node || typeof node !== "object") return null;
  const role = typeof node.role === "string" ? node.role : "";
  const subrole = typeof node.subrole === "string" ? node.subrole : "";
  if (node.isPassword === true || role === "AXSecureTextField" || subrole === "AXSecureTextField") return null;
  const label = [node.name ?? node.title, node.description, node.automationId ?? node.identifier]
    .filter((value) => typeof value === "string")
    .join(" ")
    .trim();
  if (
    SEARCH_INPUT_ROLES.has(role)
    || SEARCH_INPUT_ROLES.has(subrole)
    || (SEARCHABLE_TEXT_INPUT_ROLES.has(role) && SEARCH_INPUT_HINT.test(label))
  ) {
    return { purpose: "search_query", role: subrole || role, label: label.slice(0, 240) };
  }
  return null;
}

const REDACTED = "[REDACTED]";

// What a window shows is what Computer History exists to read, so a control's
// text is kept. Withholding every text area's value was tried and emptied the
// summaries: a text area is as often a terminal, a transcript or a document as
// a draft. What is withheld is what is never content — a password field — and
// credential patterns wherever they appear.
function keepsFieldValue(subrole: string): boolean {
  return subrole !== "AXSecureTextField";
}

/**
 * Scrubs an accessibility payload before it is written: a password field's
 * value is withheld, and every string has credential patterns masked.
 */
export function scrubAccessibility(value: unknown): unknown {
  if (typeof value === "string") return redactSensitive(value);
  if (Array.isArray(value)) return value.map((item) => scrubAccessibility(item));
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const subrole = typeof node.subrole === "string" ? node.subrole : "";
  const keep = node.isPassword !== true && keepsFieldValue(subrole) && node.role !== "AXSecureTextField";
  const scrubbed: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(node)) {
    scrubbed[key] = key === "value" && !keep && typeof field === "string" && field
      ? REDACTED
      : scrubAccessibility(field);
  }
  return scrubbed;
}

// A window snapshot line is `role|subrole|title|description|identifier|value`,
// prefixed with `+ ` or `- ` when the snapshot is a diff.
function scrubTreeLine(line: string): string {
  const prefix = /^[+-] /u.test(line) ? line.slice(0, 2) : "";
  const parts = line.slice(prefix.length).split("|");
  const [role = "", subrole = ""] = parts;
  if (keepsFieldValue(subrole)) {
    return prefix + redactSensitive(parts.join("|"));
  }
  if (parts.length === 6 && !parts[5]) return prefix + redactSensitive(parts.join("|"));
  // A `|` inside any field shifts the value to the right, so when the line does
  // not split cleanly keep only the role and drop the rest rather than guess.
  const labels = parts.length === 6 ? parts.slice(0, 5) : [role, subrole, "", "", ""];
  return prefix + [...labels.map(redactSensitive), REDACTED].join("|");
}

/** Scrubs a window snapshot, full or diff, line by line. */
export function scrubAxSnapshot(ax: unknown): unknown {
  if (!ax || typeof ax !== "object") return ax;
  const snapshot = ax as Record<string, unknown>;
  if (typeof snapshot.text !== "string") return scrubAccessibility(ax);
  return {
    ...snapshot,
    text: snapshot.text.split("\n").map((line) => scrubTreeLine(line)).join("\n"),
    ...(Array.isArray(snapshot.nodes) ? {
      nodes: snapshot.nodes.map((node) => {
        const scrubbed = scrubAccessibility(node) as Record<string, unknown>;
        if (scrubbed.isPassword === true) delete scrubbed.value;
        return scrubbed;
      }),
    } : {}),
  };
}

interface AxBaseline {
  windowKey: string;
  lines: string[];
  nodes: UiNode[] | null;
}

function prepareAuthorizedAxSnapshot(ax: unknown, previous: AxBaseline | null): {
  snapshot: Record<string, unknown> | null;
  baseline: AxBaseline | null;
} {
  const current = scrubAxSnapshot(ax) as Record<string, unknown> | null;
  // Only complete native observations can establish permission to store text.
  // Legacy/unknown diffs may contain removed text from an excluded interval.
  if (current?.mode !== "fullTree" || typeof current.text !== "string") {
    return { snapshot: null, baseline: null };
  }
  const lines = current.text.split("\n");
  const nodes = Array.isArray(current.nodes) ? current.nodes as UiNode[] : null;
  const baseline = typeof current.windowKey === "string"
    ? { windowKey: current.windowKey, lines, nodes } : null;
  if (!baseline || previous?.windowKey !== baseline.windowKey) return { snapshot: current, baseline };
  if (nodes && previous.nodes) {
    const nodeKey = (node: UiNode) => JSON.stringify({
      role: node.role,
      ...(node.nativeRole !== undefined ? { nativeRole: node.nativeRole } : {}),
      ...(node.name !== undefined ? { name: node.name } : {}),
      ...(node.description !== undefined ? { description: node.description } : {}),
      ...(node.automationId !== undefined ? { automationId: node.automationId } : {}),
      ...(node.value !== undefined ? { value: node.value } : {}),
      isPassword: node.isPassword,
    });
    const beforeKeys = previous.nodes.map(nodeKey);
    const afterKeys = nodes.map(nodeKey);
    const before = new Set(beforeKeys);
    const after = new Set(afterKeys);
    if (before.size !== beforeKeys.length || after.size !== afterKeys.length) {
      return { snapshot: current, baseline };
    }
    if (beforeKeys.length === afterKeys.length && beforeKeys.every((key, index) => key === afterKeys[index])) {
      return { snapshot: null, baseline };
    }
    const removedNodes = previous.nodes.filter((node) => !after.has(nodeKey(node)));
    const addedNodes = nodes.filter((node) => !before.has(nodeKey(node)));
    const changed = removedNodes.length + addedNodes.length;
    if (!changed || before.size !== previous.nodes.length || after.size !== nodes.length
      || changed > Math.max(nodes.length, 1) * 0.6) return { snapshot: current, baseline };
    const nodeLine = (node: UiNode) => [
      node.nativeRole ?? node.role,
      node.isPassword ? "AXSecureTextField" : "",
      node.name ?? "",
      node.description ?? "",
      node.automationId ?? "",
      node.isPassword ? "[REDACTED]" : node.value ?? "",
    ].map((value) => redactSensitive(value)).join("|");
    return {
      snapshot: { ...current, mode: "diffFromPrevious",
        text: [...removedNodes.map((node) => `- ${nodeLine(node)}`), ...addedNodes.map((node) => `+ ${nodeLine(node)}`)].join("\n"),
        addedNodes, removedNodes },
      baseline,
    };
  }
  if (previous.lines.length === lines.length && previous.lines.every((line, index) => line === lines[index])) {
    return { snapshot: null, baseline };
  }
  const before = new Set(previous.lines);
  const after = new Set(lines);
  const removed = previous.lines.filter((line) => !after.has(line));
  const added = lines.filter((line) => !before.has(line));
  const changed = removed.length + added.length;
  // Reordering/duplicate rows cannot be represented by a set-based diff.
  if (!changed || before.size !== previous.lines.length || after.size !== lines.length
    || changed > Math.max(lines.length, 1) * 0.6) return { snapshot: current, baseline };
  return { snapshot: { ...current, mode: "diffFromPrevious",
    text: [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)].join("\n") }, baseline };
}

// The recorder now classifies keystrokes itself, so the consumer no longer has
// to infer printability from modifiers: a keyboard.text_input event is text by
// construction, and secure-input windows never produce one.

// The recorder decides with the same policy the service and the agent tools
// describe. It used to carry a copy, because as a standalone script it could
// not import one, and the copy drifted: it lacked the unconditional
// exclusions, and read a missing default as "record nothing".
function loadObservationSettings(file: string | undefined): ObservationSettings {
  if (!file) return DEFAULT_OBSERVATION_SETTINGS;
  try {
    return parseObservationSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    // An explicit policy that is temporarily unreadable must not revert to
    // recording everything. The next event retries the current file.
    return { observation: {
      defaultApplicationBehavior: "do_not_observe",
      defaultURLBehavior: "do_not_observe",
      rules: [],
    } };
  }
}

function observationSubject(event: HelperEvent): ObservationSubject {
  return {
    applicationId: appFrom(event).id ?? (appFrom(event).bundleId ? `bundle:${appFrom(event).bundleId}` : null),
    systemSurface: event.privacy?.systemSurface === true,
    browser: event.window?.browser === true,
    url: typeof event.window?.url === "string" ? event.window.url : null,
    privateBrowsing: event.window?.privateBrowsing === true,
  };
}

export function shouldObserve(settings: ObservationSettings | null, subject: ObservationSubject): boolean {
  return evaluateObservation(settings ?? DEFAULT_OBSERVATION_SETTINGS, subject).observe;
}

function printableKey(event: HelperEvent): boolean {
  return event?.kind === "keyboard.text_input"
    && typeof event.keyboard?.text === "string"
    && event.keyboard.text.length > 0;
}

export function normalizeKeyBurst(
  events: HelperEvent[],
  // Search-field retention is opt-in, and absent means off.
  options: Pick<RecorderArgs, "captureText" | "allowApps"> & { captureSearchText?: boolean },
): NormalizedEvent {
  const application = appFrom(events.at(-1));
  const rawText = events.filter(printableKey).map((event) => event.keyboard.text).join("");
  const searchInput: SearchInputContext | null = events.length > 0
    && events.every((event) => event.inputContext?.purpose === "search_query")
    ? events.at(-1)!.inputContext
    : null;
  const retainText = (options.captureText && appAllowed(application, options.allowApps))
    || (options.captureSearchText && searchInput);
  if (rawText && events.every(printableKey)) {
    return {
      eventType: "text_input",
      application,
      details: retainText
        ? {
            text: redactSensitive(rawText),
            characterCount: [...rawText].length,
            redacted: false,
            ...(searchInput ? { textPurpose: "search_query", input: searchInput } : {}),
          }
        : { text: "[REDACTED]", characterCount: [...rawText].length, redacted: true },
    };
  }
  const keys = events.map((event) => {
    const keyboard = event.keyboard ?? {};
    const modifiers = keyboard.modifiers ?? [];
    const key = event.kind === "keyboard.submit" ? "return" : keyboard.keyEquivalent;
    // Defense in depth for helpers recorded before Shift/Option text was
    // classified correctly. Such characters must obey the text policy too.
    if (typeof key === "string" && [...key].length === 1
      && !modifiers.some((modifier: string) => modifier === "meta" || modifier === "cmd" || modifier === "control")) {
      return "[REDACTED]";
    }
    return [...modifiers, key].filter(Boolean).join("+");
  });
  return { eventType: "key_press", application, details: { keys } };
}

/**
 * Wraps one link of the event chain so that a failure cannot break the chain.
 *
 * Every event is chained onto one promise, and a rejected link rejects every
 * link after it: one failed write used to leave the recorder running while it
 * silently dropped every event that followed, and the service still showed it
 * recording. A write that fails cannot be retried into a destination that is
 * gone or full, so it ends the recording where the service will report it;
 * anything else costs only the event that caused it.
 */
export function recordingStep(onWriteFailure: () => void) {
  return (task: () => Promise<void>) => async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code) {
        console.error(`[recorder] skipped an event: ${(error as Error).message}`);
        return;
      }
      console.error(`[recorder] cannot write the recording (${code}): ${(error as Error).message}`);
      onWriteFailure();
    }
  };
}


function appendJsonLine(file: string, payload: unknown): void {
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
}

export async function createRecordingPipeline(args: RecorderArgs, options: {
  platform: "macos" | "windows";
  defaultTitle: string;
  display: PreparedCollector["display"];
  captureScreenshot?: PreparedCollector["captureScreenshot"];
  onFailure(error: Error): void;
}) {
  const recordingId = `human:${crypto.randomUUID()}`;
  const contextUrl = normalizedContextUrl(args.contextUrl);
  const output = path.resolve(expandHome(args.out ?? defaultOutput(args, recordingId)));
  const recordingDir = path.dirname(output);
  const screenshotDir = path.join(recordingDir, "screenshots");
  fs.mkdirSync(recordingDir, { recursive: true });

  const startedAt = new Date().toISOString();
  let metadataWritten = false;
  let sequence = 0;
  // Pause/resume appends another helper run to the same segment. Disk
  // sequence numbers must keep increasing independently of helper sequence.
  if (fs.existsSync(output)) {
    const existingLines = readline.createInterface({ input: fs.createReadStream(output), crlfDelay: Infinity });
    for await (const line of existingLines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.recordType === "human_event" && Number.isSafeInteger(record.sequence)) {
        sequence = Math.max(sequence, record.sequence);
      }
    }
  }
  let lastPageContextUrl: string | null = null;
  let axBaseline: AxBaseline | null = null;
  let observationPolicyVersion: string | null = null;
  const writeMetadata = () => {
    if (metadataWritten) return;
    metadataWritten = true;
    appendJsonLine(output, {
      recordType: "human_history_metadata",
      schemaVersion: 2,
      recordingId,
      title: args.title ?? options.defaultTitle,
      createdAt: startedAt,
      platform: options.platform,
      captureProtocolVersion: 1,
      display: { width: options.display.width, height: options.display.height },
      captureText: args.captureText,
      captureSearchText: args.captureSearchText,
      allowedApplications: args.allowApps,
      captureScopeApplications: args.onlyApps,
      ...(contextUrl ? { contextUrl } : {}),
      privacy: "Search/address-field text is retained only when explicitly enabled; other text is retained only for allowed application IDs. Common credential patterns are redacted.",
    });
  };
  const canObserve = (subject: ObservationSubject) => {
    const settings = loadObservationSettings(args.observationSettings);
    const version = JSON.stringify(settings);
    if (version !== observationPolicyVersion) {
      axBaseline = null;
      observationPolicyVersion = version;
    }
    const allowed = shouldObserve(settings, subject);
    if (!allowed) axBaseline = null;
    return allowed;
  };
  let pendingKeys: HelperEvent[] = [];
  let pendingKeyTimer: ReturnType<typeof setTimeout> | null = null;
  let processing: Promise<void> = Promise.resolve();
  const appendEvent = async (
    {
      eventType,
      timestamp,
      application = { id: "internal:computer-history", name: "Computer History" },
      details = {},
      ax = null,
      subjects,
      source,
    }: {
      eventType: string;
      timestamp?: string;
      application?: Application;
      details?: Record<string, unknown>;
      ax?: unknown;
      subjects?: ObservationSubject[];
      source?: { runId: string; sequence: number };
    },
    screenshot = false,
  ) => {
    const permitted = () => !subjects || subjects.every(canObserve);
    if (!permitted()) return;
    let screenshotPath = null;
    if (args.screenshots && screenshot) {
      screenshotPath = path.join(screenshotDir, `${String(sequence + 1).padStart(4, "0")}-${eventType}.jpg`);
      try {
        await options.captureScreenshot!(screenshotPath, options.display.width);
      } catch (error) {
        fs.rmSync(screenshotPath, { force: true });
        screenshotPath = null;
        details = { ...details, screenshotError: (error as Error).message };
      }
    }
    // Settings can change while capture awaits a system process. Never keep
    // the resulting image or event after its application/site was excluded.
    if (!permitted()) {
      if (screenshotPath) fs.rmSync(screenshotPath, { force: true });
      return;
    }
    // There are no awaits between computing this delta and committing its
    // baseline. Thus it can only refer to permitted snapshots already on disk.
    const preparedAx = ax ? prepareAuthorizedAxSnapshot(ax, axBaseline) : null;
    if (ax && !preparedAx?.snapshot && eventType === "accessibility_snapshot") {
      axBaseline = preparedAx?.baseline ?? null;
      return;
    }
    // Every event is written through here, so this is where accessibility
    // text is scrubbed: a new event type cannot forget to.
    appendJsonLine(output, toHistoryV2Event({
      sequence: ++sequence,
      timestamp: timestamp ?? new Date().toISOString(),
      eventType,
      application,
      details: scrubAccessibility(details) as Record<string, unknown>,
      ax: preparedAx?.snapshot as {
        mode?: string;
        windowKey?: string;
        text?: string;
        nodes?: UiNode[];
        addedNodes?: UiNode[];
        removedNodes?: UiNode[];
      } | undefined,
      source,
      screenshot: screenshotPath ?? undefined,
    }));
    if (preparedAx) axBaseline = preparedAx.baseline;
  };

  const flushKeys = async () => {
    if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
    pendingKeyTimer = null;
    if (!pendingKeys.length) return;
    const events = pendingKeys.filter((event) => canObserve(observationSubject(event)));
    pendingKeys = [];
    if (!events.length) return;
    const normalized = normalizeKeyBurst(events, args);
    await appendEvent({ ...normalized, timestamp: events[0].timestamp,
      subjects: events.map(observationSubject), source: events.at(-1)?.captureSource });
  };

  let failure: Error | null = null;
  const safely = (task: () => Promise<void>) => async () => {
    if (failure) return;
    try { await task(); } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      options.onFailure(failure);
      throw failure;
    }
  };
  const scheduleKeyFlush = () => {
    if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
    pendingKeyTimer = setTimeout(() => {
      processing = processing.then(safely(flushKeys));
      void processing.catch(() => undefined);
    }, TEXT_IDLE_MS);
  };

  const ingest = async (event: HelperEvent) => {
    const application = appFrom(event);
    if (event.kind === "session.ended") return;
    if (args.onlyApps.length && !appAllowed(application, args.onlyApps)) {
      axBaseline = null;
      return;
    }
    const subjects = [observationSubject(event)];
    if (!canObserve(subjects[0])) {
      pendingKeys = pendingKeys.filter((pending) => canObserve(observationSubject(pending)));
      return;
    }

    if (event.kind === "session.started") {
      await appendEvent({
        eventType: "recording_started",
        timestamp: event.timestamp,
        application,
        subjects,
        details: { goal: args.title ?? options.defaultTitle },
        ax: event.ax,
        source: event.captureSource,
      }, true);
      return;
    }
    // Authorize every full native snapshot before constructing any persisted
    // delta, independently of input burst merging or normalized action types.
    if (event.ax) {
      await appendEvent({
        eventType: "accessibility_snapshot",
        timestamp: event.timestamp,
        application,
        subjects,
        ax: event.ax,
        source: event.captureSource,
      });
    }

    // The URL now rides on every event's window envelope instead of arriving as
    // its own recorder event, so page context is derived from a change in it.
    const windowUrl = typeof event.window?.url === "string" ? event.window.url : null;
    if (windowUrl && windowUrl !== lastPageContextUrl) {
      lastPageContextUrl = windowUrl;
      await flushKeys();
      await appendEvent({
        eventType: "page_context",
        timestamp: event.timestamp,
        application,
        subjects,
        source: event.captureSource,
        details: {
          url: windowUrl,
          ...(typeof event.window?.title === "string"
            ? { title: redactSensitive(event.window.title) }
            : {}),
        },
      });
    }

    // A snapshot is its own protocol event. It updates the persisted AX tree,
    // but must not split a text burst that is otherwise continuous across
    // adjacent keystroke events.
    if (event.kind === "ui.snapshot") return;

    if (event.kind === "keyboard.text_input") {
      if (isSecureInput(event) || event.privacy?.passwordTarget || event.keyboard?.target?.isPassword) return;
      const inputContext = searchInputContextFromAccessibility(event.keyboard?.target);
      event = { ...event, inputContext };
      const previous = pendingKeys.at(-1);
      if (previous && ((appFrom(previous).id ?? appFrom(previous).bundleId) !== (application.id ?? application.bundleId)
        || JSON.stringify(previous.inputContext) !== JSON.stringify(inputContext)
        || JSON.stringify(observationSubject(previous)) !== JSON.stringify(subjects[0]))) {
        await flushKeys();
      }
      pendingKeys.push(event);
      scheduleKeyFlush();
      return;
    }

    if (event.kind === "keyboard.shortcut" || event.kind === "keyboard.submit") {
      await flushKeys();
      // Submitting in a browser starts a navigation; give it a moment so the
      // next captured state is the destination rather than the old page.
      const captureAfterNavigation = event.kind === "keyboard.submit"
        && event.window?.browser === true && args.screenshots;
      if (captureAfterNavigation) {
        await new Promise<void>((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS));
      }
      await appendEvent({ ...normalizeKeyBurst([event], args), subjects, source: event.captureSource }, captureAfterNavigation);
      return;
    }

    await flushKeys();

    if (event.kind === "window.changed") {
      await appendEvent({
        eventType: "application_changed",
        timestamp: event.timestamp,
        application,
        subjects,
        source: event.captureSource,
      }, true);
      return;
    }

    if (event.kind === "mouse.click" || event.kind === "mouse.context_menu") {
      const target = event.mouse?.target ?? null;
      await appendEvent({
        eventType: "mouse_click",
        timestamp: event.timestamp,
        application,
        subjects,
        source: event.captureSource,
        details: {
          button: event.mouse?.button ?? "left",
          clickCount: event.mouse?.clickCount ?? 1,
          ...(event.kind === "mouse.context_menu" ? { contextMenu: true } : {}),
          ...(target ? { accessibility: target } : {}),
        },
      }, true);
      return;
    }

    if (event.kind === "mouse.drag") {
      await appendEvent({
        eventType: "mouse_drag",
        timestamp: event.timestamp,
        application,
        subjects,
        source: event.captureSource,
        details: {
          origin: event.mouse?.origin ?? null,
          destination: event.mouse?.destination ?? null,
        },
      }, true);
      return;
    }

    // Selected text is evidence about what the user is reading, so it obeys the
    // same retention rule as typed text rather than being kept unconditionally.
    if (event.kind === "selection.changed") {
      const selectedText = event.selection?.selectedText;
      if (typeof selectedText !== "string" || !selectedText) return;
      const retain = args.captureText && appAllowed(application, args.allowApps);
      await appendEvent({
        eventType: "selection_changed",
        timestamp: event.timestamp,
        application,
        subjects,
        source: event.captureSource,
        details: {
          characterCount: [...selectedText].length,
          ...(retain
            ? { text: redactSensitive(selectedText), redacted: false }
            : { text: "[REDACTED]", redacted: true }),
          ...(event.selection?.target ? { accessibility: event.selection.target } : {}),
        },
      });
    }
  };


  let stopped = false;
  return {
    output, recordingId,
    get events() { return sequence; },
    async start() {
      writeMetadata();
      await appendEvent({ eventType: "recording_started", timestamp: startedAt,
        application: { id: "internal:computer-history", name: "Computer History" },
        details: { goal: args.title ?? options.defaultTitle } });
    },
    async event(event: CaptureEvent) {
      processing = processing.then(safely(() => ingest(captureEventToRecordingEvent(event))));
      await processing;
    },
    async gap(message: { fromSequence: number; toSequence: number; reason: string; runId: string }) {
      await processing;
      axBaseline = null;
      await flushKeys();
      await appendEvent({ eventType: "capture_gap",
        details: { fromSequence: message.fromSequence, toSequence: message.toSequence, reason: message.reason },
        source: { runId: message.runId, sequence: message.toSequence } });
    },
    async stop(reason: string) {
      if (stopped) return;
      stopped = true;
      if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
      pendingKeyTimer = null;
      await processing;
      await flushKeys();
      if (metadataWritten) await appendEvent({ eventType: "recording_stopped", details: { reason } });
    },
    dispose() {
      if (pendingKeyTimer) clearTimeout(pendingKeyTimer);
      pendingKeyTimer = null;
      pendingKeys = [];
    },
  };
}

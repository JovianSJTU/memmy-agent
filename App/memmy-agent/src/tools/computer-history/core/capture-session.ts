import {
  CaptureProtocolError,
  parseCaptureMessage,
  type CaptureEvent,
  type CaptureMessage,
  type UiNode,
  type UiTarget,
} from "./capture-protocol.js";

/** Enforces one helper process's ready, run ID, sequence, gap and stop contract. */
export class CaptureStreamSession {
  private runId: string | null = null;
  private lastSequence = 0;
  private stopped = false;

  accept(line: string): CaptureMessage {
    const message = parseCaptureMessage(line);
    if (!this.runId) {
      if (message.type !== "ready") throw new CaptureProtocolError("capture helper must send ready first");
      this.runId = message.runId;
      return message;
    }
    if (this.stopped) throw new CaptureProtocolError("capture helper sent a message after stopped");
    if (message.type === "ready") throw new CaptureProtocolError("capture helper sent ready more than once");
    if (message.runId !== this.runId) throw new CaptureProtocolError("capture helper changed runId");
    if (message.type === "event") {
      if (message.sequence !== this.lastSequence + 1) {
        throw new CaptureProtocolError(`capture event sequence ${message.sequence} does not follow ${this.lastSequence}`);
      }
      this.lastSequence = message.sequence;
    } else if (message.type === "gap") {
      if (message.fromSequence !== this.lastSequence + 1) {
        throw new CaptureProtocolError(`capture gap starts at ${message.fromSequence}, expected ${this.lastSequence + 1}`);
      }
      this.lastSequence = message.toSequence;
    } else if (message.type === "heartbeat") {
      if (message.lastSequence !== this.lastSequence) {
        throw new CaptureProtocolError("heartbeat lastSequence does not match the received stream");
      }
    } else if (message.type === "stopped") {
      if (message.lastSequence !== this.lastSequence) {
        throw new CaptureProtocolError("stopped lastSequence does not match the received stream");
      }
      this.stopped = true;
    }
    return message;
  }

  get currentRunId(): string | null { return this.runId; }
  get currentSequence(): number { return this.lastSequence; }
  get isStopped(): boolean { return this.stopped; }
}

function legacyNode(node: UiNode | null): Record<string, unknown> | null {
  if (!node) return null;
  return {
    role: node.nativeRole ?? node.role,
    ...(node.nativeRole ? { subrole: node.nativeRole } : {}),
    ...(node.name ? { title: node.name } : {}),
    ...(node.description ? { description: node.description } : {}),
    ...(node.automationId ? { identifier: node.automationId } : {}),
    ...(node.value && !node.isPassword ? { value: node.value } : {}),
    ...(node.isPassword ? { subrole: "AXSecureTextField" } : {}),
  };
}

function legacyTarget(target: UiTarget | null): Record<string, unknown> | null {
  if (!target) return null;
  return {
    ...(legacyNode(target.element) ?? { role: "AXUnknown" }),
    ...(target.ancestors?.length ? { ancestors: target.ancestors.map((node) => legacyNode(node)) } : {}),
    ...(target.descendants?.length ? { descendants: target.descendants.map((node) => legacyNode(node)) } : {}),
  };
}

/** Temporary compatibility adapter to preserve Mac's existing v1 event logic. */
export function captureEventToLegacy(event: CaptureEvent): Record<string, any> {
  const { context, kind, data } = event;
  const bundleId = context.application.id.startsWith("bundle:")
    ? context.application.id.slice("bundle:".length)
    : context.application.id;
  const base = {
    timestamp: event.occurredAt,
    app: {
      name: context.application.name,
      bundleIdentifier: bundleId,
      secureInput: context.privacy.secureInput,
    },
    window: {
      id: context.window.id,
      title: context.window.title,
      browser: context.window.isBrowser,
      ...(context.window.page.state === "known" ? { url: context.window.page.url } : {}),
      privateBrowsing: context.privacy.privateWindow === "yes",
    },
    captureSource: { runId: event.runId, sequence: event.sequence },
  };
  switch (kind) {
    case "app.activated":
    case "window.changed":
      return { ...base, kind: "window.changed" };
    case "page.changed":
      return { ...base, kind: "page.changed" };
    case "pointer.click":
      return {
        ...base,
        kind: data.button === "right" ? "mouse.context_menu" : "mouse.click",
        mouse: { button: data.button, clickCount: data.clickCount, target: legacyTarget(data.target) },
      };
    case "pointer.drag":
      return { ...base, kind: "mouse.drag", mouse: {
        origin: legacyTarget(data.origin), destination: legacyTarget(data.destination),
      } };
    case "keyboard.shortcut": {
      const modifiers = data.modifiers.map((modifier) => modifier === "meta" ? "cmd" : modifier === "alt" ? "option" : modifier);
      return { ...base, kind: "keyboard.shortcut", keyboard: {
        keyEquivalent: data.key,
        ...(data.key === "keycode-15" ? { keyCode: 15 } : {}),
        modifiers,
        target: legacyTarget(data.target),
      } };
    }
    case "keyboard.submit":
      return { ...base, kind: "keyboard.submit", keyboard: { keyEquivalent: "return", target: legacyTarget(data.target) } };
    case "keyboard.text":
      return { ...base, kind: "keyboard.text_input", keyboard: { text: data.text, target: legacyTarget(data.target) } };
    case "selection.changed":
      return { ...base, kind: "selection.changed", selection: {
        selectedText: context.privacy.secureInput || context.privacy.passwordTarget || data.target?.element?.isPassword
          ? null : data.selectedText,
        target: legacyTarget(data.target),
      } };
    case "ui.snapshot": {
      const lines = data.nodes.map((node) => [
        node.nativeRole ?? node.role,
        node.isPassword ? "AXSecureTextField" : "",
        node.name ?? "",
        node.description ?? "",
        node.automationId ?? "",
        node.isPassword ? "[REDACTED]" : node.value ?? "",
      ].join("|"));
      return { ...base, kind: "ui.snapshot", ax: {
        mode: "fullTree", windowKey: data.windowKey, text: lines.join("\n"), nodes: data.nodes,
      } };
    }
  }
}

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ensureNativeHistoryHelper } from "./native-helper.js";
import { parseArgs, runRecorder } from "../core/recorder.js";
import type { CapturePlatform } from "../core/platform.js";
import { DEFAULT_OBSERVATION_SETTINGS, evaluateObservation, type ObservationSettings, type ObservationSubject } from "./observation-settings.js";
export { parseArgs } from "../core/recorder.js";
export { appFrom, isSecureInput, normalizeKeyBurst, searchInputContextFromAccessibility, scrubAccessibility, scrubAxSnapshot, recordingStep } from "../core/recording-pipeline.js";
export type { RecorderArgs } from "../core/recording-pipeline.js";
type HelperEvent = Record<string, any>;
interface RecorderPermissions {
  inputMonitoring: boolean; screenRecording: boolean; accessibility: boolean;
  mainDisplayWidth: number; mainDisplayHeight: number;
}
const execFileAsync = promisify(execFile);
const HELPER_SOURCE = fileURLToPath(new URL("./human-recorder.swift", import.meta.url));
function usage(): void {
  console.log(`Usage:
  node dist/tools/computer-history/mac/record-human-history.js [options]

Options:
  --title <text>          recording goal shown in the History Markdown
  --out <events.jsonl>    explicit output path
  --recordings-dir <dir>  generated recording root
  --context-url <url>     approved starting page recorded without query or fragment
  --capture-search-text   retain text typed into recognized search/address fields
  --capture-text          retain text only in explicitly allowed applications
  --allow-app <bundle-id> application allowed to retain text; repeatable
  --only-app <bundle-id>  record events only from this approved app; repeatable
  --no-screenshots        record events without key screenshots
  --help                  show this help

Press control+option+cmd+r while the result remains visible to stop recording.
Returning to this terminal and pressing Enter (or Ctrl+C) is also supported.`);
}

async function helperJson(binary: string, mode: string, extraArgs: string[] = []): Promise<RecorderPermissions> {
  const { stdout } = await execFileAsync(binary, [mode, ...extraArgs], { timeout: 60_000 });
  return JSON.parse(stdout.trim());
}

export async function checkPermissions(
  binary: string,
  { screenshots = true, accessibility = true }: { screenshots?: boolean; accessibility?: boolean } = {},
  readPermissions: typeof helperJson = helperJson,
): Promise<RecorderPermissions> {
  let permissions = await readPermissions(binary, "--permissions");
  const missingRequiredPermission = () => (
    !permissions.inputMonitoring
      || (screenshots && !permissions.screenRecording)
      || (accessibility && !permissions.accessibility)
  );
  if (missingRequiredPermission()) {
    const requests: string[] = [];
    if (!permissions.inputMonitoring) requests.push("--request-input-monitoring");
    if (screenshots && !permissions.screenRecording) requests.push("--request-screen-recording");
    if (accessibility && !permissions.accessibility) requests.push("--request-accessibility");
    permissions = await readPermissions(binary, "--permissions", requests);
  }
  if (missingRequiredPermission()) {
    const missing: string[] = [];
    if (!permissions.inputMonitoring) missing.push("Input Monitoring");
    if (screenshots && !permissions.screenRecording) missing.push("Screen Recording");
    if (accessibility && !permissions.accessibility) missing.push("Accessibility");
    throw new Error(
      `missing macOS permission: ${missing.join(", ")}. Grant it to the terminal/app running this command in System Settings > Privacy & Security, restart that app, then run again.`,
    );
  }
  return permissions;
}

async function captureScreenshot(file: string, width: number): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await execFileAsync("screencapture", ["-x", "-C", "-D", "1", "-t", "jpg", file], {
    timeout: 30_000,
  });
  await execFileAsync("sips", ["--resampleWidth", String(width), "-s", "formatOptions", "80", file], {
    timeout: 30_000,
  });
  return file;
}

export function isStopHotkey(event: HelperEvent | undefined): boolean {
  const modifiers = new Set(event?.keyboard?.modifiers ?? []);
  const stopKey = event?.keyboard?.keyCode === 15 || event?.keyboard?.keyEquivalent === "r";
  return event?.kind === "keyboard.shortcut"
    && stopKey
    && modifiers.has("cmd")
    && modifiers.has("control")
    && modifiers.has("option");
}


export function shouldObserve(settings: ObservationSettings | null, subject: ObservationSubject): boolean {
  return evaluateObservation(settings ?? DEFAULT_OBSERVATION_SETTINGS, subject).observe;
}
export const macCapturePlatform: CapturePlatform = {
  platform: "macos",
  defaultTitle: "Human-operated macOS workflow",
  stopHint: "keep the final result visible and press control+option+cmd+r to stop.",
  normalizeApplicationId: id => id.startsWith("bundle:") ? id : `bundle:${id}`,
  isStopEvent: event => event.kind === "keyboard.shortcut"
    && ["r", "keycode-15"].includes(event.data.key)
    && (["meta", "control", "alt"] as const).every(modifier => event.data.modifiers.includes(modifier)),
  async prepare(options) {
    if (process.platform !== "darwin") throw new Error("the human history recorder currently supports macOS only");
    const binary = await ensureNativeHistoryHelper(HELPER_SOURCE, "human-history-recorder");
    const permissions = await checkPermissions(binary, options);
    return {
      display: { width: permissions.mainDisplayWidth, height: permissions.mainDisplayHeight },
      start: () => spawn(binary, ["--capture-protocol-v1"], { stdio: ["pipe", "pipe", "pipe"] }),
      captureScreenshot,
    };
  },
};
export async function run(argv: string[] = process.argv) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return null; }
  return runRecorder(args, macCapturePlatform);
}
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await run();
  } catch (error) {
    console.error(`human history recording failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { CaptureEvent } from "./capture-protocol.js";

/** Consent capabilities exposed to the existing desktop/API contract. */
export type HistoryPermission = "accessibility" | "inputMonitoring";
export interface HistoryPermissions {
  supported: boolean;
  accessibility: boolean;
  inputMonitoring: boolean;
}

export interface RecorderCommand {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** OS-owned services; segmentation, persistence and summaries stay in core. */
export interface HistoryServicePlatform {
  recorderScript: string;
  recorderCommand(script: string): RecorderCommand;
  readPermissions(): Promise<HistoryPermissions>;
  openPermission(permission: HistoryPermission, mode: "request" | "settings"): Promise<HistoryPermissions>;
  permissionsFromError(message: string): HistoryPermissions | null;
  applicationIcon(applicationId: string): Promise<string | null>;
}

/** A collector returns a v1 NDJSON stream; it never writes history files. */
export interface PreparedCollector {
  display: { width: number; height: number };
  start(): ChildProcessWithoutNullStreams;
  captureScreenshot?(file: string, width: number): Promise<string>;
}

export interface CapturePlatform {
  platform: "macos" | "windows";
  defaultTitle: string;
  stopHint: string;
  prepare(options: { screenshots: boolean }): Promise<PreparedCollector>;
  isStopEvent(event: CaptureEvent): boolean;
  /** Accept historical Mac CLI bundle IDs only inside its platform adapter. */
  normalizeApplicationId(id: string): string;
}

// Keep existing imports and defaults while the business service is shared across platforms.
export * from "../core/computer-history-api.js";
import { ComputerHistoryDemoService as SharedService, ComputerHistoryApiError } from "../core/computer-history-api.js";
import fs from "node:fs";
import { ApplicationIconReader } from "./application-icon.js";
import { readHistoryPermissions, openHistoryPermission } from "./permissions.js";
import { computerHistoryPermissionError } from "../../computer-use/mac-permission-settings.js";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export class ComputerHistoryDemoService extends SharedService {
  constructor(input: ConstructorParameters<typeof SharedService>[0] = {}) {
    const recorderScript = input.recorderScript ?? fileURLToPath(new URL("./record-human-history.js", import.meta.url));
    const icons = new ApplicationIconReader();
    super({ ...input, recorderScript, platformDriver: input.platformDriver ?? {
      launch: ({ title, eventsFile, observationSettingsFile }) => {
        if (!fs.existsSync(recorderScript)) throw new ComputerHistoryApiError(503, "recorder script is unavailable");
        return spawn(process.execPath, [
          recorderScript, "--title", title, "--out", eventsFile, "--no-screenshots", "--capture-search-text",
          "--observation-settings", observationSettingsFile,
        ], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      },
      readPermissions: readHistoryPermissions,
      openPermission: openHistoryPermission,
      permissionError: (message) => {
        const permission = computerHistoryPermissionError(message);
        return permission === "accessibility" || permission === "inputMonitoring" ? permission : null;
      },
      iconFor: (applicationId) => icons.iconFor(applicationId),
    } });
  }
}

let defaultService: ComputerHistoryDemoService | null = null;
export function getComputerHistoryDemoService(): ComputerHistoryDemoService {
  return defaultService ??= new ComputerHistoryDemoService();
}

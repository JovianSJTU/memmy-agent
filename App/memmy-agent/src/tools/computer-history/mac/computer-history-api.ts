// Preserve the public Mac entry point while the service runs in shared core.
import { fileURLToPath } from "node:url";
import { ComputerHistoryService } from "../core/history-service.js";
import type { HistoryServicePlatform } from "../core/platform.js";
import { computerHistoryPermissionError } from "../../computer-use/mac-permission-settings.js";
import { ApplicationIconReader } from "./application-icon.js";
import { readHistoryPermissions, openHistoryPermission } from "./permissions.js";
export * from "../core/history-service.js";

export function createMacHistoryPlatform(): HistoryServicePlatform {
  const icons = new ApplicationIconReader();
  return {
    recorderScript: fileURLToPath(new URL("./record-human-history.js", import.meta.url)),
    recorderCommand: (script) => ({ executable: process.execPath, args: [script] }),
    readPermissions: readHistoryPermissions,
    openPermission: openHistoryPermission,
    applicationIcon: (id) => icons.iconFor(id.startsWith("bundle:") ? id.slice(7) : id),
    permissionsFromError: (message) => {
      const permission = computerHistoryPermissionError(message);
      return permission === "accessibility" || permission === "inputMonitoring"
        ? { supported: true, accessibility: !message.includes("Accessibility"), inputMonitoring: !message.includes("Input Monitoring") }
        : null;
    },
  };
}

export class ComputerHistoryDemoService extends ComputerHistoryService {
  constructor(input: Omit<ConstructorParameters<typeof ComputerHistoryService>[0], "platform"> = {}) {
    super({ ...input, platform: createMacHistoryPlatform() });
  }
}
let defaultService: ComputerHistoryDemoService | null = null;
export function getComputerHistoryDemoService(): ComputerHistoryDemoService {
  return defaultService ??= new ComputerHistoryDemoService();
}

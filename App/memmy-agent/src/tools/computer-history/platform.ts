/** Supported desktop hosts; capture readiness is checked by each platform driver. */
export function isComputerHistorySupported(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

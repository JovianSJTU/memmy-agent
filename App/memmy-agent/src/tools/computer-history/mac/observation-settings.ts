// macOS compatibility adapter. The policy engine lives in `core`; this module
// maps the historical bundleId-shaped API and supplies Mac-owned identities.
import {
  DEFAULT_OBSERVATION_SETTINGS,
  evaluateObservation as evaluateCoreObservation,
  type ObservationDecision,
  type ObservationSettings as CoreObservationSettings,
} from "../core/observation-settings.js";

export {
  DEFAULT_OBSERVATION_SETTINGS,
  ObservationSettingsError,
  hostFromUrl,
  parseObservationSettings,
  type ApplicationRule,
  type ObservationBehavior,
  type ObservationRule,
  type UrlRule,
} from "../core/observation-settings.js";

export type ObservationSettings = CoreObservationSettings;

export interface ObservationSubject {
  bundleId?: string | null;
  browser?: boolean;
  url?: string | null;
  privateBrowsing?: boolean;
}

const SYSTEM_SURFACE_BUNDLE_IDS = new Set(["com.apple.loginwindow", "com.apple.ScreenSaver.Engine"]);

export const BROWSER_BUNDLE_IDS = new Set([
  "com.google.Chrome", "com.google.Chrome.canary", "com.apple.Safari",
  "com.apple.SafariTechnologyPreview", "company.thebrowser.Browser",
  "com.microsoft.edgemac", "com.brave.Browser", "org.mozilla.firefox",
  "org.chromium.Chromium", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
]);

export function evaluateObservation(
  settings: ObservationSettings,
  subject: ObservationSubject,
): ObservationDecision {
  const bundleId = subject.bundleId ?? null;
  return evaluateCoreObservation(settings, {
    applicationId: bundleId ? `bundle:${bundleId}` : null,
    browser: subject.browser === true || BROWSER_BUNDLE_IDS.has(bundleId ?? ""),
    url: subject.url,
    privateBrowsing: subject.privateBrowsing,
    systemSurface: Boolean(bundleId && SYSTEM_SURFACE_BUNDLE_IDS.has(bundleId)),
  });
}

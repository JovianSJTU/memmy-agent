// Platform-neutral observation policy. Platform adapters provide normalized
// application IDs and facts such as whether a window is a system surface.

export type ObservationBehavior = "observe" | "do_not_observe";

export type ApplicationRule =
  | { scope: "app"; applicationId: string; behavior: ObservationBehavior }
  // Kept for reading and writing existing Mac settings. It matches only a
  // normalized `bundle:<id>` subject; it is never compared with an exe path.
  | { scope: "app"; bundleID: string; behavior: ObservationBehavior };

export interface UrlRule {
  scope: "url";
  /** Bare domain. Matches the domain itself and any subdomain of it. */
  urlDomain: string;
  behavior: ObservationBehavior;
}

export type ObservationRule = ApplicationRule | UrlRule;

export interface ObservationSettings {
  observation: {
    defaultApplicationBehavior: ObservationBehavior;
    defaultURLBehavior: ObservationBehavior;
    rules: ObservationRule[];
  };
}

export interface ObservationSubject {
  /** Stable cross-platform identity, for example `bundle:com.example.App`. */
  applicationId?: string | null;
  browser?: boolean;
  url?: string | null;
  privateBrowsing?: boolean;
  systemSurface?: boolean;
}

export interface ObservationDecision {
  observe: boolean;
  reason:
    | "observed"
    | "private_browsing"
    | "system_surface"
    | "application_blocked"
    | "application_not_allowed"
    | "url_blocked"
    | "url_not_allowed";
}

export const DEFAULT_OBSERVATION_SETTINGS: ObservationSettings = {
  observation: {
    defaultApplicationBehavior: "observe",
    defaultURLBehavior: "observe",
    rules: [],
  },
};

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

/** Returns the host of an absolute http(s) URL, or null. */
export function hostFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return normalizeDomain(parsed.hostname) || null;
  } catch {
    return null;
  }
}

function domainMatches(host: string, domain: string): boolean {
  const normalized = normalizeDomain(domain);
  return Boolean(normalized) && (host === normalized || host.endsWith(`.${normalized}`));
}

function resolveAxis(matching: ObservationRule[], fallback: ObservationBehavior): ObservationBehavior {
  if (matching.some((rule) => rule.behavior === "do_not_observe")) return "do_not_observe";
  if (matching.some((rule) => rule.behavior === "observe")) return "observe";
  return fallback;
}

export function evaluateObservation(
  settings: ObservationSettings,
  subject: ObservationSubject,
): ObservationDecision {
  if (subject.privateBrowsing) return { observe: false, reason: "private_browsing" };
  if (subject.systemSurface) return { observe: false, reason: "system_surface" };
  // A permissive application default cannot authorize an event without a
  // stable identity: there would be no meaningful way to apply user rules.
  if (!subject.applicationId) return { observe: false, reason: "application_not_allowed" };

  const { defaultApplicationBehavior, defaultURLBehavior, rules } = settings.observation;
  const appRules = rules.filter((rule): rule is ApplicationRule => {
    if (rule.scope !== "app") return false;
    return "applicationId" in rule
      ? rule.applicationId === subject.applicationId
      : `bundle:${rule.bundleID}` === subject.applicationId;
  });
  if (resolveAxis(appRules, defaultApplicationBehavior) === "do_not_observe") {
    return {
      observe: false,
      reason: appRules.length ? "application_blocked" : "application_not_allowed",
    };
  }

  // Native apps have no website axis. A browser with an unknown URL cannot
  // prove that it is outside a blocked site or inside a website allowlist.
  const host = subject.url ? hostFromUrl(subject.url) : null;
  if (!host) {
    const restrictsWebsites = defaultURLBehavior === "do_not_observe"
      || rules.some((rule) => rule.scope === "url" && rule.behavior === "do_not_observe");
    return subject.browser && restrictsWebsites
      ? { observe: false, reason: "url_not_allowed" }
      : { observe: true, reason: "observed" };
  }

  const urlRules = rules.filter(
    (rule): rule is UrlRule => rule.scope === "url" && domainMatches(host, rule.urlDomain),
  );
  if (resolveAxis(urlRules, defaultURLBehavior) === "do_not_observe") {
    return { observe: false, reason: urlRules.length ? "url_blocked" : "url_not_allowed" };
  }
  return { observe: true, reason: "observed" };
}

export class ObservationSettingsError extends Error {}

function assertBehavior(value: unknown, field: string): ObservationBehavior {
  if (value !== "observe" && value !== "do_not_observe") {
    throw new ObservationSettingsError(`${field} must be "observe" or "do_not_observe"`);
  }
  return value;
}

/** Validates and normalizes a complete settings document. */
export function parseObservationSettings(input: unknown): ObservationSettings {
  if (!input || typeof input !== "object") {
    throw new ObservationSettingsError("settings must be an object");
  }
  const observation = (input as { observation?: unknown }).observation;
  if (!observation || typeof observation !== "object") {
    throw new ObservationSettingsError("settings.observation is required");
  }
  const source = observation as Record<string, unknown>;
  const rawRules = source.rules ?? [];
  if (!Array.isArray(rawRules)) {
    throw new ObservationSettingsError("settings.observation.rules must be an array");
  }

  const rules = rawRules.map((rule, index): ObservationRule => {
    if (!rule || typeof rule !== "object") {
      throw new ObservationSettingsError(`rules[${index}] must be an object`);
    }
    const entry = rule as Record<string, unknown>;
    const behavior = assertBehavior(entry.behavior, `rules[${index}].behavior`);
    if (entry.scope === "app") {
      if (entry.applicationId !== undefined && entry.bundleID !== undefined) {
        throw new ObservationSettingsError(
          `rules[${index}] must use either applicationId or the legacy bundleID, not both`,
        );
      }
      if (entry.applicationId !== undefined) {
        if (typeof entry.applicationId !== "string") {
          throw new ObservationSettingsError(`rules[${index}].applicationId must be a string`);
        }
        const applicationId = entry.applicationId.trim();
        if (!/^(?:bundle|exe|aumid):.+$/s.test(applicationId) || /[\u0000-\u001f]/.test(applicationId)) {
          throw new ObservationSettingsError(`rules[${index}].applicationId must be a normalized application ID`);
        }
        return { scope: "app", applicationId, behavior };
      }
      if (typeof entry.bundleID === "string" && entry.bundleID.trim()) {
        return { scope: "app", bundleID: entry.bundleID.trim(), behavior };
      }
      throw new ObservationSettingsError(
        `rules[${index}].applicationId or bundleID is required for app rules`,
      );
    }
    if (entry.scope === "url") {
      const urlDomain = entry.urlDomain;
      if (typeof urlDomain !== "string" || !normalizeDomain(urlDomain)) {
        throw new ObservationSettingsError(`rules[${index}].urlDomain is required for url rules`);
      }
      if (/^[a-z]+:\/\//i.test(urlDomain) || urlDomain.includes("/")) {
        throw new ObservationSettingsError(`rules[${index}].urlDomain must be a bare domain, not a URL`);
      }
      return { scope: "url", urlDomain: normalizeDomain(urlDomain), behavior };
    }
    throw new ObservationSettingsError(`rules[${index}].scope must be "app" or "url"`);
  });

  return {
    observation: {
      defaultApplicationBehavior: assertBehavior(
        source.defaultApplicationBehavior,
        "settings.observation.defaultApplicationBehavior",
      ),
      defaultURLBehavior: assertBehavior(
        source.defaultURLBehavior,
        "settings.observation.defaultURLBehavior",
      ),
      rules,
    },
  };
}

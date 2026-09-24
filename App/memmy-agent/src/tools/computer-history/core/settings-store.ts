import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_OBSERVATION_SETTINGS,
  ObservationSettingsError,
  parseObservationSettings,
  type ObservationSettings,
} from "./observation-settings.js";

export function defaultSettingsFile(): string {
  return path.join(os.homedir(), ".memmy", "computer-history", "observation-settings.json");
}

/** Persists the platform-neutral observation policy. Missing files use defaults;
 * unreadable or malformed explicit policy files surface an error to fail closed. */
export class ObservationSettingsStore {
  private readonly file: string;

  constructor(file?: string) {
    this.file = file ?? defaultSettingsFile();
  }

  get filePath(): string {
    return this.file;
  }

  read(): ObservationSettings {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(DEFAULT_OBSERVATION_SETTINGS);
      }
      throw error;
    }
    try {
      return parseObservationSettings(JSON.parse(raw));
    } catch (error) {
      if (error instanceof ObservationSettingsError) throw error;
      throw new ObservationSettingsError(
        `settings file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  write(input: unknown): ObservationSettings {
    const settings = parseObservationSettings(input);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return settings;
  }
}

export { ObservationSettingsError };

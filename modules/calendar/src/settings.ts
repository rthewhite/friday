/**
 * Per-calendar settings (design D8): `use` and `inAgenda` per calendar id, plus the default for new events.
 * Stored under `settings` in ctx.storage and mirrored in memory, because the prompt provider is synchronous.
 */
import type { ModuleStorage } from "@friday/sdk";
import type { CalendarInfo } from "./caldav.js";
import { InputError } from "./errors.js";

export interface CalendarSetting {
  use: boolean;
  inAgenda: boolean;
}

export interface StoredSettings {
  calendars: Record<string, CalendarSetting>;
  defaultId?: string;
}

const KEY = "settings";
const DEFAULTS: CalendarSetting = { use: true, inAgenda: true };

export class Settings {
  private data: StoredSettings = { calendars: {} };

  constructor(private readonly storage: ModuleStorage) {}

  async load(): Promise<void> {
    const stored = await this.storage.get<StoredSettings>(KEY);
    this.data = { calendars: {}, ...(stored && typeof stored === "object" ? stored : {}) };
  }

  /** A calendar's settings; on/on for one never configured. */
  of(id: string): CalendarSetting {
    return { ...DEFAULTS, ...this.data.calendars[id] };
  }

  get defaultId(): string | undefined {
    return this.data.defaultId;
  }

  used(calendars: CalendarInfo[]): CalendarInfo[] {
    return calendars.filter((c) => this.of(c.id).use);
  }

  inAgenda(calendars: CalendarInfo[]): CalendarInfo[] {
    return calendars.filter((c) => this.of(c.id).use && this.of(c.id).inAgenda);
  }

  /** Where new events go: the default when it is used and writable, else the first used, writable calendar. */
  defaultCalendar(calendars: CalendarInfo[]): CalendarInfo | undefined {
    const usable = this.used(calendars).filter((c) => c.writable);
    return usable.find((c) => c.id === this.data.defaultId) ?? usable[0];
  }

  /**
   * Applies `{ calendars?: { [id]: { use?, inAgenda? } }, defaultId?: string | null }` against the current
   * discovery and saves it. Unknown ids, non-boolean flags and a default that isn't used and writable are refused.
   */
  async update(input: unknown, calendars: CalendarInfo[]): Promise<void> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("settings must be a JSON object");
    const body = input as { calendars?: unknown; defaultId?: unknown };
    const known = new Map(calendars.map((c) => [c.id, c]));
    const next: StoredSettings = { calendars: { ...this.data.calendars }, ...(this.data.defaultId ? { defaultId: this.data.defaultId } : {}) };
    if (body.calendars !== undefined) {
      if (!body.calendars || typeof body.calendars !== "object" || Array.isArray(body.calendars)) throw new InputError("calendars must be an object keyed by calendar id");
      for (const [id, value] of Object.entries(body.calendars as Record<string, unknown>)) {
        if (!known.has(id)) throw new InputError(`unknown calendar id "${id}"`);
        if (!value || typeof value !== "object") throw new InputError(`calendars.${id} must be an object`);
        const v = value as Record<string, unknown>;
        for (const flag of ["use", "inAgenda"] as const) {
          if (v[flag] !== undefined && typeof v[flag] !== "boolean") throw new InputError(`calendars.${id}.${flag} must be true or false`);
        }
        next.calendars[id] = { ...this.of(id), ...(v.use !== undefined ? { use: v.use as boolean } : {}), ...(v.inAgenda !== undefined ? { inAgenda: v.inAgenda as boolean } : {}) };
      }
    }
    if (body.defaultId !== undefined) {
      if (body.defaultId === null || body.defaultId === "") {
        delete next.defaultId;
      } else {
        const id = body.defaultId;
        const cal = typeof id === "string" ? known.get(id) : undefined;
        if (!cal) throw new InputError(`unknown calendar id ${JSON.stringify(id)} for the default`);
        if (!cal.writable) throw new InputError(`"${cal.name}" is read-only, so it can't be the default for new events`);
        next.defaultId = cal.id;
      }
    }
    if (next.defaultId && !{ ...DEFAULTS, ...next.calendars[next.defaultId] }.use) {
      throw new InputError(`"${known.get(next.defaultId)?.name ?? next.defaultId}" is the default for new events, so Friday has to use it`);
    }
    await this.storage.set(KEY, next);
    this.data = next;
  }
}

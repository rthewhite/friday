/** A CalendarService wired to the fake iCloud, a fixed clock and in-memory settings. */
import { MemoryStorage } from "@friday/sdk";
import { lazyDb, openModuleDb } from "@friday/sdk/db";
import { CalDavClient } from "../src/caldav.js";
import { ChangeLog } from "../src/changes.js";
import { migrations } from "../src/schema.js";
import { EventHandles } from "../src/handles.js";
import { CalendarService } from "../src/service.js";
import { Settings } from "../src/settings.js";
import { TokenStore } from "../src/tokens.js";
import { IntakeClient } from "../src/intake.js";
import { WorkSource } from "../src/work.js";
import { FakeICloud, PASSWORD, USERNAME } from "./fake-icloud.js";
import { FakeIntake, INTAKE_KEY, INTAKE_URL } from "./fake-intake.js";

export const ZONE = "Europe/Amsterdam";
/** Saturday 3 October 2026, 10:00 in Amsterdam. */
export const NOW = "2026-10-03T08:00:00Z";

export interface HarnessOptions {
  /** Add the intake's Work calendar, served by this fake. */
  intake?: FakeIntake;
  /** Leave the iCloud keys unset. */
  noICloud?: boolean;
  /** Storage for settings and the work snapshot (shared to simulate a restart). */
  storage?: MemoryStorage;
  zone?: string;
}

export async function harness(fake = new FakeICloud(), opts: HarnessOptions = {}) {
  const clock = { t: new Date(NOW).getTime() };
  const now = () => new Date(clock.t);
  const storage = opts.storage ?? new MemoryStorage();
  const settings = new Settings(storage);
  await settings.load();
  const client = new CalDavClient({ fetch: fake.fetch, credentials: () => ({ username: USERNAME, password: PASSWORD }) });
  let writes = 0;
  const tokens = new TokenStore(now);
  const database = openModuleDb(":memory:", "calendar");
  database.migrate(migrations, { log() {}, warn() {}, error() {} });
  const db = lazyDb(() => database);
  const changes = new ChangeLog(db, now);
  const env: Record<string, string> = opts.intake ? { INTAKE_URL, INTAKE_KEY } : {};
  const warnings: string[] = [];
  const work = new WorkSource({
    storage,
    client: new IntakeClient({ fetch: opts.intake?.fetch, config: () => ({ url: env.INTAKE_URL, key: env.INTAKE_KEY }) }),
    config: { get: (k) => env[k] },
    now,
    log: { log() {}, warn: (m: string) => warnings.push(m), error() {} },
  });
  await work.load();
  const zone = opts.zone ?? ZONE;
  const service = new CalendarService({
    client, settings, handles: new EventHandles(now), tokens, changes, zone: () => zone, now, onWrite: () => writes++,
    work, icloudMissing: () => (opts.noICloud ? ["ICLOUD_USERNAME", "ICLOUD_APP_PASSWORD"] : []),
  });
  return { fake, service, settings, tokens, changes, db, clock, now, writes: () => writes, work, env, storage, warnings };
}

/** Rejects with the error a call threw; fails when it resolved. */
export async function error(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (e: Error) => e,
  );
}

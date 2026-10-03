/** A CalendarService wired to the fake iCloud, a fixed clock and in-memory settings. */
import { MemoryStorage } from "@friday/sdk";
import { CalDavClient } from "../src/caldav.js";
import { EventHandles } from "../src/handles.js";
import { CalendarService } from "../src/service.js";
import { Settings } from "../src/settings.js";
import { TokenStore } from "../src/tokens.js";
import { FakeICloud, PASSWORD, USERNAME } from "./fake-icloud.js";

export const ZONE = "Europe/Amsterdam";
/** Saturday 3 October 2026, 10:00 in Amsterdam. */
export const NOW = "2026-10-03T08:00:00Z";

export async function harness(fake = new FakeICloud()) {
  const clock = { t: new Date(NOW).getTime() };
  const now = () => new Date(clock.t);
  const settings = new Settings(new MemoryStorage());
  await settings.load();
  const client = new CalDavClient({ fetch: fake.fetch, credentials: () => ({ username: USERNAME, password: PASSWORD }) });
  let writes = 0;
  const tokens = new TokenStore(now);
  const service = new CalendarService({ client, settings, handles: new EventHandles(now), tokens, zone: () => ZONE, now, onWrite: () => writes++ });
  return { fake, service, settings, tokens, clock, now, writes: () => writes };
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

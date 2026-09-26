# Friday sim racing module

A remote Friday module: it runs on the gaming PC, connects to Friday over `/ws/modules`, and while it runs Friday can answer "what's my position?", "gap to the car ahead?", "do I have enough fuel?" and so on. When the process stops, the tools disappear from Friday.

Right now it serves **mock telemetry**. Real sim adapters (iRacing SDK, ACC shared memory) implement `TelemetrySource` in `src/telemetry.ts`.

## Run on Windows

1. Install Node 24 and pnpm (`corepack enable && corepack prepare pnpm@10 --activate`).
2. Clone this repo and build once:
   ```powershell
   pnpm install
   pnpm -r build
   ```
3. Set the connection details. The key must be listed in Friday's `FRIDAY_MODULE_KEYS` as `simracing=<key>`:
   ```powershell
   $env:FRIDAY_URL = "wss://friday.thewhite.nl/ws/modules"
   $env:FRIDAY_MODULE_KEY = "<key>"
   pnpm --filter @friday/remote-simracing start
   ```
   Against a local core use `ws://localhost:8080/ws/modules`.
4. Check `https://friday.thewhite.nl/api/modules`: `simracing` shows `connected` with five `simracing__*` tools. The next voice conversation can use them; a conversation that is already open keeps its tool list.

Stop with Ctrl+C. The module reconnects automatically with backoff after network drops or a Friday restart, and gives up only when Friday rejects the key (close code 4401).

To start it with a game, wrap it in a scheduled task or a launcher script that runs this command when the sim starts and kills it when the sim exits.

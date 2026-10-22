# Proposal

## Why

Every deploy replaces the portal's content-hashed chunks. A tab that was open before the deploy still runs the old bundle, so the next navigation to a page it hasn't loaded yet (Chat, Agents, a module page) asks for a chunk that no longer exists. Core's SPA fallback answers with `index.html`, the import fails ("Importing a module script failed"), and the page stays blank until the user reloads by hand. This happened right after the oauth-connections deploy.

## What Changes

- When a navigation fails because a page's code can no longer be loaded, the portal reloads itself at the page the user was going to, so the new bundle takes over.
- A reload happens at most once within 10 seconds, so a chunk that is really broken shows the error instead of reloading in a loop.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `portal-shell`: a new requirement for recovering from code left behind by a deploy.

## Impact

- `packages/portal/src/router.ts`: an error handler on the router.
- New `packages/portal/src/lib/stale-chunks.ts` (recognising the error, the once-per-10-seconds guard) with tests in `packages/portal/test/stale-chunks.test.ts`.
- No server, API or configuration change.

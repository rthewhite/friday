# Tasks

## 1. Contract and storage

- [x] 1.1 Add `secret?: boolean` to `ConfigKey` in `@friday/sdk` and flag `JELLYFIN_API_KEY` and `HA_TOKEN` as secret in the media manifest; verify `pnpm -r typecheck` passes and the media test host still resolves both keys
- [x] 1.2 Add migration 2 (`secret INTEGER NOT NULL DEFAULT 1`, `plaintext TEXT`) and extend `ConfigStore` with `set(scope, key, value, { secret })`, plain reads, `secretsEnabled`, and `verifyAll` limited to secret rows; verify tests cover plain round-trip without a master key, secret round-trip, legacy rows read as secret, and migration from version 1

## 2. API

- [x] 2.1 Extend `configListing` and `/api/config` with `secretsEnabled`, `secret` per entry, and `value` for plain stored or env entries; verify tests show a plain value returned, a secret value withheld, and an env plain value visible
- [x] 2.2 Make `PUT /api/config/:scope/:key` accept `{ value, secret? }`, force secret for keys any module declares secret, and return 503 only for secret writes without a master key; verify tests for declared-secret downgrade refusal, undeclared plain default, and the 503/204 split

## 3. Portal

- [x] 3.1 Split `ConfigurationPage.vue` into Configuration and Secrets tabs driven by `?tab=`, grouped by module; verify `/settings/config?tab=secrets` opens the Secrets tab
- [x] 3.2 Configuration tab: inline text field per plain entry with Save, Clear, scope selector and `Save and reload module`; verify manually that editing `JELLYFIN_URL` keeps the value visible after save
- [x] 3.3 Secrets tab: status badges, masked Set/Change field, banner only when `secretsEnabled` is false; verify manually that a saved secret shows `set` and no value
- [x] 3.4 "Add global value" form on both tabs (secret only from the Secrets tab); verify a plain global appears with its value and a secret global without

## 4. Docs and check

- [x] 4.1 Update `README.md`, `packages/sdk/README.md` (the `secret` flag) and `infra/README.md` (plain values are plaintext on the PVC; master key gates secrets only); verify `openspec validate --all` passes
- [ ] 4.2 Deploy and re-save the media URLs from the Configuration tab so they become visible, confirm tokens stay hidden, reload media, run a voice turn with a media tool; verify via portal and logs

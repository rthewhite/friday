# Infra bootstrap

One-time setup for the GitHub Actions pipeline (self-hosted homelab runner →
`registry.thewhite.nl` → homelab k3s cluster). Mirrors `rthewhite/jarvis`.

The split, as in the rest of the homelab: Ansible owns the namespace, the
`deployer` ServiceAccount + Role, the `deployer-token` and the `registry-pull`
secret. This repo's workflow owns the Deployment, Service and IngressRoutes in
`deploy/k8s.yaml`. The deployer cannot read or write Secrets, so application
secrets are created by hand (step 3).

## 1. Homelab repo (once)

In `~/Projects/homelab`:

1. `friday` is listed under `app_namespaces` and `github_runners` in
   `ansible/group_vars/all/main.yml`.
2. Add the registry push user to the vault:
   ```bash
   PW=$(openssl rand -base64 24)
   htpasswd -nbB friday "$PW"            # take the hash after the colon
   ansible-vault edit ansible/group_vars/all/vault.yml
   # vault_registry_push_users:
   #   friday:
   #     password: "<PW>"
   #     hash: "<hash>"
   ```
3. Converge:
   ```bash
   cd ansible && ansible-playbook site.yml --tags registry,app-namespaces,github-runner
   ```

## 2. GitHub repository secrets

```bash
R=rthewhite/friday
kubectl -n friday get secret deployer-token -o jsonpath='{.data.token}' | base64 -d \
  | gh secret set HOMELAB_KUBE_TOKEN --repo $R
kubectl -n friday get secret deployer-token -o jsonpath='{.data.ca\.crt}' \
  | gh secret set HOMELAB_KUBE_CA --repo $R
printf 'https://192.168.1.81:6443' | gh secret set HOMELAB_KUBE_SERVER --repo $R
printf 'friday' | gh secret set HOMELAB_REGISTRY_USER --repo $R
printf '%s' "$PW" | gh secret set HOMELAB_REGISTRY_PASSWORD --repo $R
```

## 3. Application secrets in the cluster (by hand, admin kubeconfig)

`friday-secrets` is loaded with `envFrom`. Only `FRIDAY_MASTER_KEY` has to be in
it: it encrypts the configuration store, so it can't live there. The Gemini key
(`GEMINI_API_KEY`, requested by `core`), module configuration (Jellyfin, Home
Assistant) and remote module keys are managed in the portal under Settings and
stored encrypted in `friday.db` on the `friday-data` PersistentVolumeClaim; the
environment remains a fallback, so a `.env` with everything still works. Core
reads its key at each voice session and model call, so a key saved in the portal
applies without a restart. MCP servers, including their tokens, are configured
under Settings > Configuration > MCP servers and stored in `friday.db` as well.

```bash
# Generate the master key once and keep a copy in your password manager.
echo "FRIDAY_MASTER_KEY=$(openssl rand -base64 32)" >> .env
kubectl -n friday create secret generic friday-secrets --from-env-file=.env
```

### The master key

Values saved on the Secrets tab of Settings > Configuration (keys a module
declares `secret: true`) are AES-256-GCM encrypted with `FRIDAY_MASTER_KEY`.
Plain configuration (URLs, ids) is stored as plain text in `friday.db` on the
PVC and does not need the master key. If the key is lost or changed, secret
rows cannot be read: Friday logs one error per row at startup, the portal shows
them as `pending`, and you re-enter them (Secrets tab, then "Save and reload
module"). Remote module keys are stored as hashes and are unaffected.

Backup: the PVC is the state. To copy the database out of the pod,
`kubectl -n friday exec deploy/friday -- sh -c 'sqlite3 /data/friday.db ".backup /tmp/friday.bak"'`
(the image has no sqlite3 CLI; `kubectl cp` of `/data/friday.db` while the pod is
idle works too, WAL included: copy `friday.db`, `friday.db-wal` and `friday.db-shm`).

To rotate the Gemini key: save the new one on Settings > Configuration > Secrets
(scope `core`); no restart. To rotate anything still in the secret:
`kubectl -n friday delete secret friday-secrets` and recreate, then
`kubectl -n friday rollout restart deploy/friday` (env is read at start).

Do not put `FRIDAY_HOST` or `FRIDAY_PORT` in the secret; the Deployment sets them.
Clusters upgraded from a version that read `mcp.json` can delete the old
`friday-mcp` secret once the servers are re-entered in the portal:
`kubectl -n friday delete secret friday-mcp`.

Remote modules authenticate with keys created in the portal (Settings > Remote
modules; the key is shown once). `FRIDAY_MODULE_KEYS` in the secret still works as
a fallback, as `<module id>=<key>` pairs separated by commas. When neither has a
key, `/ws/modules` rejects every connection and startup logs a warning.

### The login (Authentik)

Browsers log in through the homelab's Authentik at `auth.thewhite.nl`. Friday is the
OpenID Connect client itself: there is no Traefik forward-auth middleware on its
route. Voice devices and remote modules keep their own keys and never log in.
Friday refuses to start without `FRIDAY_AUTH_ISSUER` while `FRIDAY_PUBLIC_URL` is
set to anything but a localhost URL. Set it up once, before deploying:

1. **Groups** (Directory > Groups): create `friday-users` (may log in) and
   `friday-admins` (may log in and use Settings), and put yourself in
   `friday-admins`. Other names work with `FRIDAY_AUTH_USER_GROUP` and
   `FRIDAY_AUTH_ADMIN_GROUP`.
2. **Provider** (Applications > Providers > Create > OAuth2/OpenID Provider):
   - Name `friday`, authorization flow `default-provider-authorization-implicit-consent`.
   - Client type **Confidential**. Copy the client ID and secret.
   - Redirect URI (strict): `https://friday.thewhite.nl/auth/callback`.
   - Scopes: `openid`, `email`, `profile` (Authentik's profile mapping carries the
     `groups` claim) and `offline_access` (the refresh token Friday re-checks the
     claims with every day).
   - Subject mode: **Based on the User's hashed ID** (the default). Do not change it
     later: Friday knows people by issuer and subject, so a new subject mode turns
     everyone into a new person. Friday refuses such a login when the email belongs
     to an existing user, and logs both subjects.
3. **Application** (Applications > Applications > Create): name and slug `friday`,
   provider `friday`. Under Policy / Group / User Bindings, bind `friday-users` and
   `friday-admins`, so other accounts can't even complete the login. Friday checks
   the groups itself too.
4. **Secret**: add the keys to `friday-secrets` (recreate it from your `.env` as in
   step 3, then `kubectl -n friday rollout restart deploy/friday`):
   ```bash
   FRIDAY_AUTH_ISSUER=https://auth.thewhite.nl/application/o/friday/
   FRIDAY_AUTH_CLIENT_ID=<client id>
   FRIDAY_AUTH_CLIENT_SECRET=<client secret>
   ```
   `FRIDAY_MASTER_KEY` must be there as well: sessions seal the refresh token with it.

Friday creates a user at their first login. The **first admin** to log in is
recorded as the household owner (shown on Settings > Users); later per-user
features give existing data to the owner. Roles follow the Authentik groups at each
login and within a day of a change. Disabling a user under Settings > Users locks
them out at once. Scripts that called `/api` without logging in now get 401.

## 4. Endpoints

| Client | URL |
|---|---|
| Browser | `https://friday.thewhite.nl` (websecure; log in through Authentik, `/auth/*`) |
| Voice devices | `wss://friday.thewhite.nl/ws/audio?device=<id>` (websecure, whole-host route; key in `Authorization`, no login) |
| Remote modules | `wss://friday.thewhite.nl/ws/modules` (websecure, whole-host route; module key, no login) |

`*.thewhite.nl` resolves to Traefik on the LAN via AdGuard. Voice devices accepted
under Settings > Voice devices connect over TLS like everything else; there is no
plain-HTTP route.

### Moving the Voice PE to device keys (once)

The plain-HTTP `friday-ws-plain` IngressRoute was removed from `deploy/k8s.yaml`
when voice devices got keys. The deploy runs `kubectl apply` without pruning, so
it stays in the cluster until it is deleted by hand. The order:

1. Merge and push; the deploy rolls out. The Voice PE on the old firmware is now
   rejected (no key) and shows the red error pulse.
2. Delete the old route:
   ```bash
   kubectl -n friday delete ingressroute friday-ws-plain
   ```
3. Flash the new firmware over OTA: `esphome run esphome/friday-voice-pe.yaml`.
   It generates its key and logs its fingerprint.
4. Say "hey friday". The ring pulses amber and `friday-voice` appears under
   Settings > Voice devices > Pending.
5. Accept it with its label, Home Assistant area and notes, and wake it again.

## 5. Rollback

```bash
kubectl -n friday rollout undo deploy/friday
```

The previous server accepts the new firmware: it ignores the `Authorization`
header and serves `wss://` on the same host. Going back to the old firmware
needs the `friday-ws-plain` route again (apply it from the manifest of an
earlier commit).

## 6. What CI checks before a push

`deploy.yml` builds the image locally (`--load`) and pushes it only after
`scripts/smoke.sh` has started it:

- an empty data directory, a fresh master key, no Gemini key, and the
  placeholders in `scripts/smoke.env`
- `/health` answers 200 within 60 s
- `/` serves the built portal
- `/api/modules` lists every module as `loaded`
- `SIGTERM` stops it with exit code 0

A failure prints the container's log, and the image never reaches the registry.
To reproduce a failure locally:

```bash
docker build -t friday:smoke . && scripts/smoke.sh friday:smoke
```

A new module with required configuration fails the check until its
placeholders are in `scripts/smoke.env`. Use `.invalid` hosts there, never real
credentials.

The firmware's host tests (`esphome/test/run.sh`) run in the `test` job and in
`firmware.yml`, for pushes that only touch `esphome/`. The runner has Docker
but no compiler, so they run in a `gcc:14` image pinned by digest (`GCC_IMAGE`
in both workflows). To move to a newer GCC, update the digest in both places.

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

## 4. Endpoints

| Client | URL |
|---|---|
| Browser | `https://friday.thewhite.nl` (websecure) |
| Voice devices | `wss://friday.thewhite.nl/ws/audio?device=<id>` (websecure, whole-host route; key in `Authorization`) |
| Remote modules | `wss://friday.thewhite.nl/ws/modules` (websecure, whole-host route) |

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

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

`friday-secrets` is loaded with `envFrom`; put every credential / site-specific
variable from `.env.example` in it. `friday-mcp` is optional and is mounted as
`/etc/friday/mcp.json`.

```bash
kubectl -n friday create secret generic friday-secrets --from-env-file=.env
kubectl -n friday create secret generic friday-mcp --from-file=mcp.json=mcp.json
```

To rotate: `kubectl -n friday delete secret friday-secrets` and recreate, then
`kubectl -n friday rollout restart deploy/friday` (env is read at start).

Do not put `FRIDAY_HOST`, `FRIDAY_PORT` or `FRIDAY_MCP_CONFIG` in the secret;
the Deployment sets them.

## 4. Endpoints

| Client | URL |
|---|---|
| Browser | `https://friday.thewhite.nl` (websecure) |
| Voice PE | `ws://friday.thewhite.nl:80/ws/audio` (web entrypoint, this path only) |

`*.thewhite.nl` resolves to Traefik on the LAN via AdGuard. The plain-HTTP route
exists because the ESPHome `friday_client` component does not do TLS yet; drop
`friday-ws-plain` from `deploy/k8s.yaml` once it does.

## 5. Rollback

```bash
kubectl -n friday rollout undo deploy/friday
```

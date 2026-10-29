import { createServer } from "node:http";
import { resolveTimeZone, ToolRegistry } from "@friday/sdk";
import { settings } from "./config.js";
import { modules } from "./modules.js";
import { ModuleHost } from "./module-host.js";
import { McpSource } from "./tools/mcp.js";
import { McpServerStore } from "./tools/mcp-store.js";
import { CompositeKeyStore, EnvKeyStore, SqliteKeyStore } from "./remote/key-store.js";
import { RemoteHost } from "./remote/host.js";
import { DeviceStore } from "./devices/store.js";
import { DeviceSessions } from "./devices/sessions.js";
import { DeviceLinks } from "./devices/links.js";
import { databasePath, openDatabase } from "./storage/db.js";
import { SqliteModuleStorage } from "./storage/module-kv.js";
import { retiredModulesWarning, SqliteModuleEnablement } from "./storage/module-enablement.js";
import { ConversationStore } from "./conversations/store.js";
import { registerRetention } from "./conversations/retention.js";
import { coreConfig, followTimezone } from "./core-config.js";
import { ConfigStore } from "./secrets/config-store.js";
import { parseMasterKey } from "./secrets/crypto.js";
import { createResolver } from "./secrets/resolver.js";
import { attachAudioWs } from "./transports/ws.js";
import { attachDeviceWs } from "./transports/device-ws.js";
import { AlertStore } from "./alerts/store.js";
import { AlertService } from "./alerts/service.js";
import { registerAlertTools } from "./alerts/tools.js";
import { createApp } from "./app.js";
import { JobStore } from "./jobs/store.js";
import { Scheduler } from "./jobs/scheduler.js";
import { GeminiTextModel } from "./llm/gemini.js";
import { LlmService } from "./llm/service.js";
import { ChatEngine } from "./chat/engine.js";
import { createPromptContext, systemPrompt } from "./prompt-context.js";
import { AgentRunStore, AgentStore } from "./agents/store.js";
import { AgentRuntime } from "./agents/runtime.js";
import { AgentTriggers, jobName } from "./agents/triggers.js";
import { CORE_ID } from "./core-config.js";
import { OAuthStore } from "./oauth/store.js";
import { enabledManifests, OAuthRequests } from "./oauth/requests.js";
import { OAuthTokens } from "./oauth/tokens.js";
import { registerOAuthKeepalive } from "./oauth/keepalive.js";
import { OAuthFlow } from "./oauth/flow.js";
import { FALLBACK_BASE, publicBase, redirectUri } from "./oauth/redirect.js";
import { AuthConfigError, authMode, loginRedirectUri, type AuthMode } from "./auth/config.js";
import { Auth } from "./auth/auth.js";
import { OidcClient } from "./auth/oidc.js";
import { UserConnections } from "./auth/connections.js";
import { UserStore } from "./auth/users.js";
import { followOwner, moduleUsers } from "./auth/ownership.js";
import { SessionStore } from "./auth/sessions.js";

const db = openDatabase(settings.dataDir);
const masterKey = parseMasterKey(settings.masterKey);
const configStore = new ConfigStore(db, masterKey);
const mcpStore = new McpServerStore(db, masterKey);
if (!configStore.secretsEnabled) console.warn("secrets disabled: FRIDAY_MASTER_KEY is not set; plain configuration still works, secrets come from the environment only");
for (const f of configStore.verifyAll()) console.error(`config: ${f.scope}/${f.key} could not be decrypted and counts as unset`);
const keys = new SqliteKeyStore(db);
// Voice devices: /ws/audio?device= and /ws/device authenticate against the store; the API closes a device's sessions
// and control connection on revoke.
const devices = new DeviceStore(db);
const deviceSessions = new DeviceSessions();
const deviceLinks = new DeviceLinks();
// Core's own key: stored for core or globally in the portal, else the environment; read at each use.
const coreKey = coreConfig(configStore, process.env);
const geminiKey = () => coreKey("GEMINI_API_KEY");
// Browser auth: OIDC when FRIDAY_AUTH_ISSUER is set, else the dev user for this machine only. A deployment without
// auth (a public URL that isn't localhost) must not start.
let auth: AuthMode;
try {
  auth = authMode(process.env, coreKey("FRIDAY_PUBLIC_URL"), masterKey !== undefined);
} catch (e) {
  if (!(e instanceof AuthConfigError)) throw e;
  console.error(`auth: ${e.message}`);
  process.exit(1);
}
if (auth.kind === "dev") console.warn("auth: FRIDAY_AUTH_ISSUER is not set, so authentication is off: only this machine (loopback) gets in, as the dev user");
else console.log(`auth: users log in through ${auth.oidc.issuer}`);
// The household owner: the first admin to log in, or the dev user without auth. Data without a user is theirs.
const users = new UserStore(db, undefined, { devOwner: auth.kind === "dev" });
followOwner(db, users);
const modUsers = moduleUsers(users);
const sessions = new SessionStore(db, masterKey);
const authPublicUrl = () => coreKey("FRIDAY_PUBLIC_URL");
const oidc = auth.kind === "oidc" ? new OidcClient(auth.oidc, () => loginRedirectUri(authPublicUrl() ?? "")) : undefined;
const browserAuth = new Auth({ mode: auth, users, sessions, oidc, publicUrl: authPublicUrl });
// Talk page connections by user: disabling a user closes them.
const userConnections = new UserConnections();
// A session that ends (logout, a refused refresh) closes the Talk connections it opened.
sessions.onEnd((ids) => ids.forEach((id) => userConnections.closeSession(id)));
const purged = sessions.purgeIdle();
if (purged) console.log(`auth: ended ${purged} session(s) idle for 30 days`);
const jobStore = new JobStore(db, settings.jobHistory);
const interrupted = jobStore.markInterrupted(Date.now());
if (interrupted) console.warn(`jobs: ${interrupted} run(s) interrupted by the last shutdown marked cancelled`);
// Cron's zone resolves like core's other keys (core scope, global, env) and re-plans when saved (followTimezone).
const jobs = new Scheduler({ store: jobStore, timezone: () => coreKey("FRIDAY_TIMEZONE"), catchupDelayMs: settings.jobCatchupDelayMs });
const conversations = new ConversationStore(db, { quietMinutes: settings.conversationQuietMinutes });
// Alerts (timers and alarms) ring a device over its control connection; announcements use the household zone.
const householdZone = () => resolveTimeZone(coreKey("FRIDAY_TIMEZONE")).zone;
const alerts = new AlertService({
  store: new AlertStore(db),
  links: deviceLinks,
  sessions: deviceSessions,
  timezone: householdZone,
  rings: settings.alertRings,
  ringIntervalMs: settings.alertRingIntervalMs,
  graceMs: settings.alertGraceMs,
  alarmWindowMs: settings.alarmRingMinutes * 60_000,
});

const registry = new ToolRegistry();
// Owner-only tools (the owner's calendar, Spotify) are offered and run for the household owner only.
registry.setOwnerCheck((u) => u !== undefined && users.isOwner(u.id));
const promptContext = createPromptContext();
const llm = new LlmService({
  model: new GeminiTextModel(geminiKey),
  models: { standard: settings.textModel, fast: settings.textModelFast },
  concurrency: settings.llmConcurrency,
  timeoutMs: settings.llmTimeoutMs,
  maxRetryWaitMs: settings.llmMaxRetryWaitMs,
});
// OAuth connections: modules request providers in their manifests, the user grants each module in the portal, and
// ctx.oauth.token hands out fresh access tokens (the only way a token leaves core).
const oauthStore = new OAuthStore(db, masterKey);
const oauthRequests = new OAuthRequests(() => enabledManifests(host));
const publicUrl = () => coreKey("FRIDAY_PUBLIC_URL");
const oauthTokens = new OAuthTokens({ store: oauthStore, requests: oauthRequests, redirectUri: (p) => redirectUri(publicBase(publicUrl()) ?? FALLBACK_BASE, p) });
const retiredModules = retiredModulesWarning(process.env);
if (retiredModules) console.warn(retiredModules);
const host = new ModuleHost(registry, {
  enablement: new SqliteModuleEnablement(db),
  oauth: (id) => oauthTokens.forModule(id),
  resolve: createResolver(configStore, process.env),
  storage: (id) => new SqliteModuleStorage(db, id),
  jobs: (id) => jobs.forOwner(id),
  llm: (id) => llm.forOwner(id),
  conversations: (id) => conversations.forOwner(id),
  database: databasePath(settings.dataDir),
  prompt: promptContext,
  users: modUsers,
});
const mcp = new McpSource(registry, mcpStore);
const remote = new RemoteHost({
  registry,
  keys: new CompositeKeyStore([keys, new EnvKeyStore(settings.moduleKeys)]),
  pingMs: settings.wsPingMs,
  callTimeoutMs: settings.remoteCallTimeoutMs,
});

registerAlertTools(registry, {
  alerts,
  links: deviceLinks,
  deviceLabels: () => new Map(devices.list().devices.map((d) => [d.id, d.label])),
  timezone: householdZone,
});
await host.load(modules);
await mcp.load();
// Agents: runs over their own tools (FRIDAY_TEXT_MODEL, one LLM slot at a time), started by their job or run_agent.
const agentStore = new AgentStore(db);
const agentRuns = new AgentRunStore(db);
const interruptedRuns = agentRuns.failInterrupted();
if (interruptedRuns) console.warn(`agents: ${interruptedRuns} run(s) or approved action(s) interrupted by the last shutdown marked failed`);
const agentRuntime = new AgentRuntime({
  agents: agentStore,
  runs: agentRuns,
  registry,
  conversations,
  llm,
  model: settings.textModel,
  timezone: householdZone,
  toolTimeoutMs: settings.agentToolTimeoutMs,
  isActive: (id) => users.get(id)?.disabled === false,
});
new AgentTriggers({ agents: agentStore, runtime: agentRuntime, registry, scheduler: jobs, jobs: jobStore, timezone: householdZone, prompt: promptContext.forOwner(CORE_ID) }).start();
const agentJob = (name: string) => `${CORE_ID}/${jobName(name)}`;
if (!geminiKey()) console.warn("GEMINI_API_KEY is not set (Settings > Configuration > Secrets, or the environment)");
console.log(`tools (${registry.names().length}):`, registry.names().join(", "));
conversations.start();
alerts.start();
registerRetention(jobs, conversations, settings.conversationRetentionDays);
registerOAuthKeepalive(jobs, oauthTokens, oauthStore);

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    conversations.stop();
    alerts.stop();
    // host.dispose() also closes the modules' own connections, before core's.
    void remote.closeAll().then(() => agentRuntime.stop()).then(() => jobs.stop()).then(() => host.dispose()).then(() => mcp.close()).finally(() => { db.close(); process.exit(0); });
  });
}

const chat = new ChatEngine({
  store: conversations,
  registry,
  llm,
  model: settings.chatModel,
  system: (user) => systemPrompt(promptContext, "chat", undefined, user)(),
  toolTimeoutMs: settings.chatToolTimeoutMs,
});

const server = createServer(createApp({ registry, host, mcp, mcpStore, remote, webDir: settings.webDir, configStore, keys, devices, deviceSessions, deviceLinks, alerts, env: process.env, jobs, conversations, chat, onConfigChange: followTimezone(jobs),
  agents: { agents: agentStore, runs: agentRuns, runtime: agentRuntime, registry, nextRun: (name) => jobs.nextRunAt(agentJob(name)) },
  oauth: { store: oauthStore, requests: oauthRequests, flow: new OAuthFlow({ store: oauthStore, requests: oauthRequests }), publicUrl },
  auth: { auth: browserAuth, users, sessions, oidc, publicUrl: authPublicUrl, onDisabled: (id) => userConnections.closeUser(id) } }));
attachAudioWs(server, { registry, conversations, geminiKey, promptContext, devices, deviceSessions, alerts, auth: browserAuth, userConnections, owner: modUsers.owner });
attachDeviceWs(server, { devices, links: deviceLinks, onReport: (id, type, alert) => alerts.deviceReport(id, type, alert) });
remote.attach(server);

server.listen(settings.port, settings.host, () =>
  console.log(`friday listening on http://${settings.host}:${settings.port}`),
);

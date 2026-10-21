/**
 * OAuth requests come from the in-process modules' manifests and are never stored: per provider, which modules ask
 * for it, with which scopes. Everything derived from them (the scopes to ask the provider for, the missing ones, the
 * generic URL defaults) is computed from a snapshot taken per call, so nothing goes stale when a manifest changes
 * between deployments, and one call reads the manifests once.
 */
import { validateOAuthRequests, type ModuleManifest } from "@friday/sdk";
import type { ModuleHost } from "../module-host.js";

/** The manifests requests are read from: core's modules that FRIDAY_MODULES enables, failed ones included. */
export const enabledManifests = (host: Pick<ModuleHost, "manifests">): ModuleManifest[] =>
  host.manifests().filter((e) => e.status !== "disabled").map((e) => e.manifest);

export interface ProviderRequest {
  module: string;
  scopes: string[];
  description?: string;
  authUrl?: string;
  tokenUrl?: string;
}

export interface MissingScope {
  scope: string;
  /** Granted modules that requested it; empty for an extra scope. */
  modules: string[];
}

/** Requests per provider, modules in load order. Manifests with malformed requests are skipped (they fail to load). */
function collect(manifests: ModuleManifest[]): Map<string, ProviderRequest[]> {
  const out = new Map<string, ProviderRequest[]>();
  for (const m of manifests) {
    try {
      validateOAuthRequests(m.id, m.oauth);
    } catch {
      continue;
    }
    for (const r of m.oauth ?? []) {
      const req: ProviderRequest = { module: m.id, scopes: [...r.scopes] };
      if (r.description !== undefined) req.description = r.description;
      if (r.authUrl !== undefined) req.authUrl = r.authUrl;
      if (r.tokenUrl !== undefined) req.tokenUrl = r.tokenUrl;
      out.set(r.provider, [...(out.get(r.provider) ?? []), req]);
    }
  }
  return out;
}

/** The requests as they are at one moment. */
export class RequestSet {
  constructor(readonly byProvider: Map<string, ProviderRequest[]>) {}

  of(provider: string): ProviderRequest[] {
    return this.byProvider.get(provider) ?? [];
  }

  forModule(provider: string, moduleId: string): ProviderRequest | undefined {
    return this.of(provider).find((r) => r.module === moduleId);
  }

  /** The scopes to ask the provider for: the granted modules' requests, then the extras, without duplicates. */
  requestedScopes(provider: string, grants: string[], extras: string[]): string[] {
    const granted = new Set(grants);
    const scopes = this.of(provider).filter((r) => granted.has(r.module)).flatMap((r) => r.scopes);
    return [...new Set([...scopes, ...extras])];
  }

  /**
   * Scopes in the current union that the provider has not granted, each with the granted modules that need it.
   * Nothing is missing before the first authorization (`grantedScopes` undefined): the connection needs a Connect then.
   */
  missingScopes(provider: string, grants: string[], extras: string[], grantedScopes: string[] | undefined): MissingScope[] {
    if (grantedScopes === undefined) return [];
    const have = new Set(grantedScopes);
    const granted = new Set(grants);
    const requests = this.of(provider).filter((r) => granted.has(r.module));
    return this.requestedScopes(provider, grants, extras)
      .filter((scope) => !have.has(scope))
      .map((scope) => ({ scope, modules: requests.filter((r) => r.scopes.includes(scope)).map((r) => r.module) }));
  }

  /** Authorization and token URLs from the first request that carries them (generic providers). */
  genericDefaults(provider: string): { authUrl: string; tokenUrl: string } | undefined {
    const r = this.of(provider).find((x) => x.authUrl && x.tokenUrl);
    return r ? { authUrl: r.authUrl!, tokenUrl: r.tokenUrl! } : undefined;
  }
}

export class OAuthRequests {
  /** `manifests` lists core's modules in load order (after FRIDAY_MODULES), failed ones included. */
  constructor(private readonly manifests: () => ModuleManifest[]) {}

  /** Read the manifests once; take one per call that asks several questions. */
  snapshot(): RequestSet {
    return new RequestSet(collect(this.manifests()));
  }

  byProvider(): Map<string, ProviderRequest[]> {
    return this.snapshot().byProvider;
  }

  of(provider: string): ProviderRequest[] {
    return this.snapshot().of(provider);
  }

  forModule(provider: string, moduleId: string): ProviderRequest | undefined {
    return this.snapshot().forModule(provider, moduleId);
  }

  requestedScopes(provider: string, grants: string[], extras: string[]): string[] {
    return this.snapshot().requestedScopes(provider, grants, extras);
  }

  missingScopes(provider: string, grants: string[], extras: string[], grantedScopes: string[] | undefined): MissingScope[] {
    return this.snapshot().missingScopes(provider, grants, extras, grantedScopes);
  }

  genericDefaults(provider: string): { authUrl: string; tokenUrl: string } | undefined {
    return this.snapshot().genericDefaults(provider);
  }
}

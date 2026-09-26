/** Resolves a remote module's API key to the module id it may register as. */
export interface KeyStore {
  lookup(key: string): Promise<string | undefined> | string | undefined;
  /** True when no key can ever match; used for the startup warning. */
  isEmpty(): boolean;
}

/** `FRIDAY_MODULE_KEYS="<id>=<key>,<id2>=<key2>"`. */
export function parseModuleKeys(value: string | undefined): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const part of (value ?? "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0 || eq === p.length - 1) throw new Error(`FRIDAY_MODULE_KEYS: expected <id>=<key>, got "${p}"`);
    byKey.set(p.slice(eq + 1), p.slice(0, eq));
  }
  return byKey;
}

export class EnvKeyStore implements KeyStore {
  private readonly byKey: Map<string, string>;
  constructor(value: string | undefined) {
    this.byKey = parseModuleKeys(value);
  }
  lookup(key: string): string | undefined {
    return this.byKey.get(key);
  }
  isEmpty(): boolean {
    return this.byKey.size === 0;
  }
}

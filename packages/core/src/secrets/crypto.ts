/** AES-256-GCM for configuration values. AAD binds each ciphertext to its scope and key. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Encrypted {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** `FRIDAY_MASTER_KEY` is 32 bytes, base64 (standard or url-safe). Returns undefined when unset. */
export function parseMasterKey(value: string | undefined): Buffer | undefined {
  if (!value?.trim()) return undefined;
  const buf = Buffer.from(value.trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (buf.length !== 32) throw new Error(`FRIDAY_MASTER_KEY must decode to 32 bytes, got ${buf.length}`);
  return buf;
}

export const aad = (scope: string, key: string) => Buffer.from(`${scope}:${key}`, "utf8");

export function encrypt(masterKey: Buffer, scope: string, key: string, plaintext: string): Encrypted {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(aad(scope, key));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/** Throws on a wrong key, tampered data, or a scope/key mismatch. */
export function decrypt(masterKey: Buffer, scope: string, key: string, e: Encrypted): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey, e.iv);
  decipher.setAAD(aad(scope, key));
  decipher.setAuthTag(e.tag);
  return Buffer.concat([decipher.update(e.ciphertext), decipher.final()]).toString("utf8");
}

// Secrets live in the macOS Keychain (via @napi-rs/keyring), never on disk.
import { Entry } from "@napi-rs/keyring";
import { randomBytes } from "node:crypto";

const SERVICE = process.env.NOTESNOOK_MCP_KEYCHAIN_SERVICE || "notesnook-mcp";

export type SecretName = "db-key" | "user-encryption-key" | "session-token";

function entry(name: SecretName) {
  return new Entry(SERVICE, name);
}

export function getSecret(name: SecretName): string | undefined {
  return entry(name).getPassword() ?? undefined;
}

export function setSecret(name: SecretName, value: string) {
  entry(name).setPassword(value);
}

export function deleteSecret(name: SecretName) {
  const item = entry(name);
  if (item.getPassword() !== null) item.deletePassword();
}

/** Key used to encrypt the local SQLite database (SQLite3MultipleCiphers). */
export function getOrCreateDbKey(create: boolean): string | undefined {
  let key = getSecret("db-key");
  if (!key && create) {
    key = randomBytes(32).toString("hex");
    setSecret("db-key", key);
  }
  return key;
}

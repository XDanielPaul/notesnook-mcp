// IStorage implementation for Node, modelled on packages/core/__mocks__/node-storage.mock.ts
// and apps/web/src/interfaces/storage.ts. The derived master key ("userEncryptionKey")
// is kept in the macOS Keychain; other (non-secret) keys go to a 0600 JSON file.
import {
  Cipher,
  NNCrypto,
  SerializedKey,
  SerializedKeyPair
} from "@notesnook/crypto";
import type { IStorage } from "@notesnook/core";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { STORAGE_PATH, ensureAppDir } from "./paths.js";
import { deleteSecret, getSecret, setSecret } from "./secrets.js";

const APP_SALT = "oVzKtazBo7d8sb7TBvY9jw";
const KEY_NAME = "userEncryptionKey";
const TOKEN_NAME = "token";

export class NodeStorage implements IStorage {
  private crypto = new NNCrypto();
  private data: Record<string, unknown> = existsSync(STORAGE_PATH)
    ? JSON.parse(readFileSync(STORAGE_PATH, "utf-8"))
    : {};

  private flush() {
    ensureAppDir();
    writeFileSync(STORAGE_PATH, JSON.stringify(this.data), { mode: 0o600 });
    chmodSync(STORAGE_PATH, 0o600);
  }
  async write<T>(key: string, data: T) {
    if (key === KEY_NAME) return setSecret("user-encryption-key", String(data));
    if (key === TOKEN_NAME)
      return setSecret("session-token", JSON.stringify(data));
    this.data[key] = data;
    this.flush();
  }
  async writeMulti<T>(entries: [string, T][]) {
    for (const [k, v] of entries) await this.write(k, v);
  }
  async readMulti<T>(keys: string[]): Promise<[string, T][]> {
    return Promise.all(keys.map(async (k) => [k, (await this.read<T>(k)) as T] as [string, T]));
  }
  async read<T>(key: string): Promise<T | undefined> {
    if (key === KEY_NAME) return getSecret("user-encryption-key") as T | undefined;
    if (key === TOKEN_NAME) {
      const token = getSecret("session-token");
      return token ? (JSON.parse(token) as T) : undefined;
    }
    return this.data[key] as T | undefined;
  }
  async remove(key: string) {
    if (key === KEY_NAME) return deleteSecret("user-encryption-key");
    if (key === TOKEN_NAME) return deleteSecret("session-token");
    delete this.data[key];
    this.flush();
  }
  async removeMulti(keys: string[]) {
    for (const k of keys) await this.remove(k);
  }
  async clear() {
    deleteSecret("user-encryption-key");
    deleteSecret("session-token");
    this.data = {};
    this.flush();
  }
  async getAllKeys() {
    return Object.keys(this.data);
  }

  encrypt(key: SerializedKey, plainText: string) {
    return this.crypto.encrypt(key, plainText, "text", "base64");
  }
  encryptMulti(key: SerializedKey, items: string[]) {
    return this.crypto.encryptMulti(key, items, "text", "base64");
  }
  decrypt(key: SerializedKey, cipherData: Cipher<"base64">) {
    cipherData.format = "base64";
    return this.crypto.decrypt(key, cipherData, "text");
  }
  decryptMulti(key: SerializedKey, items: Cipher<"base64">[]) {
    items.forEach((c) => (c.format = "base64"));
    return this.crypto.decryptMulti(key, items, "text");
  }

  async deriveCryptoKey(credentials: SerializedKey) {
    const { password, salt } = credentials;
    if (!password) throw new Error("Invalid data provided to deriveCryptoKey.");
    const keyData = await this.crypto.exportKey(password, salt);
    if (!keyData.key) throw new Error("Invalid key.");
    await this.write(KEY_NAME, keyData.key);
  }
  async deriveCryptoKeyFallback() {}

  hash(password: string, email: string) {
    return this.crypto.hash(password, `${APP_SALT}${email}`);
  }
  async getCryptoKey() {
    return this.read<string>(KEY_NAME);
  }
  generateCryptoKey(password: string, salt?: string) {
    return this.crypto.exportKey(password, salt || randomBytes(16).toString("base64"));
  }
  generateCryptoKeyFallback(password: string, salt?: string) {
    return this.generateCryptoKey(password, salt);
  }
  generatePGPKeyPair(): Promise<SerializedKeyPair> {
    return this.crypto.exportKeyPair();
  }
  async decryptPGPMessage(): Promise<string> {
    throw new Error("PGP (inbox) is not supported by notesnook-mcp.");
  }
  async validatePGPKeyPair() {
    return { isValid: true, message: "ok" };
  }
}

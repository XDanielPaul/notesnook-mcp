import { homedir } from "node:os";
import path from "node:path";
import { chmodSync, existsSync, mkdirSync } from "node:fs";

export const DEFAULT_APP_DIR = path.join(
  homedir(),
  "Library",
  "Application Support",
  "notesnook-mcp"
);
export const APP_DIR = process.env.NOTESNOOK_MCP_DIR || DEFAULT_APP_DIR;
export const DB_PATH = path.join(APP_DIR, "notesnook.sqlite");
export const CONFIG_PATH = path.join(APP_DIR, "config.json");
export const STORAGE_PATH = path.join(APP_DIR, "storage.json");

export function isDefaultAppDir() {
  return path.resolve(APP_DIR) === path.resolve(DEFAULT_APP_DIR);
}

export function ensureAppDir() {
  if (!existsSync(APP_DIR)) mkdirSync(APP_DIR, { recursive: true, mode: 0o700 });
  chmodSync(APP_DIR, 0o700);
}

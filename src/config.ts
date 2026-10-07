import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_PATH, ensureAppDir } from "./paths.js";

export type Hosts = {
  API_HOST: string;
  AUTH_HOST: string;
  SSE_HOST: string;
  MONOGRAPH_HOST?: string;
};

export type Config = { hosts: Hosts; email?: string };

export function readConfig(): Config | undefined {
  if (!existsSync(CONFIG_PATH)) return;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

export function writeConfig(config: Config) {
  ensureAppDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

/** Env vars override the saved config. */
export function resolveHosts(): Hosts | undefined {
  const saved = readConfig()?.hosts;
  const api = process.env.NOTESNOOK_API_HOST || saved?.API_HOST;
  const auth = process.env.NOTESNOOK_AUTH_HOST || saved?.AUTH_HOST;
  const sse = process.env.NOTESNOOK_SSE_HOST || saved?.SSE_HOST;
  const mono = process.env.NOTESNOOK_MONOGRAPH_HOST || saved?.MONOGRAPH_HOST;
  if (!api || !auth || !sse) return;
  return { API_HOST: api, AUTH_HOST: auth, SSE_HOST: sse, MONOGRAPH_HOST: mono };
}

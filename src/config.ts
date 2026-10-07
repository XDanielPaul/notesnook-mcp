import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_PATH, DB_PATH, ensureAppDir } from "./paths.js";

export type Hosts = {
  API_HOST: string;
  AUTH_HOST: string;
  SSE_HOST: string;
  MONOGRAPH_HOST?: string;
};

export type Config = { hosts: Hosts; email?: string };

export function validateHosts(hosts: Hosts): Hosts {
  const result = { ...hosts };
  for (const key of ["API_HOST", "AUTH_HOST", "SSE_HOST", "MONOGRAPH_HOST"] as const) {
    const value = hosts[key];
    if (key === "MONOGRAPH_HOST" && value === undefined) continue;
    let url: URL;
    try {
      url = new URL(value ?? "");
    } catch {
      throw new Error(`${key} must be a valid HTTPS URL.`);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error(`${key} must use HTTPS without embedded credentials, a query, or a fragment.`);
    result[key] = url.href.replace(/\/$/, "");
  }
  return result;
}

export function assertNewProfile() {
  if (existsSync(DB_PATH) || existsSync(CONFIG_PATH))
    throw new Error("This profile is already configured. Run `notesnook-mcp logout` before logging in again or changing servers.");
}

export function readConfig(): Config | undefined {
  if (!existsSync(CONFIG_PATH)) return;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

export function writeConfig(config: Config) {
  config = { ...config, hosts: validateHosts(config.hosts) };
  ensureAppDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

/** Existing profiles stay bound to their saved servers. */
export function resolveHosts(overrides: Partial<Hosts> = {}): Hosts | undefined {
  const saved = readConfig()?.hosts;
  const api = overrides.API_HOST || process.env.NOTESNOOK_API_HOST || saved?.API_HOST;
  const auth = overrides.AUTH_HOST || process.env.NOTESNOOK_AUTH_HOST || saved?.AUTH_HOST;
  const sse = overrides.SSE_HOST || process.env.NOTESNOOK_SSE_HOST || saved?.SSE_HOST;
  const mono = overrides.MONOGRAPH_HOST || process.env.NOTESNOOK_MONOGRAPH_HOST || saved?.MONOGRAPH_HOST;
  if (!api || !auth || !sse) return;
  const hosts = validateHosts({ API_HOST: api, AUTH_HOST: auth, SSE_HOST: sse, MONOGRAPH_HOST: mono });
  if (saved) {
    const bound = validateHosts(saved);
    for (const key of ["API_HOST", "AUTH_HOST", "SSE_HOST", "MONOGRAPH_HOST"] as const) {
      if (hosts[key] !== bound[key])
        throw new Error(`${key} differs from this profile's saved server. Log out before changing servers.`);
    }
  }
  return hosts;
}

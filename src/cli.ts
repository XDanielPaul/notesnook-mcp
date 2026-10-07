#!/usr/bin/env node
import { parseArgs } from "node:util";
import { rmSync } from "node:fs";
import { prompt } from "./prompt.js";
import { Hosts, readConfig, resolveHosts, writeConfig } from "./config.js";
import { APP_DIR, isDefaultAppDir } from "./paths.js";
import { deleteSecret } from "./secrets.js";

const log = (...args: unknown[]) => console.error(...args);

async function checkServer(url: string) {
  const res = await fetch(`${url.replace(/\/$/, "")}/version`);
  if (!res.ok) throw new Error(`${url}/version returned HTTP ${res.status}`);
  return res.text();
}

async function login(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      api: { type: "string" },
      auth: { type: "string" },
      sse: { type: "string" },
      monograph: { type: "string" }
    }
  });
  const current = resolveHosts();
  const ask = async (label: string, flag?: string, def?: string) =>
    flag || (await prompt(`${label}${def ? ` [${def}]` : ""}: `)) || def || "";
  const hosts: Hosts = {
    API_HOST: await ask("Sync server URL (API_HOST)", values.api, current?.API_HOST),
    AUTH_HOST: await ask("Auth server URL (AUTH_HOST)", values.auth, current?.AUTH_HOST),
    SSE_HOST: await ask("Events server URL (SSE_HOST)", values.sse, current?.SSE_HOST),
    MONOGRAPH_HOST: values.monograph || current?.MONOGRAPH_HOST
  };
  if (!hosts.API_HOST || !hosts.AUTH_HOST || !hosts.SSE_HOST)
    throw new Error("API, auth and events server URLs are required.");
  for (const k of ["API_HOST", "AUTH_HOST", "SSE_HOST"] as const) {
    hosts[k] = hosts[k].replace(/\/$/, "");
    log(`  ${k}: ${hosts[k]} -> ${(await checkServer(hosts[k])).slice(0, 80)}`);
  }
  writeConfig({ ...readConfig(), hosts });
  const { openDatabase } = await import("./db.js");
  const opened = await openDatabase({ createKey: true });
  const { db } = opened;

  const existing = await db.user.getUser();
  if (existing) {
    log(`Already logged in as ${existing.email}. Run \`notesnook-mcp logout\` first to switch accounts.`);
    await opened.close();
    return;
  }

  try {
    const email = (await prompt("Email: ")).toLowerCase();
    const mfa = (await db.user.authenticateEmail(email)) as
      | { primaryMethod?: string; secondaryMethod?: string; phoneNumber?: string }
      | undefined;

    const methods = [mfa?.primaryMethod, mfa?.secondaryMethod, "recoveryCode"].filter(
      (m, i, a): m is string => !!m && a.indexOf(m) === i
    );
    let method = methods[0] ?? "app";
    if (methods.length > 1) {
      const choice = await prompt(`2FA method (${methods.join("/")}) [${method}]: `);
      if (choice) {
        if (!methods.includes(choice)) throw new Error(`Unknown 2FA method: ${choice}`);
        method = choice;
      }
    }
    if (method === "email" || method === "sms") {
      await db.mfa.sendCode(method);
      log(`A 2FA code was sent via ${method}${mfa?.phoneNumber ? ` to ${mfa.phoneNumber}` : ""}.`);
    }
    const code = await prompt(`2FA code (${method}): `);
    await db.user.authenticateMultiFactorCode(code, method);

    const password = await prompt("Password: ", { hidden: true });
    await db.user.authenticatePassword(email, password);
    writeConfig({ ...readConfig()!, email });
    log(`Logged in as ${email}. Running initial sync...`);
    await doSync(db, false);
  } finally {
    await opened.close();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function doSync(db: any, push = process.env.NOTESNOOK_MCP_ALLOW_WRITE === "1") {
  const { NotesnookSync } = await import("./sync.js");
  const t = Date.now();
  const syncer = new NotesnookSync(db, push);
  await syncer.sync(push ? "cli (pull+push)" : "cli (pull only)");
  const notes = await db.notes.all.count();
  log(`Sync finished in ${((Date.now() - t) / 1000).toFixed(1)}s. ${notes} notes locally.`);
}

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof import("./db.js")["openDatabase"]>>["db"]) => Promise<T>) {
  const { openDatabase } = await import("./db.js");
  const opened = await openDatabase();
  try {
    if (!(await opened.db.user.getUser())) throw new Error("Not logged in. Run `notesnook-mcp login`.");
    return await fn(opened.db);
  } finally {
    await opened.close();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "login":
      await login(rest);
      break;
    case "sync":
      if (rest.includes("--push") && process.env.NOTESNOOK_MCP_ALLOW_WRITE !== "1")
        throw new Error("Pushing is disabled. Set NOTESNOOK_MCP_ALLOW_WRITE=1 first.");
      await withDb((db) => doSync(db, process.env.NOTESNOOK_MCP_ALLOW_WRITE === "1"));
      break;
    case "status":
      await withDb(async (db) => {
        const user = await db.user.getUser();
        log({
          email: user?.email,
          hosts: resolveHosts(),
          notes: await db.notes.all.count(),
          notebooks: await db.notebooks.all.count(),
          tags: await db.tags.all.count(),
          lastSynced: new Date(await db.lastSynced()).toISOString()
        });
      });
      break;
    case "list":
      await withDb(async (db) => {
        const notes = await db.notes.all.items(undefined, { sortBy: "dateEdited", sortDirection: "desc" });
        for (const n of notes.slice(0, Number(rest[0]) || 20))
          process.stdout.write(`${n.id}  ${new Date(n.dateEdited).toISOString().slice(0, 10)}  ${n.title}\n`);
      });
      break;
    case "logout": {
      if (!isDefaultAppDir())
        throw new Error("Refusing to recursively remove a custom NOTESNOOK_MCP_DIR. Remove that specific directory manually.");
      try {
        const { openDatabase } = await import("./db.js");
        const opened = await openDatabase();
        try {
          await opened.db.user.logout(true);
        } finally {
          await opened.close();
        }
      } catch (e) {
        log("Remote logout failed (continuing with local wipe):", (e as Error).message);
      }
      deleteSecret("session-token");
      deleteSecret("user-encryption-key");
      deleteSecret("db-key");
      rmSync(APP_DIR, { recursive: true, force: true });
      log("Logged out; local database, config and Keychain entries removed.");
      break;
    }
    case "serve":
      await (await import("./mcp.js")).serve();
      return;
    default:
      log(`Usage: notesnook-mcp <command>

  login [--api URL --auth URL --sse URL]   Log in interactively (email, 2FA, password)
  sync [--push]                             Pull changes; push requires NOTESNOOK_MCP_ALLOW_WRITE=1
  status                                    Show account and local counts
  list [N]                                  List the N most recently edited notes
  logout                                    Revoke session, wipe local DB + Keychain items
  serve                                     Run the MCP server on stdio`);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  log(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

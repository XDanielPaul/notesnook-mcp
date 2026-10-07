import "./runtime.js";
import { Database } from "@notesnook/core";
import { SqliteDialect } from "@streetwriters/kysely";
import BetterSQLite3 from "better-sqlite3-multiple-ciphers";
import * as betterTrigram from "sqlite-better-trigram";
import * as fts5Html from "sqlite3-fts5-html";
import { getLoadablePath } from "sqlite-regex";
import { EventSourcePolyfill } from "event-source-polyfill";
import { chmodSync } from "node:fs";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import { DB_PATH, ensureAppDir } from "./paths.js";
import { NodeStorage } from "./storage.js";
import { NoAttachmentsFS } from "./fs.js";
import { getOrCreateDbKey } from "./secrets.js";
import { resolveHosts } from "./config.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const Compressor = {
  async compress(data: string) {
    return (await gzipAsync(data, { level: 6 })).toString("base64");
  },
  async decompress(data: string) {
    return (await gunzipAsync(Buffer.from(data, "base64"))).toString("utf-8");
  }
};

export async function openDatabase(opts: { createKey?: boolean } = {}) {
  const hosts = resolveHosts();
  if (!hosts)
    throw new Error("Server not configured. Run `notesnook-mcp login` first.");
  ensureAppDir();
  const dbKey = getOrCreateDbKey(!!opts.createKey);
  if (!dbKey)
    throw new Error("Database key missing from Keychain. Run `notesnook-mcp login`.");
  if (!/^[0-9a-f]{64}$/.test(dbKey))
    throw new Error("Invalid database key in Keychain. Run `notesnook-mcp logout` and log in again.");

  const sqlite = new BetterSQLite3(DB_PATH).unsafeMode(true);
  sqlite.pragma(`key = '${dbKey}'`);
  betterTrigram.load(sqlite);
  fts5Html.load(sqlite);
  sqlite.loadExtension(getLoadablePath());

  const db = new Database();
  db.host(hosts as Parameters<Database["host"]>[0]);
  db.setup({
    storage: new NodeStorage(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventsource: EventSourcePolyfill as any,
    fs: NoAttachmentsFS,
    compressor: async () => Compressor,
    maxNoteVersions: async () => 100,
    sqliteOptions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dialect: () => new SqliteDialect({ database: sqlite }) as any
    },
    batchSize: 500
  });
  await db.init();
  chmodSync(DB_PATH, 0o600);
  return {
    db,
    close: async () => {
      await db.syncer.stop();
      db.disconnectSSE();
      sqlite.close();
    }
  };
}

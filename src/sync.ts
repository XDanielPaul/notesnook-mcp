import { EVENTS } from "@notesnook/core";
import type { openDatabase } from "./db.js";

type Db = Awaited<ReturnType<typeof openDatabase>>["db"];

const FRESH_MS = (Number(process.env.NOTESNOOK_MCP_SYNC_INTERVAL_SECONDS) || 120) * 1000;
const READ_WAIT_MS = 20_000;

/**
 * Serialises syncs. Read-only mode only ever fetches ("fetch"), so nothing local
 * can be pushed. Write mode does a full pull + push. Core's auto-sync is disabled;
 * we sync explicitly after writes.
 */
export class NotesnookSync {
  private running?: Promise<void>;
  private lastAttempt = 0;
  lastError?: string;

  constructor(private readonly db: Db, private readonly allowPush: boolean) {
    db.eventManager.subscribe(EVENTS.syncCheckStatus, (type: string) => ({
      type,
      result: type !== "autoSync"
    }));
  }

  sync(reason: string): Promise<void> {
    if (this.running) {
      // A write must not piggyback on a fetch-only/earlier sync that started before it.
      if (reason === "startup" || reason === "fresh") return this.running;
      return this.running.catch(() => {}).then(() => this.sync(reason));
    }
    this.lastAttempt = Date.now();
    this.running = (async () => {
      const t = Date.now();
      try {
        const ok = await this.db.sync({ type: this.allowPush ? "full" : "fetch" });
        if (ok === false) throw new Error("Sync did not complete (token refresh needed?)");
        this.lastError = undefined;
        console.error(`notesnook-mcp: sync (${reason}) ok in ${Date.now() - t}ms`);
      } catch (e) {
        this.lastError = (e as Error).message;
        console.error(`notesnook-mcp: sync (${reason}) failed: ${this.lastError}`);
        throw e;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Pull if the last attempt is stale; on failure/timeout, fall back to local data. */
  async ensureFresh() {
    if (!this.running && Date.now() - this.lastAttempt < FRESH_MS) return;
    const p = this.sync("fresh").catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        p,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, READ_WAIT_MS);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async status() {
    return {
      lastSynced: new Date(await this.db.lastSynced()).toISOString(),
      notes: await this.db.notes.all.count(),
      lastError: this.lastError
    };
  }
}

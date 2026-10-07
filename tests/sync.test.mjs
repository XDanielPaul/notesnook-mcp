import assert from "node:assert/strict";
import test from "node:test";
import { NotesnookSync } from "../dist/sync.js";

function fakeDb() {
  return {
    eventManager: { subscribe() {} },
    syncCalls: [],
    async sync(options) {
      this.syncCalls.push(options);
      return true;
    }
  };
}

test("read-only sync fetches and never pushes", async () => {
  const db = fakeDb();
  await new NotesnookSync(db, false).sync("test");
  assert.deepEqual(db.syncCalls, [{ type: "fetch" }]);
});

test("write-enabled sync performs full pull and push", async () => {
  const db = fakeDb();
  await new NotesnookSync(db, true).sync("test");
  assert.deepEqual(db.syncCalls, [{ type: "full" }]);
});

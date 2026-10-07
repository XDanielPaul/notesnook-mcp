import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { NNCrypto } from "@notesnook/crypto";

test("Notesnook Sodium loads under Node ESM and derives/encrypts keys", async () => {
  const crypto = new NNCrypto();
  assert.ok(await crypto.hash("test-password", "test@example.invalid"));
  const key = await crypto.exportKey(
    "test-password",
    randomBytes(16).toString("base64")
  );
  const cipher = await crypto.encrypt(key, "round-trip", "text", "base64");
  assert.equal(await crypto.decrypt(key, cipher, "text"), "round-trip");
});

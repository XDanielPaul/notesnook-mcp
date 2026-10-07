import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { acquireProfileLock } from "../dist/profile-lock.js";
import { restrictFetch } from "../dist/network.js";
import { SerialQueue } from "../dist/serial-queue.js";

const root = mkdtempSync(path.join(tmpdir(), "notesnook-security-"));
process.env.NOTESNOOK_MCP_DIR = path.join(root, "profile");
for (const name of ["API", "AUTH", "SSE", "MONOGRAPH"]) delete process.env[`NOTESNOOK_${name}_HOST`];
after(() => rmSync(root, { recursive: true, force: true }));
const { assertNewProfile, validateHosts, resolveHosts, writeConfig } = await import("../dist/config.js");
const { revokeSession } = await import("../dist/logout.js");
const hosts = {
  API_HOST: "https://api.example.com",
  AUTH_HOST: "https://auth.example.com",
  SSE_HOST: "https://events.example.com"
};

test("all configured endpoints require HTTPS and reject credentials and URL suffixes", () => {
  for (const key of [...Object.keys(hosts), "MONOGRAPH_HOST"]) {
    for (const value of ["http://example.com", "http://localhost:8080", "file:///tmp/config",
      "https://user:password@example.com", "https://example.com?query=1", "https://example.com#fragment", "invalid"]) {
      assert.throws(() => validateHosts({ ...hosts, [key]: value }), /HTTPS/);
    }
  }
  assert.deepEqual(validateHosts({ ...hosts, API_HOST: `${hosts.API_HOST}/` }), hosts);
});

test("a configured profile cannot be replaced by login or environment overrides", () => {
  assertNewProfile();
  writeConfig({ hosts });
  const configPath = path.join(process.env.NOTESNOOK_MCP_DIR, "config.json");
  const before = readFileSync(configPath, "utf8");
  assert.throws(assertNewProfile, /already configured/);
  process.env.NOTESNOOK_AUTH_HOST = "https://another.example.com";
  try {
    assert.throws(resolveHosts, /differs/);
    assert.equal(readFileSync(configPath, "utf8"), before);
  } finally {
    delete process.env.NOTESNOOK_AUTH_HOST;
  }
  assert.equal(resolveHosts().AUTH_HOST, hosts.AUTH_HOST);
  rmSync(configPath);
  writeFileSync(path.join(process.env.NOTESNOOK_MCP_DIR, "notesnook.sqlite"), "");
  assert.throws(assertNewProfile, /already configured/);
});

test("network guard blocks insecure requests and disables redirects even when requested", async () => {
  const requests = [];
  const request = restrictFetch(async (input, init) => {
    requests.push({ input, init });
    return new Response("", { status: 200 });
  });
  await assert.rejects(request("http://example.com", { body: "secret", method: "POST" }), /HTTPS/);
  await assert.rejects(request(new Request("http://example.com")), /HTTPS/);
  assert.equal(requests.length, 0);
  await request("https://example.com", { redirect: "follow" });
  assert.equal(requests[0].init.redirect, "error");
});

test("profile lock excludes another process and can be reacquired after release", () => {
  const directory = path.join(root, "lock-profile");
  mkdirSync(directory);
  const release = acquireProfileLock(directory);
  try {
    assert.throws(() => acquireProfileLock(directory), /Profile is locked/);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { acquireProfileLock } from ${JSON.stringify(new URL("../dist/profile-lock.js", import.meta.url).href)};
       acquireProfileLock(${JSON.stringify(directory)});`
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Profile is locked/);
  } finally {
    release();
  }
  release();
  acquireProfileLock(directory)();
  assert.equal(existsSync(`${directory}.lock`), false);
});

test("concurrent read-modify-write operations preserve both appends and recover after rejection", async () => {
  const queue = new SerialQueue();
  let content = "original";
  const append = (text) => queue.run(async () => {
    const previous = content;
    await new Promise((resolve) => setTimeout(resolve, 10));
    content = previous + text;
  });
  await Promise.all([append(" first"), append(" second")]);
  assert.equal(content, "original first second");
  await assert.rejects(queue.run(async () => { throw new Error("write failed"); }), /write failed/);
  await append(" third");
  assert.equal(content, "original first second third");
});

test("revocation propagates failures without deleting stored credentials", async (t) => {
  const token = { access_token: "test-access-token" };
  const db = { kv: () => ({ read: async () => token }), user: { getUser: async () => ({ id: "test" }) } };
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, `${hosts.AUTH_HOST}/account/logout`);
    assert.equal(options.headers.Authorization, "Bearer test-access-token");
    assert.equal(options.redirect, "error");
    return new Response("", { status: 503 });
  });
  await assert.rejects(revokeSession(db, hosts.AUTH_HOST), /503/);
  assert.equal((await db.kv().read("token")).access_token, "test-access-token");
  fetchMock.mock.mockImplementation(async () => { throw new Error("offline"); });
  await assert.rejects(revokeSession(db, hosts.AUTH_HOST), /offline/);
  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 204 }));
  await revokeSession(db, hosts.AUTH_HOST);
});

test("revocation cannot claim success when an account exists but its token is missing", async () => {
  const db = { kv: () => ({ read: async () => undefined }), user: { getUser: async () => ({ id: "test" }) } };
  await assert.rejects(revokeSession(db, hosts.AUTH_HOST), /cannot be confirmed/);
  db.user.getUser = async () => undefined;
  await revokeSession(db, hosts.AUTH_HOST);
});

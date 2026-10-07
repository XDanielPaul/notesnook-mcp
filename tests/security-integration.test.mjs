import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const moduleUrl = (name) => new URL(`../dist/${name}.js`, import.meta.url).href;

test("the MCP update_note handler preserves simultaneous appends", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "notesnook-updates-"));
  const output = path.join(directory, "content.html");
  const source = `
    import { mock } from "node:test";
    import { writeFileSync } from "node:fs";
    let content = "<p>original</p>";
    const db = {
      user: { getUser: async () => ({ email: "test@example.invalid" }) },
      eventManager: { subscribe() {} },
      sync: async () => true,
      notes: {
        note: async () => ({ id: "test", title: "Test" }),
        add: async (note) => {
          content = note.content.data;
          writeFileSync(${JSON.stringify(output)}, content);
          return "test";
        }
      },
      content: { findByNoteId: async () => {
        const snapshot = content;
        await new Promise(resolve => setTimeout(resolve, 25));
        return { data: snapshot, type: "tiptap" };
      } }
    };
    mock.module(${JSON.stringify(moduleUrl("db"))}, {
      namedExports: { openDatabase: async () => ({ db, close: async () => {} }) }
    });
    const { serve } = await import(${JSON.stringify(moduleUrl("mcp"))});
    await serve();
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-test-module-mocks", "--input-type=module", "-e", source],
    env: { ...process.env, NOTESNOOK_MCP_ALLOW_WRITE: "1" },
    stderr: "pipe"
  });
  const client = new Client({ name: "security-test", version: "1" });
  try {
    await client.connect(transport);
    const responses = await Promise.all(["first", "second"].map((content) =>
      client.callTool({ name: "update_note", arguments: { id: "test", content, format: "text" } })
    ));
    for (const response of responses) assert.notEqual(response.isError, true);
    const content = readFileSync(output, "utf8");
    assert.match(content, /original/);
    assert.match(content, /first/);
    assert.match(content, /second/);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function cliFixture(directory, status, command) {
  return `
    import { mock } from "node:test";
    import { appendFileSync, mkdirSync } from "node:fs";
    const directory = ${JSON.stringify(directory)};
    for (const name of ["API", "AUTH", "SSE", "MONOGRAPH"]) delete process.env[\`NOTESNOOK_\${name}_HOST\`];
    mock.module(${JSON.stringify(moduleUrl("prompt"))}, { namedExports: {
      prompt: async () => "test@example.invalid"
    } });
    mock.module(${JSON.stringify(moduleUrl("paths"))}, { namedExports: {
      APP_DIR: directory,
      DEFAULT_APP_DIR: directory,
      CONFIG_PATH: directory + "/config.json",
      DB_PATH: directory + "/notesnook.sqlite",
      STORAGE_PATH: directory + "/storage.json",
      ensureAppDir: () => mkdirSync(directory, { recursive: true }),
      isDefaultAppDir: () => true
    } });
    mock.module(${JSON.stringify(moduleUrl("secrets"))}, { namedExports: {
      deleteSecret: () => appendFileSync(directory + "-deleted-keys", "deleted\\n")
    } });
    mock.module(${JSON.stringify(moduleUrl("db"))}, { namedExports: {
      openDatabase: async () => ({
        db: {
          kv: () => ({ read: async () => ({ access_token: "fake-test-token" }) }),
          user: {
            getUser: async () => process.env.TEST_NO_USER ? undefined : ({ id: "test" }),
            authenticateEmail: async () => { throw new Error("Authentication retried"); }
          }
        },
        close: async () => {}
      })
    } });
    globalThis.fetch = async () => {
      appendFileSync(directory + "-network", "request\\n");
      return new Response(null, { status: ${status} });
    };
    process.argv = ["node", "cli", ${JSON.stringify(command)}, ...(process.env.TEST_ARGS ? JSON.parse(process.env.TEST_ARGS) : [])];
    await import(${JSON.stringify(moduleUrl("cli"))});
  `;
}

test("CLI logout retains profile and keys on rejection; deletes them only on confirmed success", () => {
  const root = mkdtempSync(path.join(tmpdir(), "notesnook-logout-"));
  const directory = path.join(root, "profile");
  const hosts = { API_HOST: "https://example.com", AUTH_HOST: "https://example.com", SSE_HOST: "https://example.com" };
  try {
    for (const status of [503, 401, 204]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "config.json"), JSON.stringify({ hosts }));
      writeFileSync(path.join(directory, "notesnook.sqlite"), "synthetic data");
      const result = spawnSync(process.execPath, [
        "--experimental-test-module-mocks", "--input-type=module", "-e", cliFixture(directory, status, "logout")
      ], { encoding: "utf8" });
      assert.equal(result.status, status === 204 ? 0 : 1, result.stderr);
      assert.equal(existsSync(directory), status !== 204);
      assert.equal(existsSync(`${directory}-deleted-keys`), status === 204);
      assert.equal(existsSync(`${directory}.lock`), false);
      if (status !== 204) assert.match(result.stderr, /retained/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI login rejects existing profiles before contacting or saving a replacement server", () => {
  const root = mkdtempSync(path.join(tmpdir(), "notesnook-login-"));
  const directory = path.join(root, "profile");
  mkdirSync(directory);
  const config = JSON.stringify({ hosts: {
    API_HOST: "https://original.example.com",
    AUTH_HOST: "https://original.example.com",
    SSE_HOST: "https://original.example.com"
  } });
  writeFileSync(path.join(directory, "config.json"), config);
  try {
    const result = spawnSync(process.execPath, [
      "--experimental-test-module-mocks", "--input-type=module", "-e", cliFixture(directory, 200, "login")
    ], {
      encoding: "utf8",
      env: { ...process.env, TEST_ARGS: JSON.stringify(["--auth", "https://replacement.example.com"]) }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /differs/);
    assert.equal(readFileSync(path.join(directory, "config.json"), "utf8"), config);
    assert.equal(existsSync(`${directory}-network`), false);
    const sameServer = spawnSync(process.execPath, [
      "--experimental-test-module-mocks", "--input-type=module", "-e", cliFixture(directory, 200, "login")
    ], { encoding: "utf8", env: { ...process.env, TEST_ARGS: "[]" } });
    assert.equal(sameServer.status, 0, sameServer.stderr);
    assert.match(sameServer.stderr, /Already logged in/);
    const retry = spawnSync(process.execPath, [
      "--experimental-test-module-mocks", "--input-type=module", "-e", cliFixture(directory, 200, "login")
    ], { encoding: "utf8", env: { ...process.env, TEST_ARGS: "[]", TEST_NO_USER: "1" } });
    assert.equal(retry.status, 1, retry.stderr);
    assert.match(retry.stderr, /Authentication retried/);
    assert.equal(readFileSync(path.join(directory, "config.json"), "utf8"), config);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

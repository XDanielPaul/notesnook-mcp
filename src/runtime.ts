// Globals that @notesnook/core expects (mirrors packages/core/__tests__/setup).
import { DOMParser } from "linkedom";
import WebSocket from "ws";
import { initLocale } from "@notesnook/intl";
import { restrictFetch } from "./network.js";

// Do not forward authentication request bodies through redirects.
globalThis.fetch = restrictFetch(globalThis.fetch);

// stdout is reserved for MCP JSON-RPC / command output: route library chatter to stderr.
console.log = console.info = console.debug = console.error;
process.umask(0o077);

// initLocaleSync uses require() inside the ESM build, which Node rejects; use the async loader.
await initLocale({ systemLocale: "en" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
g.DOMParser = DOMParser;
g.WebSocket = WebSocket;

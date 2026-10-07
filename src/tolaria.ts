import "./runtime.js";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { getId } from "@notesnook/core";
import type { openDatabase } from "./db.js";
import { bodyToHtml } from "./format.js";
import { APP_DIR } from "./paths.js";

type Db = Awaited<ReturnType<typeof openDatabase>>["db"];

/** Files shipped by Tolaria's public "Getting Started" vault; they are not the user's notes. */
export const STARTER_FILES = new Set([
  "AGENTS.md", "CLAUDE.md", "GEMINI.md", "autogit.md", "command-palette.md", "editor-playground.md",
  "get-familiar-with-tolaria.md", "launch-plan-spreadsheet.md", "luca-rossi.md", "multiple-vaults.md",
  "note.md", "person.md", "project-dashboard.md", "project.md", "the-properties-panel.md",
  "tolaria-ai.md", "tolaria-bottom-bar.md", "tolaria-editor.md", "tolaria-note-list.md",
  "tolaria-principles.md", "tolaria-sidebar.md", "tolaria.md", "topic.md", "type.md", "walkthroughs.md"
]);
const SKIP_DIRS = new Set(["attachments", "views", "node_modules"]);
const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export type PlannedNote = {
  relPath: string;
  id: string;
  title: string;
  type?: string;
  aliases: string[];
  folders: string[];
  tags: string[];
  archived: boolean;
  properties: [string, unknown][];
  body: string;
  sheet: boolean;
  /** Type definition imported as a reusable template note. */
  template?: boolean;
  dateCreated: number;
  dateEdited: number;
};

export type ImportPlan = { vault: string; notes: PlannedNote[]; skipped: string[] };

type ImportState = { notes: Record<string, string>; notebooks: Record<string, string> };
const STATE_PATH = path.join(APP_DIR, "tolaria-import.json");

function loadState(): ImportState {
  if (!existsSync(STATE_PATH)) return { notes: {}, notebooks: {} };
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function splitFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { fm: {}, body: raw };
  let fm: unknown;
  try {
    fm = parseYaml(m[1]);
  } catch {
    fm = {};
  }
  return { fm: fm && typeof fm === "object" ? (fm as Record<string, unknown>) : {}, body: raw.slice(m[0].length) };
}

const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const asList = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const humanize = (s: string) =>
  s.toLowerCase() === "url" ? "URL" : s.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(path.join(dir, entry.name), r));
    } else out.push(r);
  }
  return out;
}

export function planImport(vault: string, existingIds: Record<string, string> = {}): ImportPlan {
  const notes: PlannedNote[] = [];
  const skipped: string[] = [];
  for (const relPath of walk(vault).sort()) {
    if (!relPath.endsWith(".md")) {
      skipped.push(`${relPath} (not markdown)`);
      continue;
    }
    if (!relPath.includes("/") && STARTER_FILES.has(relPath)) {
      skipped.push(`${relPath} (Getting Started sample)`);
      continue;
    }
    const full = path.join(vault, relPath);
    const { fm, body: rawBody } = splitFrontmatter(readFileSync(full, "utf8"));
    const type = typeof (fm.type ?? fm["Is A"]) === "string" ? String(fm.type ?? fm["Is A"]) : undefined;
    if (type === "Type") {
      const h1 = /^\s*# (.+)\r?\n?/.exec(rawBody);
      const template =
        typeof fm.template === "string" && fm.template.trim()
          ? fm.template
          : h1
            ? rawBody.slice(h1.index + h1[0].length)
            : rawBody;
      if (!template.trim()) {
        skipped.push(`${relPath} (type definition without template)`);
        continue;
      }
      const stat = statSync(full);
      notes.push({
        relPath,
        id: existingIds[relPath] ?? getId(),
        title: h1?.[1].trim() ?? titleCase(path.basename(relPath, ".md")),
        aliases: [],
        folders: [],
        tags: [],
        archived: false,
        properties: [],
        body: template,
        sheet: false,
        template: true,
        dateCreated: Math.round(stat.birthtimeMs || stat.mtimeMs),
        dateEdited: Math.round(stat.mtimeMs)
      });
      continue;
    }

    let body = rawBody;
    let title: string | undefined;
    const h1 = /^\s*# (.+)\r?\n?/.exec(body);
    if (h1) {
      title = h1[1].trim();
      body = body.slice(h1[0].length);
    }
    title ??= typeof fm.title === "string" ? fm.title : humanize(path.basename(relPath, ".md"));

    const tags = asList(fm.tags).map(String).filter(Boolean);
    if (typeof fm.status === "string" && fm.status) tags.push(`status/${fm.status.toLowerCase()}`);

    const skip = new Set(["type", "Is A", "title", "tags", "status", "archived", "aliases"]);
    const properties = Object.entries(fm).filter(
      ([k, v]) => !k.startsWith("_") && !skip.has(k) && v !== null && v !== ""
    );
    const stat = statSync(full);
    notes.push({
      relPath,
      id: existingIds[relPath] ?? getId(),
      title,
      type,
      aliases: asList(fm.aliases).map(String),
      folders: relPath.split("/").slice(0, -1),
      tags: [...new Set(tags)],
      archived: fm.archived === true,
      properties,
      body,
      sheet: fm._display === "sheet",
      dateCreated: Math.round(stat.birthtimeMs || stat.mtimeMs),
      dateEdited: Math.round(stat.mtimeMs)
    });
  }
  return { vault, notes, skipped };
}

export function linkResolver(notes: PlannedNote[]) {
  const index = new Map<string, PlannedNote>();
  for (const n of notes) {
    if (n.template) continue;
    const keys = [
      n.relPath.replace(/\.md$/, ""),
      path.basename(n.relPath, ".md"),
      n.title,
      ...n.aliases
    ];
    for (const k of keys) if (!index.has(k.toLowerCase())) index.set(k.toLowerCase(), n);
  }
  return (target: string) => index.get(target.trim().replace(/\.md$/, "").toLowerCase());
}

const escapeMd = (s: string) => s.replace(/([\\[\]*_`])/g, "\\$1");

function replaceWikilinks(text: string, resolve: ReturnType<typeof linkResolver>) {
  return text.replace(WIKILINK, (_, target: string, label?: string) => {
    const note = resolve(target);
    const t = target.trim().replace(/\.md$/, "");
    const byFile = note && (note.relPath.replace(/\.md$/, "") === t || path.basename(note.relPath, ".md") === t);
    const shown = escapeMd((label ?? (byFile ? note.title : t)).trim());
    return note ? `[${shown}](nn://note/${note.id})` : shown;
  });
}

function csvRows(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

function sheetToMarkdown(csv: string) {
  const rows = csvRows(csv.trim());
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

function propertyValue(v: unknown, resolve: ReturnType<typeof linkResolver>): string {
  if (Array.isArray(v)) return v.map((x) => propertyValue(x, resolve)).join(", ");
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === "object") return escapeMd(JSON.stringify(v));
  const s = String(v);
  if (/^https?:\/\//.test(s)) return `<${s}>`;
  return replaceWikilinks(s.includes("[[") ? s : escapeMd(s), resolve);
}

export function noteMarkdown(note: PlannedNote, resolve: ReturnType<typeof linkResolver>) {
  let body = note.sheet ? sheetToMarkdown(note.body) : note.body;
  body = body
    .replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*$/gm, "") // images are not imported
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^>\s*\[!(\w+)\][+-]?\s*(.*)$/gm, (_, kind: string, t: string) =>
      `> **${humanize(kind.toLowerCase())}${t ? `: ${t}` : ""}**\n>`
    );
  body = replaceWikilinks(body, resolve);

  const meta: string[] = [];
  if (note.type) meta.push(`- **Type:** ${escapeMd(note.type)}`);
  for (const [k, v] of note.properties) meta.push(`- **${escapeMd(humanize(k))}:** ${propertyValue(v, resolve)}`);
  return (meta.length ? `${meta.join("\n")}\n\n---\n\n` : "") + body.trim() + "\n";
}

export function describePlan(plan: ImportPlan, rootNotebook?: string) {
  const resolve = linkResolver(plan.notes);
  const lines = [`Vault: ${plan.vault}`, `Notes to import: ${plan.notes.length}`];
  for (const n of plan.notes) {
    const notebooks = [n.template ? "Templates" : n.type, n.folders.length ? n.folders.join(" / ") : undefined]
      .filter(Boolean)
      .map((nb) => (rootNotebook ? `${rootNotebook} / ${nb}` : nb));
    const links = [...n.body.matchAll(WIKILINK)].length;
    const unresolved = [...n.body.matchAll(WIKILINK)].filter((m) => !resolve(m[1])).map((m) => m[1]);
    lines.push(
      `  ${n.relPath} -> "${n.title}"` +
        ` | notebook: ${notebooks.join(" + ") || rootNotebook || "(none)"}` +
        (n.tags.length ? ` | tags: ${n.tags.join(", ")}` : "") +
        (n.archived ? " | archived" : "") +
        (links ? ` | links: ${links}${unresolved.length ? ` (unresolved: ${unresolved.join(", ")})` : ""}` : "")
    );
  }
  lines.push(`Skipped: ${plan.skipped.length}`, ...plan.skipped.map((s) => `  ${s}`));
  return lines.join("\n");
}

async function ensureNotebook(db: Db, state: ImportState, key: string, title: string, parentId?: string) {
  const known = state.notebooks[key];
  if (known && (await db.notebooks.exists(known))) return known;
  for (const nb of await db.notebooks.all.items()) {
    if (nb.title.trim().toLowerCase() !== title.trim().toLowerCase()) continue;
    if ((await db.notebooks.parentId(nb.id)) !== parentId) continue;
    state.notebooks[key] = nb.id;
    return nb.id;
  }
  const id = await db.notebooks.add({ title });
  if (!id) throw new Error(`Failed to create notebook ${title}`);
  if (parentId) await db.relations.add({ type: "notebook", id: parentId }, { type: "notebook", id });
  state.notebooks[key] = id;
  return id;
}

async function ensureTag(db: Db, title: string) {
  const existing = await db.tags.find(title);
  return existing ? existing.id : await db.tags.add({ title });
}

export async function runImport(
  db: Db,
  vault: string,
  rootNotebook: string | undefined,
  log: (msg: string) => void
) {
  const state = loadState();
  const plan = planImport(vault, state.notes);
  const resolve = linkResolver(plan.notes);
  const root = rootNotebook ? await ensureNotebook(db, state, "", rootNotebook) : undefined;

  let created = 0;
  let updated = 0;
  for (const note of plan.notes) {
    const html = await bodyToHtml(noteMarkdown(note, resolve), "markdown");
    const exists = !!(await db.notes.note(note.id));
    await db.notes.add({
      id: note.id,
      title: note.title,
      content: { type: "tiptap", data: html },
      dateCreated: note.dateCreated,
      dateEdited: note.dateEdited
    });
    if (exists) updated++;
    else created++;
    state.notes[note.relPath] = note.id;

    const notebookIds: string[] = [];
    if (note.template) notebookIds.push(await ensureNotebook(db, state, "templates", "Templates", root));
    if (note.type) notebookIds.push(await ensureNotebook(db, state, `type:${note.type}`, note.type, root));
    let parent = root;
    for (let i = 0; i < note.folders.length; i++) {
      const key = `folder:${note.folders.slice(0, i + 1).join("/")}`;
      parent = await ensureNotebook(db, state, key, note.folders[i], parent);
    }
    if (note.folders.length && parent) notebookIds.push(parent);
    if (!notebookIds.length && root) notebookIds.push(root);
    for (const nb of notebookIds) await db.notes.addToNotebook(nb, note.id);
    for (const tag of note.tags)
      await db.relations.add({ type: "tag", id: await ensureTag(db, tag) }, { type: "note", id: note.id });
    if (note.archived) await db.notes.archive(true, note.id);
    log(`  ${exists ? "updated" : "created"}: ${note.title}`);
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  return { created, updated, skipped: plan.skipped.length };
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getContentFromData } from "@notesnook/core";
import { openDatabase } from "./db.js";
import { NotesnookSync } from "./sync.js";
import { bodyToHtml } from "./format.js";
import { escapeHtml, fillTemplate, templateVariables } from "./templates.js";

const ALLOW_WRITE = process.env.NOTESNOOK_MCP_ALLOW_WRITE === "1";
const MAX_CHARS = Number(process.env.NOTESNOOK_MCP_MAX_NOTE_CHARS) || 100_000;

type Db = Awaited<ReturnType<typeof openDatabase>>["db"];

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }
  ]
});
const fail = (message: string) => ({ ...text(message), isError: true });
const iso = (t?: number) => (t ? new Date(t).toISOString() : undefined);

async function readContent(db: Db, noteId: string) {
  return db.content.findByNoteId(noteId);
}

async function noteLinks(db: Db, noteId: string) {
  const [notebooks, tags] = await Promise.all([
    db.relations.to({ type: "note", id: noteId }, "notebook").resolve(),
    db.relations.to({ type: "note", id: noteId }, "tag").resolve()
  ]);
  return {
    notebooks: notebooks.map((n) => ({ id: n.id, title: n.title })),
    tags: tags.map((t) => ({ id: t.id, title: t.title }))
  };
}

const TEMPLATES_NOTEBOOK = process.env.NOTESNOOK_MCP_TEMPLATES_NOTEBOOK || "Templates";

async function findNotebookByTitle(db: Db, title: string) {
  const all = await db.notebooks.all.items();
  return all.find((nb) => nb.title.trim().toLowerCase() === title.trim().toLowerCase());
}

async function templateNotes(db: Db) {
  const nb = await findNotebookByTitle(db, TEMPLATES_NOTEBOOK);
  if (!nb) return [];
  return db.relations.from({ type: "notebook", id: nb.id }, "note").resolve();
}

async function syncAfterWrite(syncer: NotesnookSync, reason: string) {
  try {
    await syncer.sync(reason);
    return { synced: true };
  } catch (e) {
    return { synced: false, syncError: (e as Error).message };
  }
}

export async function serve() {
  const opened = await openDatabase();
  const { db } = opened;
  const user = await db.user.getUser();
  if (!user) {
    await opened.close();
    throw new Error("Not logged in. Run `notesnook-mcp login` in a terminal first.");
  }

  const syncer = new NotesnookSync(db, ALLOW_WRITE);
  // Initial sync in the background so the MCP handshake isn't delayed.
  syncer.sync("startup").catch(() => {});

  const server = new McpServer({ name: "notesnook", version: "0.1.0" });

  server.registerTool(
    "search_notes",
    {
      description:
        "Full-text search the user's Notesnook notes (title and content). Returns note ids, titles, a short headline and dates.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)")
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query, limit }) => {
      await syncer.ensureFresh();
      const notes = await db.lookup.notes(query).items(limit ?? 20);
      return text(
        notes.map((n) => ({
          id: n.id,
          title: n.title,
          headline: n.locked ? "(locked)" : n.headline,
          dateEdited: iso(n.dateEdited),
          pinned: n.pinned || undefined
        }))
      );
    }
  );

  server.registerTool(
    "get_note",
    {
      description:
        "Get a note by id: title, notebooks, tags, dates and content as markdown (default), plain text or html.",
      inputSchema: {
        id: z.string().describe("Note id"),
        format: z.enum(["markdown", "text", "html"]).optional().describe("Default: markdown")
      },
      annotations: { readOnlyHint: true }
    },
    async ({ id, format }) => {
      await syncer.ensureFresh();
      const note = await db.notes.note(id);
      if (!note) return fail(`Note ${id} not found.`);
      const content = await readContent(db, id);
      let body = "";
      if (content?.locked)
        body = "(This note is locked in the Notesnook vault; its content is not available.)";
      else if (content && typeof content.data === "string") {
        const tiptap = await getContentFromData(content.type ?? "tiptap", content.data);
        const fmt = format ?? "markdown";
        body = fmt === "html" ? tiptap.toHTML() : fmt === "text" ? tiptap.toTXT() : tiptap.toMD();
      }
      const truncated = body.length > MAX_CHARS;
      return text({
        id: note.id,
        title: note.title,
        ...(await noteLinks(db, id)),
        dateCreated: iso(note.dateCreated),
        dateEdited: iso(note.dateEdited),
        pinned: note.pinned || undefined,
        favorite: note.favorite || undefined,
        inTrash: db.trash.cache.notes.includes(id) || undefined,
        truncated: truncated || undefined,
        content: truncated ? body.slice(0, MAX_CHARS) : body
      });
    }
  );

  server.registerTool(
    "list_notebooks",
    {
      description: "List all notebooks (id, title, description, parentId, number of notes).",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      await syncer.ensureFresh();
      const notebooks = await db.notebooks.all.items();
      const result = [];
      for (const nb of notebooks) {
        result.push({
          id: nb.id,
          title: nb.title,
          description: nb.description || undefined,
          parentId: await db.notebooks.parentId(nb.id),
          totalNotes: [await db.notebooks.totalNotes(nb.id)].flat()[0] ?? 0
        });
      }
      return text(result);
    }
  );

  server.registerTool(
    "list_tags",
    {
      description: "List all tags (id, title).",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      await syncer.ensureFresh();
      const tags = await db.tags.all.items();
      return text(tags.map((t) => ({ id: t.id, title: t.title })));
    }
  );

  server.registerTool(
    "list_templates",
    {
      description: `List template notes (notes in the "${TEMPLATES_NOTEBOOK}" notebook). Use with create_from_template.`,
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      await syncer.ensureFresh();
      const notes = await templateNotes(db);
      return text(notes.map((n) => ({ id: n.id, title: n.title, headline: n.headline })));
    }
  );

  server.registerTool(
    "sync_now",
    {
      description: ALLOW_WRITE
        ? "Sync with the Notesnook server now (pull + push)."
        : "Pull the latest changes from the Notesnook server now (read-only mode: never pushes).",
      inputSchema: {},
      annotations: { readOnlyHint: !ALLOW_WRITE }
    },
    async () => {
      try {
        await syncer.sync("manual");
        return text({ ok: true, ...(await syncer.status()) });
      } catch (e) {
        return fail(`Sync failed: ${(e as Error).message}`);
      }
    }
  );

  if (ALLOW_WRITE) {
    server.registerTool(
      "create_note",
      {
        description:
          "Create a new note in Notesnook and sync it to the server so it appears on the user's other devices.",
        inputSchema: {
          title: z.string().min(1),
          content: z
            .string()
            .describe(
              "Note body (markdown by default). Link to another note with [text](nn://note/<noteId>)."
            ),
          format: z.enum(["markdown", "text"]).optional().describe("Default: markdown"),
          notebookId: z.string().optional().describe("Notebook id from list_notebooks"),
          tagIds: z.array(z.string()).optional().describe("Tag ids from list_tags")
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      async ({ title, content, format, notebookId, tagIds }) => {
        await syncer.ensureFresh();
        if (notebookId && !(await db.notebooks.exists(notebookId)))
          return fail(`Notebook ${notebookId} not found.`);
        for (const tagId of tagIds ?? [])
          if (!(await db.tags.exists(tagId))) return fail(`Tag ${tagId} not found.`);

        const html = await bodyToHtml(content, format ?? "markdown");
        const id = await db.notes.add({ title, content: { type: "tiptap", data: html } });
        if (!id) return fail("Failed to create note.");
        if (notebookId) await db.notes.addToNotebook(notebookId, id);
        for (const tagId of tagIds ?? [])
          await db.relations.add({ type: "tag", id: tagId }, { type: "note", id });

        return text({ id, title, ...(await syncAfterWrite(syncer, "create_note")) });
      }
    );

    server.registerTool(
      "update_note",
      {
        description:
          "Update an existing note: change its title and/or append to (default) or replace its content. Never deletes notes.",
        inputSchema: {
          id: z.string(),
          title: z.string().optional(),
          content: z
            .string()
            .optional()
            .describe("Body to append/replace (markdown by default). Note links: [text](nn://note/<noteId>)"),
          format: z.enum(["markdown", "text"]).optional().describe("Default: markdown"),
          mode: z.enum(["append", "replace"]).optional().describe("Default: append")
        },
        annotations: { readOnlyHint: false, destructiveHint: true }
      },
      async ({ id, title, content, format, mode }) => {
        await syncer.ensureFresh();
        const note = await db.notes.note(id);
        if (!note) return fail(`Note ${id} not found.`);
        if (title === undefined && content === undefined) return fail("Nothing to update.");
        const existing = await readContent(db, id);
        if (content !== undefined && existing?.locked)
          return fail("Note is locked in the vault; cannot edit its content.");

        const update: Parameters<Db["notes"]["add"]>[0] = { id };
        if (title !== undefined) update.title = title;
        if (content !== undefined) {
          const html = await bodyToHtml(content, format ?? "markdown");
          const prev = typeof existing?.data === "string" ? existing.data : "";
          update.content = {
            type: "tiptap",
            data: (mode ?? "append") === "append" ? prev + html : html
          };
        }
        await db.notes.add(update);
        return text({ id, ...(await syncAfterWrite(syncer, "update_note")) });
      }
    );

    server.registerTool(
      "create_from_template",
      {
        description:
          "Create a note from a template note (see list_templates). Placeholders {{date}} (YYYY-MM-DD), {{time}}, {{weekday}}, {{title}} and any custom {{name}} from `variables` are filled in. By default the note goes into the notebook named like the template (e.g. template \"Daily Log\" -> notebook \"Daily Log\") and is titled with today's date.",
        inputSchema: {
          templateId: z.string().describe("Template note id from list_templates"),
          title: z.string().optional().describe("Note title (default: {{date}}); placeholders allowed"),
          notebookId: z.string().optional().describe("Override target notebook"),
          tagIds: z.array(z.string()).optional(),
          variables: z.record(z.string(), z.string()).optional().describe("Custom placeholder values")
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      async ({ templateId, title, notebookId, tagIds, variables }) => {
        await syncer.ensureFresh();
        const template = await db.notes.note(templateId);
        if (!template) return fail(`Template ${templateId} not found.`);
        const tplContent = await readContent(db, templateId);
        if (tplContent?.locked) return fail("Template is locked in the vault.");
        if (notebookId && !(await db.notebooks.exists(notebookId)))
          return fail(`Notebook ${notebookId} not found.`);
        for (const tagId of tagIds ?? [])
          if (!(await db.tags.exists(tagId))) return fail(`Tag ${tagId} not found.`);

        const vars = templateVariables(new Date(), variables ?? {});
        const noteTitle = fillTemplate(title ?? "{{date}}", vars);
        vars.title = noteTitle;
        const html = fillTemplate(
          (typeof tplContent?.data === "string" ? tplContent.data : "").replace(/ data-block-id="[^"]*"/g, ""),
          vars,
          escapeHtml
        );
        const target = notebookId ?? (await findNotebookByTitle(db, template.title))?.id;
        const id = await db.notes.add({ title: noteTitle, content: { type: "tiptap", data: html } });
        if (!id) return fail("Failed to create note.");
        if (target) await db.notes.addToNotebook(target, id);
        for (const tagId of tagIds ?? [])
          await db.relations.add({ type: "tag", id: tagId }, { type: "note", id });
        return text({
          id,
          title: noteTitle,
          notebookId: target,
          ...(await syncAfterWrite(syncer, "create_from_template"))
        });
      }
    );

    server.registerTool(
      "create_notebook",
      {
        description:
          "Create a notebook (optionally nested under a parent notebook) and sync it.",
        inputSchema: {
          title: z.string().min(1),
          description: z.string().optional(),
          parentId: z.string().optional().describe("Parent notebook id for a sub-notebook")
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      async ({ title, description, parentId }) => {
        await syncer.ensureFresh();
        if (parentId && !(await db.notebooks.exists(parentId)))
          return fail(`Notebook ${parentId} not found.`);
        const id = await db.notebooks.add({ title, description });
        if (!id) return fail("Failed to create notebook.");
        if (parentId)
          await db.relations.add({ type: "notebook", id: parentId }, { type: "notebook", id });
        return text({ id, title, parentId, ...(await syncAfterWrite(syncer, "create_notebook")) });
      }
    );

    server.registerTool(
      "create_tag",
      {
        description: "Create a tag and sync it. Returns the existing tag if one with this title exists.",
        inputSchema: { title: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      async ({ title }) => {
        await syncer.ensureFresh();
        const existing = await db.tags.find(title);
        if (existing) return text({ id: existing.id, title: existing.title, existed: true });
        const id = await db.tags.add({ title });
        return text({ id, title, ...(await syncAfterWrite(syncer, "create_tag")) });
      }
    );

    server.registerTool(
      "organize_note",
      {
        description:
          "Add an existing note to notebooks and/or tags, and set pinned/favorite. Only adds; never removes or deletes.",
        inputSchema: {
          id: z.string().describe("Note id"),
          notebookIds: z.array(z.string()).optional(),
          tagIds: z.array(z.string()).optional(),
          pinned: z.boolean().optional(),
          favorite: z.boolean().optional()
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      async ({ id, notebookIds, tagIds, pinned, favorite }) => {
        await syncer.ensureFresh();
        if (!(await db.notes.note(id))) return fail(`Note ${id} not found.`);
        for (const nb of notebookIds ?? [])
          if (!(await db.notebooks.exists(nb))) return fail(`Notebook ${nb} not found.`);
        for (const tag of tagIds ?? [])
          if (!(await db.tags.exists(tag))) return fail(`Tag ${tag} not found.`);

        for (const nb of notebookIds ?? []) await db.notes.addToNotebook(nb, id);
        for (const tag of tagIds ?? [])
          await db.relations.add({ type: "tag", id: tag }, { type: "note", id });
        if (pinned !== undefined) await db.notes.pin(pinned, id);
        if (favorite !== undefined) await db.notes.favorite(favorite, id);
        return text({
          id,
          ...(await noteLinks(db, id)),
          ...(await syncAfterWrite(syncer, "organize_note"))
        });
      }
    );
  }

  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const closeResources = () => (closing ??= opened.close());
  transport.onclose = () => {
    void closeResources().catch((e) => console.error(`notesnook-mcp: close failed: ${(e as Error).message}`));
  };
  process.once("SIGINT", () => {
    void server.close().finally(() => closeResources()).catch((e) => {
      console.error(`notesnook-mcp: shutdown failed: ${(e as Error).message}`);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void server.close().finally(() => closeResources()).catch((e) => {
      console.error(`notesnook-mcp: shutdown failed: ${(e as Error).message}`);
      process.exitCode = 1;
    });
  });
  await server.connect(transport);
  console.error(`notesnook-mcp: serving ${user.email} (${ALLOW_WRITE ? "read-write" : "read-only"})`);
}

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { planImport, noteMarkdown, linkResolver } from "../dist/tolaria.js";

function vault() {
  const dir = mkdtempSync(path.join(tmpdir(), "tolaria-test-"));
  const w = (rel, body) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  w("AGENTS.md", "# sample");
  w("recipe.md", "---\ntype: Type\n---\n# Recipe");
  w("views/x.yml", "name: x");
  w("type/daily-log.md", "---\ntype: Type\n---\n# Daily Log\n\n## Done\n- [ ] \n");
  w("reno.md", "---\ntype: Project\nstatus: Active\ntags: [home]\nbelongs_to: \"[[house]]\"\nurl: https://e.com\n_organized: true\n---\n# Renovation\n\nSee [[Kitchen]] and [[house|the house]] and [[nope]].\n\n![img](attachments/a.png)\n\n> [!TIP] Hint\n> text\n");
  w("house.md", "---\naliases: [Kitchen]\n---\nNo heading here.");
  w("sub/dir/sheet.md", "---\n_display: sheet\narchived: true\n---\na,b\n\"x, y\",2\n");
  return dir;
}

test("planImport skips samples, type docs and non-markdown; maps metadata", () => {
  const dir = vault();
  try {
    const plan = planImport(dir);
    assert.deepEqual(plan.notes.map((n) => n.relPath), ["house.md", "reno.md", "sub/dir/sheet.md", "type/daily-log.md"]);
    const tpl = plan.notes.find((n) => n.template);
    assert.equal(tpl.title, "Daily Log");
    assert.deepEqual(tpl.folders, []);
    assert.match(tpl.body, /## Done/);
    assert.ok(plan.skipped.some((s) => s.startsWith("AGENTS.md")));
    assert.ok(plan.skipped.some((s) => s.startsWith("recipe.md (type definition without template)")));
    const reno = plan.notes.find((n) => n.relPath === "reno.md");
    assert.equal(reno.title, "Renovation");
    assert.deepEqual(reno.tags, ["home", "status/active"]);
    assert.ok(!reno.properties.some(([k]) => k.startsWith("_")));
    const sheet = plan.notes.find((n) => n.relPath.endsWith("sheet.md"));
    assert.deepEqual(sheet.folders, ["sub", "dir"]);
    assert.equal(sheet.archived, true);
    assert.equal(plan.notes.find((n) => n.relPath === "house.md").title, "House");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("noteMarkdown converts wikilinks, drops images, keeps properties and sheets", () => {
  const dir = vault();
  try {
    const plan = planImport(dir);
    const resolve = linkResolver(plan.notes);
    const house = plan.notes.find((n) => n.relPath === "house.md");
    const md = noteMarkdown(plan.notes.find((n) => n.relPath === "reno.md"), resolve);
    assert.match(md, new RegExp(`\\[Kitchen\\]\\(nn://note/${house.id}\\)`));
    assert.match(md, new RegExp(`\\[the house\\]\\(nn://note/${house.id}\\)`));
    assert.match(md, /\*\*Belongs to:\*\* \[House\]\(nn:\/\/note\//);
    assert.match(md, /\*\*URL:\*\* <https:\/\/e\.com>/);
    assert.match(md, /and nope\./);
    assert.doesNotMatch(md, /attachments|!\[/);
    assert.match(md, /> \*\*Tip: Hint\*\*/);
    const sheet = noteMarkdown(plan.notes.find((n) => n.relPath.endsWith("sheet.md")), resolve);
    assert.match(sheet, /\| x, y \| 2 \|/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

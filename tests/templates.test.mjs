import assert from "node:assert/strict";
import test from "node:test";
import { fillTemplate, templateVariables, escapeHtml } from "../dist/templates.js";

test("templateVariables formats date/time/weekday and merges extras", () => {
  const v = templateVariables(new Date(2026, 9, 6, 9, 5), { who: "Jana" });
  assert.equal(v.date, "2026-10-06");
  assert.equal(v.time, "09:05");
  assert.equal(v.weekday, "Tuesday");
  assert.equal(v.who, "Jana");
});

test("fillTemplate replaces known placeholders, escapes values, keeps unknown", () => {
  const out = fillTemplate("<p>{{ date }} with {{who}} {{unknown}}</p>", { date: "2026-10-06", who: "<b>J</b>" }, escapeHtml);
  assert.equal(out, "<p>2026-10-06 with &lt;b&gt;J&lt;/b&gt; {{unknown}}</p>");
});

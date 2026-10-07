import assert from "node:assert/strict";
import test from "node:test";
import { bodyToHtml } from "../dist/format.js";

test("markdown becomes Notesnook-compatible HTML", async () => {
  assert.equal(await bodyToHtml("# Heading\n\n**bold**", "markdown"), "<h1>Heading</h1>\n<p><strong>bold</strong></p>\n");
});

test("plain text escapes HTML and preserves paragraphs", async () => {
  assert.equal(
    await bodyToHtml("<script>alert(1)</script>\nnext\n\nthird", "text"),
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;<br>next</p><p>third</p>"
  );
});

test("markdown treats raw HTML as text", async () => {
  assert.equal(
    await bodyToHtml("<script>alert(1)</script>", "markdown"),
    "&lt;script&gt;alert(1)&lt;/script&gt;"
  );
});

test("markdown strips unsafe links and remote image markup", async () => {
  const html = await bodyToHtml("[bad](javascript:alert(1)) and ![private](https://example.com/image.png)", "markdown");
  assert.equal(html.includes("javascript:"), false);
  assert.equal(html.includes("<img"), false);
  assert.match(html, /bad/);
  assert.match(html, /private/);
});

test("markdown keeps Notesnook internal note links", async () => {
  assert.equal(
    await bodyToHtml("[other](nn://note/abc123)", "markdown"),
    '<p><a href="nn://note/abc123">other</a></p>\n'
  );
});

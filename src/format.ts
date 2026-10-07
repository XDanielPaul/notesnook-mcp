import { marked } from "marked";

function escapeHtml(value: string) {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };
  return value.replace(/[&<>"']/g, (c) => entities[c]);
}

export async function bodyToHtml(body: string, format: "markdown" | "text") {
  if (format === "markdown") {
    const renderer = new marked.Renderer();
    renderer.html = ({ text }) => escapeHtml(text);
    renderer.link = ({ href, title, tokens }) => {
      const protocol = /^([a-z][a-z\d+.-]*):/i.exec(href.trim())?.[1].toLowerCase();
      const label = renderer.parser.parseInline(tokens);
      if (protocol && !["http", "https", "mailto", "nn"].includes(protocol)) return label;
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href)}"${titleAttribute}>${label}</a>`;
    };
    renderer.image = ({ text }) => escapeHtml(text);
    return marked.parse(body, { gfm: true, breaks: false, renderer });
  }
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

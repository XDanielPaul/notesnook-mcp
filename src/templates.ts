const pad = (n: number) => String(n).padStart(2, "0");
export function templateVariables(now = new Date(), extra: Record<string, string> = {}) {
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    weekday: now.toLocaleDateString("en-US", { weekday: "long" }),
    ...extra
  } as Record<string, string>;
}

export function fillTemplate(text: string, vars: Record<string, string>, escape: (v: string) => string = (v) => v) {
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, key: string) =>
    key in vars ? escape(vars[key]) : m
  );
}

export const escapeHtml = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

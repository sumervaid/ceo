import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked, Renderer } from "marked";

const renderer = new Renderer();
renderer.code = ({ text, lang }) => {
  const language = lang && hljs.getLanguage(lang) ? lang : null;
  const html = language ? hljs.highlight(text, { language }).value : escapeHtml(text);
  return `<pre class="md-code"><code class="hljs">${html}</code></pre>`;
};
marked.use({ renderer, breaks: false, gfm: true });

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Agent output is untrusted. Everything passes through the sanitizer before it reaches the page. */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, { FORBID_TAGS: ["style", "form", "input", "iframe", "img", "svg", "math"], FORBID_ATTR: ["style", "onerror", "onclick"] });
}

const EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cs: "csharp", php: "php", sh: "bash", zsh: "bash", bash: "bash", json: "json", yml: "yaml", yaml: "yaml",
  md: "markdown", html: "xml", xml: "xml", css: "css", scss: "scss", sql: "sql", toml: "ini", ini: "ini", r: "r", lua: "lua",
};

export function languageOf(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT[ext] ?? null;
}

/** One line of code, highlighted. hljs escapes its input, so the result is safe to set as HTML. */
export function highlightLine(line: string, language: string | null): string {
  if (!language || line.length > 2000) return escapeHtml(line);
  try {
    return hljs.highlight(line, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(line);
  }
}

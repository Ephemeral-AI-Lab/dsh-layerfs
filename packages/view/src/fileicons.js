// Icons for the Files pane: a folder (open or closed, tinted for special
// folders) or a small badge for a file's kind, by its name.

const FOLDER_TINT = { ".git": "#E07A5A", node_modules: "#9A958B", ".next": "#5B6372", dist: "#9A958B", build: "#9A958B", app: "#2F5BB5", src: "#2F5BB5", components: "#8A6BC8", lib: "#3E9B74", public: "#D29A2E", tests: "#C8557A", test: "#C8557A", docs: "#2B8A9A", scripts: "#3E9B74", ".github": "#5B6372" };
// [badge text, colour] by full name, then by extension
const BY_NAME = {
  "package.json": ["npm", "#C8452F"], "package-lock.json": ["lock", "#9A958B"], "yarn.lock": ["lock", "#9A958B"], "pnpm-lock.yaml": ["lock", "#9A958B"], "cargo.lock": ["lock", "#9A958B"],
  dockerfile: ["dkr", "#2B8A9A"], makefile: ["mk", "#5B6372"], license: ["lic", "#8A8780"], ".gitignore": ["git", "#E07A5A"], ".env": ["env", "#D29A2E"], "readme.md": ["i", "#2F5BB5"], "cargo.toml": ["rs", "#B8502C"], "tsconfig.json": ["ts", "#2F5BB5"],
};
const BY_EXT = {
  js: ["JS", "#C9A20B"], mjs: ["JS", "#C9A20B"], cjs: ["JS", "#C9A20B"], jsx: ["JSX", "#1F8FAE"], ts: ["TS", "#2F5BB5"], tsx: ["TSX", "#1F8FAE"], mts: ["TS", "#2F5BB5"],
  json: ["{}", "#93650F"], md: ["M↓", "#2F5BB5"], mdx: ["M↓", "#2F5BB5"], css: ["#", "#8A6BC8"], scss: ["#", "#C8557A"], html: ["<>", "#E07A5A"], svg: ["svg", "#D29A2E"],
  py: ["py", "#2F5BB5"], rs: ["rs", "#B8502C"], go: ["go", "#2B8A9A"], sh: ["$", "#3E9B74"], bash: ["$", "#3E9B74"], zsh: ["$", "#3E9B74"], yml: ["yml", "#C8452F"], yaml: ["yml", "#C8452F"], toml: ["tml", "#8A6B3A"],
  sql: ["sql", "#2B8A9A"], sqlite: ["db", "#2B8A9A"], txt: ["txt", "#8A8780"], log: ["log", "#8A8780"], lock: ["lock", "#9A958B"], env: ["env", "#D29A2E"],
  png: ["img", "#3E9B74"], jpg: ["img", "#3E9B74"], jpeg: ["img", "#3E9B74"], gif: ["img", "#3E9B74"], webp: ["img", "#3E9B74"], ico: ["ico", "#3E9B74"],
  woff: ["font", "#8A8780"], woff2: ["font", "#8A8780"], ttf: ["font", "#8A8780"], map: ["map", "#9A958B"], pack: ["pk", "#9A958B"], idx: ["idx", "#9A958B"],
};

const FOLDER = (c, open) => `<svg class="fico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style="color:${c}">${open
  ? `<path d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5h5.2c.7 0 1.2.5 1.2 1.2V6H4.1c-.6 0-1 .3-1.2.9L1.5 11z" fill="currentColor" opacity=".55"/><path d="M3 6.6c.2-.4.5-.6.9-.6h10.4c.5 0 .8.5.6 1l-1.6 5.2c-.1.5-.6.8-1.1.8H2.4c-.5 0-.8-.5-.6-1z" fill="currentColor"/>`
  : `<path d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5h5.9c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H2.7c-.7 0-1.2-.5-1.2-1.2z" fill="currentColor"/><path d="M1.5 6h13" stroke="#fff" stroke-opacity=".35"/>`}</svg>`;

/** The icon of a tree entry: `type` "dir" or "file". */
export function iconOf(name, type, open = false) {
  const n = name.toLowerCase();
  if (type === "dir") return FOLDER(FOLDER_TINT[n] || "#C9A86A", open);
  const ext = n.includes(".") ? n.slice(n.lastIndexOf(".") + 1) : "";
  const [t, c] = BY_NAME[n] || (n.startsWith(".env") ? BY_NAME[".env"] : null) || BY_EXT[ext] || ["", "#9A958B"];
  if (!t) return `<svg class="fico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z" fill="#fff" stroke="${c}" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" fill="none" stroke="${c}" stroke-linejoin="round"/></svg>`;
  return `<span class="fico badge${t.length > 2 ? " w" : ""}" style="--fc:${c}" aria-hidden="true">${t}</span>`;
}

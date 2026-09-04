// dsh-jdpatterns v3 — 设计模式参考库（host 半）
// 形态：静态插件；inject ["systemPrompt","tools","webServer","fs"]。
// 铁律：所有异步入口（工具 execute、HTTP handler、初始加载、事件 listener）全部
// try/catch 返回结构化错误；模块顶层零 I/O；闸门自身任何异常一律 fail-open 放行。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, resolve as pathResolve, sep } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "设计模式参考库";
export const inject = ["systemPrompt", "tools", "webServer", "fs"];

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(PLUGIN_DIR, "config.json");
const LANG_RE = /^[a-z][a-z0-9-]*$/;
const BUILTIN_LANGS = ["java"];
const DEFAULT_INDEX = { java: "PATTERNS.zh.md" };
// 源码扩展名映射（14 种语言）
const SOURCE_EXTS = {
  java: [".java"], javascript: [".js", ".jsx"], typescript: [".ts", ".tsx"],
  python: [".py"], go: [".go"], rust: [".rs"], c: [".c", ".h"],
  cpp: [".cpp", ".hpp", ".cc"], csharp: [".cs"], kotlin: [".kt"],
  ruby: [".rb"], php: [".php"], swift: [".swift"], scala: [".scala"],
};
const ALL_SOURCE_EXTS = new Set(Object.values(SOURCE_EXTS).flat());
const SKIP_MODULE_DIRS = new Set(["etc", "src", "lib", "docs"]);
const SKIP_SECTION_RE = /license|contribut|contributors/i;
const WALK_SKIP_DIRS = new Set(["node_modules", ".git", "target", "build", "dist", ".idea", ".gradle", "__pycache__"]);
// 硬闸门受控扩展名：按语言标签映射受拦截的源码后缀；未列出的语言按扩展名 .<lang> 兜底
const GATE_EXT_BY_LANG = {
  java: [".java"], kotlin: [".kt"], scala: [".scala"],
  python: [".py"], javascript: [".js", ".jsx", ".mjs"], typescript: [".ts", ".tsx"],
  go: [".go"], rust: [".rs"], c: [".c"], cpp: [".cpp", ".cc"], csharp: [".cs"],
};
const MAX_FILES = 120;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 1500 * 1024;
const GIT_CANDIDATES = ["F:\\App\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe", "git"];

const REMINDER_TEXT = [
  "【设计模式参考库】本会话已读取受控语言的源码。若后续要实现或修改设计模式相关代码，",
  "建议先用 jdpatterns_catalog 查阅本地参考仓库的模式目录（java 等语言，含 189 个模式实现），",
  "再用 jdpatterns_read 阅读参考实现的 README 与完整源码——参考库提供的是经社区验证的最佳实践，",
  "查阅后再动手可以让实现直接对齐成熟范式。查阅成功后，写源码前的硬闸门也会自动放行。",
].join("");

function denyReason(exts) {
  return [
    `硬闸门（设计模式参考库 dsh-jdpatterns）：本会话尚未查阅设计模式参考库，禁止写/改参考仓库之外的 ${exts} 源码文件。`,
    "行动指令：先调用 jdpatterns_catalog 查询候选设计模式；如需细节再调用 jdpatterns_read 阅读参考实现（README+源码）。两者任一成功后本闸门自动放行，随后重新发起本次写入。",
    "如目录中确无合适模式，调用 jdpatterns_catalog 确认后即可放行，禁止凭空套用记忆中的模式。",
  ].join("\n");
}

// 判断文件扩展名是否落在某语言闸门的受控集合内
function gateMatchesLang(rawPath, lang) {
  const exts = GATE_EXT_BY_LANG[lang] || ["." + lang];
  const lower = String(rawPath).toLowerCase();
  return exts.some((e) => lower.endsWith(e.toLowerCase()));
}

// 找出当前路径命中哪些已配置且开启闸门的语言
function matchedGatedLanguages(rawPath, cfg) {
  const hits = [];
  for (const [lang, entry] of Object.entries(cfg.languages || {})) {
    if (!entry || entry.gate === false) continue;
    if (gateMatchesLang(rawPath, lang)) hits.push(lang);
  }
  return hits;
}

// ---------- 配置（自管 JSON，不依赖 settings 服务，避免热重载竞态） ----------

const DEFAULT_CONFIG = {
  gateEnabled: true,
  languages: {
    java: {
      remoteUrl: "https://github.com/iluwatar/java-design-patterns.git",
      localPath: "F:\\project\\java-design-patterns",
      indexFile: "PATTERNS.zh.md",
    },
  },
};

function makeState() {
  return {
    config: null,
    configError: null,
    catalogCache: new Map(), // lang -> { patterns, mtimeMs, parsedAt }
    gatedSessions: new Set(), // 进程内存：宿主重启后重置（每会话重新触发一次，可接受）
    remindedSessions: new Set(), // 已注入过参考库提醒的会话（每会话一次）
  };
}

async function readConfigFile() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch (err) {
    if (err && err.code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw err;
  }
}

function normalizeConfig(input) {
  const cfg = { gateEnabled: true, languages: {} };
  if (input && typeof input === "object") {
    cfg.gateEnabled = input.gateEnabled !== false;
    const langs = input.languages && typeof input.languages === "object" ? input.languages : {};
    for (const [key, val] of Object.entries(langs)) {
      if (!LANG_RE.test(key) || !val || typeof val !== "object") continue;
      cfg.languages[key] = {
        remoteUrl: typeof val.remoteUrl === "string" ? val.remoteUrl : "",
        localPath: typeof val.localPath === "string" ? val.localPath : "",
        indexFile: typeof val.indexFile === "string" && val.indexFile ? val.indexFile : (DEFAULT_INDEX[key] || "README.md"),
        gate: val.gate !== false,
      };
    }
  }
  if (!cfg.languages.java) cfg.languages.java = structuredClone(DEFAULT_CONFIG.languages.java);
  return cfg;
}

function validateConfigCandidate(input) {
  if (!input || typeof input !== "object") return "配置必须是 JSON 对象";
  if (input.languages && typeof input.languages === "object") {
    for (const [key, val] of Object.entries(input.languages)) {
      if (!LANG_RE.test(key)) return `语言标签不合法（需 ^[a-z][a-z0-9-]*$）：${key}`;
      if (!val || typeof val !== "object") return `语言配置必须是对象：${key}`;
      if (typeof val.localPath !== "string" || !val.localPath.trim()) return `语言 ${key} 缺少 localPath`;
    }
    if (input.languages && !("java" in input.languages)) return "java 为内置语言，不可删除";
  }
  return null;
}

// ---------- 目录索引解析（通用 markdown 索引：## 分类标题 + [名称](./模块目录) 链接） ----------

function parseIndexMarkdown(text) {
  const patterns = [];
  const seen = new Set();
  let category = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1].trim();
      if (SKIP_SECTION_RE.test(title)) { category = null; continue; }
      category = title.replace(/\s*[（(]\s*\d+\s*[)）]\s*$/, "").trim();
      continue;
    }
    if (!category) continue;
    const linkRe = /\[([^\]]+)\]\((?:\.\/)?([^)#\s]+?)\/?(?:#[^)]*)?\)/g;
    let m;
    while ((m = linkRe.exec(line)) !== null) {
      const label = m[1].trim();
      const mod = m[2].trim();
      if (!label || !mod) continue;
      if (SKIP_MODULE_DIRS.has(mod.toLowerCase())) continue;
      if (/\.(?:png|jpe?g|gif|svg|pdf|zip)$/i.test(mod)) continue;
      if (seen.has(mod)) continue;
      seen.add(mod);
      patterns.push({ name: label, module: mod, category });
    }
  }
  return patterns;
}

async function loadCatalog(state, lang) {
  const cfg = state.config;
  const entry = cfg && cfg.languages ? cfg.languages[lang] : undefined;
  if (!entry) throw new Error(`未配置语言：${lang}（可用：${Object.keys(cfg ? cfg.languages : {}).join(", ") || "无"}）`);
  if (!entry.localPath) throw new Error(`语言 ${lang} 未配置 localPath`);
  const indexPath = isAbsolute(entry.indexFile) ? entry.indexFile : join(entry.localPath, entry.indexFile);
  const text = await readFile(indexPath, "utf8");
  const patterns = parseIndexMarkdown(text);
  state.catalogCache.set(lang, { patterns, parsedAt: Date.now() });
  return patterns;
}

async function getCatalog(state, lang) {
  const cached = state.catalogCache.get(lang);
  if (cached) return cached.patterns;
  return loadCatalog(state, lang);
}

// ---------- 模块源码阅读 ----------

async function walkSources(rootDir, lang) {
  const wanted = SOURCE_EXTS[lang] ? new Set(SOURCE_EXTS[lang]) : ALL_SOURCE_EXTS;
  const files = [];
  let totalBytes = 0;
  let truncated = false;
  const queue = [rootDir];
  while (queue.length > 0 && files.length < MAX_FILES && !truncated) {
    const dir = queue.shift();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (files.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) { truncated = true; break; }
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(e.name)) queue.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      const dot = e.name.lastIndexOf(".");
      const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : "";
      if (!wanted.has(ext)) continue;
      try {
        let content = await readFile(full, "utf8");
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > MAX_FILE_BYTES) { content = content.slice(0, MAX_FILE_BYTES) + "\n…（文件过大已截断）"; truncated = true; }
        totalBytes += Math.min(bytes, MAX_FILE_BYTES);
        files.push({ path: full.slice(rootDir.length + 1).split(sep).join("/"), content });
      } catch { /* 跳过不可读文件 */ }
    }
  }
  return { files, truncated };
}

async function readModule(state, lang, moduleName) {
  const cfg = state.config;
  const entry = cfg && cfg.languages ? cfg.languages[lang] : undefined;
  if (!entry) throw new Error(`未配置语言：${lang}`);
  const patterns = await getCatalog(state, lang);
  const hit = patterns.find((p) => p.module === moduleName);
  const moduleDir = join(entry.localPath, moduleName);
  if (!existsSync(moduleDir)) throw new Error(`模块目录不存在：${moduleDir}${hit ? "" : `（目录索引中也未找到 ${moduleName}，先用 jdpatterns_catalog 查询）`}`);
  let readme = "";
  for (const candidate of ["README.md", "README.MD", "README.zh.md", "readme.md"]) {
    try { readme = await readFile(join(moduleDir, candidate), "utf8"); break; } catch { /* try next */ }
  }
  const { files, truncated } = await walkSources(moduleDir, lang);
  return {
    language: lang,
    module: moduleName,
    category: hit ? hit.category : "",
    displayName: hit ? hit.name : moduleName,
    readme,
    fileCount: files.length,
    truncated,
    files,
  };
}

// ---------- git 更新（fetch + 当前分支 ff-only 合并 + 重解析） ----------

function pickGit() {
  for (const cand of GIT_CANDIDATES) {
    if (cand === "git") return cand;
    try { if (existsSync(cand)) return cand; } catch { /* continue */ }
  }
  return "git";
}

function runGit(gitExe, args, cwd, timeoutMs = 60000) {
  return new Promise((resolvePromise) => {
    try {
      execFile(gitExe, ["-c", "safe.directory=*", ...args], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) resolvePromise({ ok: false, error: `${err.message}\n${String(stderr || "").slice(0, 2000)}` });
        else resolvePromise({ ok: true, stdout: String(stdout || "") });
      });
    } catch (err) {
      resolvePromise({ ok: false, error: String(err && err.message || err) });
    }
  });
}

async function updateRepo(state, lang) {
  const cfg = state.config;
  const entry = cfg && cfg.languages ? cfg.languages[lang] : undefined;
  if (!entry) throw new Error(`未配置语言：${lang}`);
  const git = pickGit();
  const cwd = entry.localPath;
  if (!cwd || !existsSync(join(cwd, ".git"))) throw new Error(`参考仓库本地目录不是 git 仓库：${cwd}`);
  const branchRes = await runGit(git, ["rev-parse", "--abbrev-ref", "HEAD"], cwd, 10000);
  if (!branchRes.ok) throw new Error(`无法读取当前分支：${branchRes.error}`);
  const branch = branchRes.stdout.trim();
  const fetchRes = await runGit(git, ["fetch", "origin"], cwd);
  if (!fetchRes.ok) throw new Error(`git fetch 失败：${fetchRes.error}`);
  const mergeRes = await runGit(git, ["merge", "--ff-only", `origin/${branch}`], cwd);
  if (!mergeRes.ok) throw new Error(`ff-only 合并失败（本地有分叉或未提交改动？）：${mergeRes.error}`);
  state.catalogCache.delete(lang);
  const patterns = await loadCatalog(state, lang);
  return { language: lang, branch, merged: mergeRes.stdout.trim(), patterns: patterns.length };
}

// ---------- HTTP ----------

function readBody(req, cap = 256 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) { rejectPromise(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectPromise);
  });
}

function sendJson(res, code, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
  } catch { try { res.writeHead(500); res.end(); } catch { /* socket gone */ } }
}

async function repoStatus(state, lang) {
  const cfg = state.config;
  const entry = cfg && cfg.languages ? cfg.languages[lang] : undefined;
  if (!entry) return { language: lang, error: "未配置" };
  const out = { language: lang, localPath: entry.localPath, indexFile: entry.indexFile, remoteUrl: entry.remoteUrl, exists: false, git: false, branch: null, patterns: 0 };
  try {
    out.exists = existsSync(entry.localPath);
    out.git = out.exists && existsSync(join(entry.localPath, ".git"));
    if (out.git) {
      const res = await runGit(pickGit(), ["rev-parse", "--abbrev-ref", "HEAD"], entry.localPath, 8000);
      if (res.ok) out.branch = res.stdout.trim();
    }
    try { out.patterns = (await getCatalog(state, lang)).length; } catch (err) { out.indexError = String(err && err.message || err); }
  } catch (err) { out.error = String(err && err.message || err); }
  return out;
}

function registerRoutes(ctx, state) {
  const routes = [];
  routes.push(ctx.webServer.register({
    kind: "exact", path: "/api/jdpatterns/config",
    handler: async (req, res) => {
      try {
        if (req.method === "GET") { sendJson(res, 200, { config: state.config, builtinLanguages: BUILTIN_LANGS, languagePattern: "^[a-z][a-z0-9-]*$" }); return; }
        if (req.method === "PUT") {
          const body = JSON.parse((await readBody(req)) || "{}");
          const problem = validateConfigCandidate(body);
          if (problem) { sendJson(res, 400, { error: problem }); return; }
          state.config = normalizeConfig(body);
          state.catalogCache.clear();
          await mkdir(dirname(CONFIG_PATH), { recursive: true });
          await writeFile(CONFIG_PATH, JSON.stringify(state.config, null, 2), "utf8");
          sendJson(res, 200, { ok: true, config: state.config });
          return;
        }
        if (req.method === "DELETE") {
          const url = new URL(req.url, "http://localhost");
          const lang = url.searchParams.get("lang") || "";
          if (BUILTIN_LANGS.includes(lang)) { sendJson(res, 400, { error: `${lang} 为内置语言，不可删除` }); return; }
          if (!state.config || !state.config.languages[lang]) { sendJson(res, 404, { error: `未配置语言：${lang}` }); return; }
          delete state.config.languages[lang];
          state.catalogCache.delete(lang);
          await writeFile(CONFIG_PATH, JSON.stringify(state.config, null, 2), "utf8");
          sendJson(res, 200, { ok: true, config: state.config });
          return;
        }
        sendJson(res, 405, { error: "method not allowed" });
      } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    },
  }));
  routes.push(ctx.webServer.register({
    kind: "exact", path: "/api/jdpatterns/status",
    handler: async (req, res) => {
      try {
        if (req.method !== "GET") { sendJson(res, 405, { error: "method not allowed" }); return; }
        const langs = Object.keys(state.config ? state.config.languages : {});
        const statuses = [];
        for (const lang of langs) statuses.push(await repoStatus(state, lang));
        sendJson(res, 200, { gateEnabled: !!(state.config && state.config.gateEnabled), statuses });
      } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    },
  }));
  routes.push(ctx.webServer.register({
    kind: "exact", path: "/api/jdpatterns/pull",
    handler: async (req, res) => {
      try {
        if (req.method !== "POST" && req.method !== "GET") { sendJson(res, 405, { error: "method not allowed" }); return; }
        let lang = "java";
        if (req.method === "POST") {
          const body = JSON.parse((await readBody(req)) || "{}");
          if (typeof body.language === "string" && body.language) lang = body.language;
        } else {
          const url = new URL(req.url, "http://localhost");
          if (url.searchParams.get("lang")) lang = url.searchParams.get("lang");
        }
        const result = await updateRepo(state, lang);
        sendJson(res, 200, { ok: true, result });
      } catch (err) { sendJson(res, 500, { ok: false, error: String(err && err.message || err) }); }
    },
  }));
  routes.push(ctx.webServer.register({
    kind: "exact", path: "/api/jdpatterns/gate",
    handler: async (req, res) => {
      try {
        if (req.method === "GET") { sendJson(res, 200, { gateEnabled: !!(state.config && state.config.gateEnabled) }); return; }
        if (req.method === "PUT") {
          const body = JSON.parse((await readBody(req)) || "{}");
          if (typeof body.gateEnabled !== "boolean") { sendJson(res, 400, { error: "gateEnabled 必须是布尔值" }); return; }
          if (!state.config) state.config = structuredClone(DEFAULT_CONFIG);
          state.config.gateEnabled = body.gateEnabled;
          await writeFile(CONFIG_PATH, JSON.stringify(state.config, null, 2), "utf8");
          sendJson(res, 200, { ok: true, gateEnabled: body.gateEnabled });
          return;
        }
        sendJson(res, 405, { error: "method not allowed" });
      } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    },
  }));
  return () => { for (const dispose of routes) { try { dispose(); } catch { /* already gone */ } } };
}

// ---------- 系统提示节（order 118） ----------

function buildPromptSection(state) {
  const cfg = state.config;
  if (!cfg) return "";
  const langs = Object.entries(cfg.languages);
  const lines = ["## 设计模式参考库（dsh-jdpatterns）", ""];
  lines.push("已配置的设计模式参考仓库（工具：jdpatterns_catalog / jdpatterns_read / jdpatterns_update，均可带 language 参数）：");
  for (const [lang, entry] of langs) {
    const exts = (GATE_EXT_BY_LANG[lang] || ["." + lang]).join("/");
    const gateNote = cfg.gateEnabled && entry.gate !== false ? `，闸门受控扩展名 ${exts}` : "";
    lines.push(`- ${lang}：${entry.localPath}（索引：${entry.indexFile}${gateNote}）`);
  }
  lines.push("");
  lines.push("规则：");
  lines.push("1. 实现需要设计模式时，先用 jdpatterns_catalog 查候选，再用 jdpatterns_read 阅读参考实现（README+源码含测试）；禁止凭记忆套用模式。");
  lines.push("2. 禁止强行套用：目录中没有合适模式时明确说明即可；允许多模式组合。");
  lines.push("3. 参考仓库可用 jdpatterns_update 更新（git fetch + 按当前分支 ff-only 合并，不改动本地未提交内容）。");
  lines.push("4. 目录由各语言索引文件解析，language 参数选择仓库，缺省 java。");
  if (cfg.gateEnabled) {
    const gated = langs.filter(([, e]) => e.gate !== false);
    if (gated.length > 0) {
      const extList = [...new Set(gated.flatMap(([l]) => GATE_EXT_BY_LANG[l] || ["." + l]))].join(" / ");
      lines.push(`5. 硬闸门（执行层强制）：参考仓库之外写/改受控源码（${extList}，按已配置语言判定）前，本会话必须先成功调用过 jdpatterns_catalog 或 jdpatterns_read，否则写入会被拒绝；这是执行层拦截，无法绕过，先查再写。可在 设置 → 设计模式参考库 按语言开关。`);
    } else {
      lines.push("5. 硬闸门当前对所有语言均已关闭（可在 设置 → 设计模式参考库 打开）；以上为软性引导。");
    }
  } else {
    lines.push("5. 硬闸门当前已全局关闭（可在 设置 → 设计模式参考库 打开）；以上为软性引导。");
  }
  return lines.join("\n");
}

// ---------- 硬闸门（v3：执行层强制，不依赖模型自觉） ----------

function registerGate(ctx, state) {
  // tools/pre-execute（waterfall）：拦截时不调 next()，直接返回 deny。
  const offPre = ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      const cfg = state.config;
      if (!cfg || cfg.gateEnabled === false) return next();
      if (exec.name !== "write" && exec.name !== "edit") return next();
      const agentId = exec.agent && exec.agent.id;
      if (!agentId) return next(); // 无 agent 上下文不拦
      if (state.gatedSessions.has(agentId)) return next();
      const args = exec.arguments && typeof exec.arguments === "object" ? exec.arguments : {};
      const rawPath = typeof args.file_path === "string" ? args.file_path : (typeof args.path === "string" ? args.path : undefined);
      if (!rawPath) return next();
      const hits = matchedGatedLanguages(rawPath, cfg);
      if (hits.length === 0) return next(); // 扩展名不属于任何受控语言
      // 旁路：参考仓库自身路径内写入（fs.resolve + fs.contains）
      let insideReferenceRepo = false;
      try {
        const target = await ctx.fs.resolve(rawPath);
        for (const lang of hits) {
          const entry = cfg.languages[lang];
          if (!entry || !entry.localPath) continue;
          try {
            const root = await ctx.fs.resolve(String(entry.localPath));
            if (ctx.fs.contains(root, target)) { insideReferenceRepo = true; break; }
          } catch { /* 该语言仓库不可解析，跳过 */ }
        }
      } catch { /* 路径不可解析：不拦（fail-open） */ }
      if (insideReferenceRepo) return next();
      const exts = [...new Set(hits.flatMap((l) => GATE_EXT_BY_LANG[l] || ["." + l]))].join("/");
      return { kind: "deny", reason: denyReason(exts) };
    } catch {
      return next(); // fail-open 铁律：闸门自身异常一律放行
    }
  });
  // tools/post-execute（waterfall）：
  // ① catalog 或 read 任一成功即放行（防「无合适模式」死锁）。
  // ② 读时播种（每会话一次）：首次成功读取受控语言源码且尚未查过目录的会话，
  //    注入一条 notice 上下文提醒参考库可用——纯引导，不改控制流；查过/提醒过不再重复。
  const offPost = ctx.on("tools/post-execute", async (exec, result, next) => {
    let extra = null;
    try {
      const agentId = exec.agent && exec.agent.id;
      const ok = result && result.isError === false;
      if (agentId && ok) {
        if (exec.name === "jdpatterns_catalog" || exec.name === "jdpatterns_read") {
          const success = Array.isArray(result.content) && result.content.length > 0
            && !(result.value && typeof result.value === "object" && result.value.error);
          if (success) state.gatedSessions.add(agentId);
        } else if (exec.name === "read" && !state.gatedSessions.has(agentId) && !state.remindedSessions.has(agentId)) {
          const cfg = state.config;
          if (cfg && cfg.gateEnabled !== false) {
            const args = exec.arguments && typeof exec.arguments === "object" ? exec.arguments : {};
            const rawPath = typeof args.file_path === "string" ? args.file_path : undefined;
            if (rawPath && matchedGatedLanguages(rawPath, cfg).length > 0) {
              state.remindedSessions.add(agentId);
              extra = createUserMessage({
                content: [{ type: "text", text: REMINDER_TEXT }],
                source: { kind: "plugin", plugin: "dsh-jdpatterns", form: "notice", summary: "设计模式参考库提醒：实现模式类代码前可先查阅参考实现" },
              });
            }
          }
        }
      }
    } catch { /* 提醒失败静默跳过（fail-open） */ }
    const decision = await next();
    try {
      if (extra && decision && decision.kind === "accept") {
        const merged = Array.isArray(decision.additionalContexts) ? decision.additionalContexts.concat([extra]) : [extra];
        return { kind: "accept", additionalContexts: merged };
      }
    } catch { /* 合并失败按原决策返回 */ }
    return decision;
  });
  return () => { try { offPre(); } catch { /* noop */ } try { offPost(); } catch { /* noop */ } };
}

// ---------- 工具 ----------

function registerTools(ctx, state) {
  const disposers = [];
  disposers.push(ctx.tools.register(defineTool({
    name: "jdpatterns_catalog",
    description: "列出本地设计模式参考仓库中某语言的目录（索引文件解析）：显示名、模块目录名、所属分类。可按分类过滤或关键词搜索。为某语言挑选设计模式时先用本工具查看候选。",
    parameters: {
      language: { type: "string", description: "可选。编程语言标签，默认 java；可用值见设置 → 设计模式参考库。" },
      category: { type: "string", description: "可选。按分类标题过滤，如：创建型" },
      query: { type: "string", description: "可选。关键词（中文或英文），匹配模式名或模块名" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          language: { type: "string" },
          count: { type: "integer" },
          patterns: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, module: { type: "string" }, category: { type: "string" } } } },
        },
      },
      render: (_args, value) => {
        const v = value || { language: "", count: 0, patterns: [] };
        const rows = (v.patterns || []).map((p) => `- [${p.category}] ${p.name}（模块：${p.module}）`);
        return [{ type: "text", text: `语言：${v.language}，共 ${v.count} 个模式\n${rows.join("\n")}` }];
      },
    },
    execute: async (args) => {
      try {
        const lang = args.language || "java";
        let patterns = await getCatalog(state, lang);
        if (args.category) {
          const cat = String(args.category).toLowerCase();
          patterns = patterns.filter((p) => p.category.toLowerCase().includes(cat));
        }
        if (args.query) {
          const q = String(args.query).toLowerCase();
          patterns = patterns.filter((p) => p.name.toLowerCase().includes(q) || p.module.toLowerCase().includes(q));
        }
        return { language: lang, count: patterns.length, patterns: patterns.map((p) => ({ name: p.name, module: p.module, category: p.category })) };
      } catch (err) {
        throw new Error(`jdpatterns_catalog 失败：${err && err.message || err}`);
      }
    },
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "jdpatterns_read",
    description: "阅读本地设计模式参考仓库中某语言某个模式模块的 README 与全部源码（含测试）。挑选或应用模式前必须先用本工具阅读参考实现，禁止凭记忆套用。",
    parameters: {
      module: { type: "string", required: true, description: "模块目录名，如 strategy、abstract-factory，见 jdpatterns_catalog 输出" },
      language: { type: "string", description: "可选。编程语言标签，默认 java。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          language: { type: "string" },
          module: { type: "string" },
          displayName: { type: "string" },
          category: { type: "string" },
          readme: { type: "string" },
          fileCount: { type: "integer" },
          truncated: { type: "boolean" },
          files: { type: "array", items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, content: { type: "string" } } } },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        const parts = [`【${v.category || "?"}】${v.displayName || v.module}（${v.language}，源码文件 ${v.fileCount} 个${v.truncated ? "，已截断" : ""}）`];
        if (v.readme) parts.push("--- README ---\n" + v.readme.slice(0, 6000));
        for (const f of (v.files || []).slice(0, 10)) parts.push(`--- ${f.path} ---\n${f.content}`);
        return [{ type: "text", text: parts.join("\n\n") }];
      },
    },
    execute: async (args) => {
      try {
        const lang = args.language || "java";
        const moduleName = String(args.module || "").replace(/[\\/]+$/, "");
        if (!moduleName) throw new Error("module 参数必填");
        return await readModule(state, lang, moduleName);
      } catch (err) {
        throw new Error(`jdpatterns_read 失败：${err && err.message || err}`);
      }
    },
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "jdpatterns_update",
    description: "更新本地设计模式参考仓库（git fetch + 按当前分支 ff-only 合并 origin/<branch>），随后重新解析目录索引文件。",
    parameters: {
      language: { type: "string", description: "可选。编程语言标签，默认 java。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          language: { type: "string" }, branch: { type: "string" },
          merged: { type: "string" }, patterns: { type: "integer" },
        },
      },
      render: (_args, value) => {
        const v = value || {};
        return [{ type: "text", text: `已更新 ${v.language}（分支 ${v.branch}）：${v.merged || "already up to date"}；目录现含 ${v.patterns} 个模式` }];
      },
    },
    execute: async (args) => {
      try {
        return await updateRepo(state, args.language || "java");
      } catch (err) {
        throw new Error(`jdpatterns_update 失败：${err && err.message || err}`);
      }
    },
  })));
  return () => { for (const dispose of disposers) { try { dispose(); } catch { /* already gone */ } } };
}

// ---------- 入口 ----------

export async function apply(ctx) {
  const state = makeState();
  try {
    state.config = await readConfigFile();
  } catch (err) {
    state.config = structuredClone(DEFAULT_CONFIG);
    state.configError = String(err && err.message || err);
  }
  const disposers = [];
  try {
    disposers.push(ctx.systemPrompt.section({
      name: "dsh-jdpatterns",
      order: 118,
      text: () => { try { return buildPromptSection(state); } catch { return ""; } },
    }));
  } catch (err) { console.error("dsh-jdpatterns: system prompt section failed:", err); }
  try { disposers.push(registerTools(ctx, state)); } catch (err) { console.error("dsh-jdpatterns: tool registration failed:", err); }
  try { disposers.push(registerGate(ctx, state)); } catch (err) { console.error("dsh-jdpatterns: gate registration failed:", err); }
  try { disposers.push(registerRoutes(ctx, state)); } catch (err) { console.error("dsh-jdpatterns: route registration failed:", err); }
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* noop */ } }
  }, "dsh-jdpatterns dispose");
}

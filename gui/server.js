const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");

const root = process.env.PORTABLE_CODEX_ROOT || path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");
const workspaceRoot = path.join(root, "workspaces");
const dataDir = path.join(root, "data");
const codexHome = path.join(dataDir, "codex-home");
const generatedImagesDir = path.join(codexHome, "generated_images");
const artifactsDir = path.join(dataDir, "artifacts");
const uploadsDir = path.join(dataDir, "uploads");
const codexCmd = path.join(root, "tools", "npm-global", "codex.cmd");
const codexJs = path.join(root, "tools", "npm-global", "node_modules", "@openai", "codex", "bin", "codex.js");
const portableCodexExe = path.join(root, "tools", "codex", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
const nodeDir = path.join(root, "tools", "node");
const nodeExe = path.join(nodeDir, "node.exe");
const pythonDir = path.join(root, "tools", "python");
const pythonScriptsDir = path.join(pythonDir, "Scripts");
const npmPrefix = path.join(root, "tools", "npm-global");
const npmCache = path.join(root, "tools", "npm-cache");
const historyFile = path.join(dataDir, "gui-history.json");
const uiLogFile = path.join(dataDir, "gui-ui-log.json");
const stateFile = path.join(dataDir, "gui-state.json");
const updateStatusFile = path.join(dataDir, "update-status.json");
const codexCliUpdateStatusFile = path.join(dataDir, "codex-cli-update-status.json");
const rateLimitCacheMs = 60_000;

const args = process.argv.slice(2);
const portArgIndex = args.indexOf("--port");
const port = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : Number(process.env.PORT || 41731);
const hostArgIndex = args.indexOf("--host");
const host = hostArgIndex >= 0 ? String(args[hostArgIndex + 1] || "127.0.0.1") : String(process.env.HOST || "127.0.0.1");
const lanTokenArgIndex = args.indexOf("--lan-token");
const lanPassword = lanTokenArgIndex >= 0 ? String(args[lanTokenArgIndex + 1] || "") : String(process.env.PORTABLE_CODEX_LAN_TOKEN || "");
const allowLan = host === "0.0.0.0" || host === "::";
const jobs = new Map();
const uiLogClients = new Set();
let rateLimitCache = { at: 0, value: null };
let rateLimitPending = null;

function ensureDirs() {
  for (const dir of [workspaceRoot, codexHome, npmCache, uploadsDir, artifactsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req, maxBytes = 50_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > maxBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function isLocalRequest(req) {
  const remote = req.socket.remoteAddress;
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

function authorizeRequest(req, res, url) {
  if (isLocalRequest(req)) return true;
  if (!allowLan || !lanPassword) return false;
  const password = url.searchParams.get("pass")
    || url.searchParams.get("password")
    || url.searchParams.get("token")
    || req.headers["x-portable-codex-token"]
    || getCookie(req, "portable_codex_lan_password")
    || getCookie(req, "portable_codex_token");
  if (password !== lanPassword) return false;
  res.setHeader("set-cookie", `portable_codex_lan_password=${encodeURIComponent(lanPassword)}; Path=/; SameSite=Lax`);
  return true;
}

function serveLanPasswordPage(res) {
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Portable Codex LAN Login</title>
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111316; color: #f3f1ec; }
    form { width: min(360px, calc(100vw - 32px)); display: grid; gap: 12px; }
    h1 { margin: 0; font-size: 20px; }
    p { margin: 0; color: #aeb4be; }
    input, button { font: inherit; border-radius: 6px; padding: 11px 12px; }
    input { border: 1px solid #343a44; background: #15181d; color: #f3f1ec; }
    button { border: 1px solid #29b39a; background: #29b39a; color: #061311; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <form method="get" action="/">
    <h1>Portable Codex</h1>
    <p>LAN共有パスワードを入力してください。</p>
    <input name="pass" type="password" autocomplete="current-password" autofocus>
    <button type="submit">入る</button>
  </form>
</body>
</html>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  res.end(html);
}

function resolveWorkspace(input) {
  const requested = String(input || workspaceRoot).trim();
  const full = path.resolve(requested || workspaceRoot);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function loadHistory() {
  return loadJson(historyFile, []);
}

function loadUiLog() {
  return loadJson(uiLogFile, []);
}

function saveUiLog(events) {
  saveJson(uiLogFile, events.slice(-400));
}

function pushUiLog(event) {
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type: event.type || "text",
    kind: event.kind || "",
    text: String(event.text || ""),
    image: event.image || null,
    source: String(event.source || ""),
  };
  const events = loadUiLog();
  events.push(entry);
  saveUiLog(events);
  for (const res of uiLogClients) {
    res.write(`event: ui-log\n`);
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  return entry;
}

function clearUiLog() {
  saveUiLog([]);
  for (const res of uiLogClients) {
    res.write(`event: ui-clear\n`);
    res.write(`data: {}\n\n`);
  }
}

function loadState() {
  return loadJson(stateFile, {});
}

function saveState(state) {
  saveJson(stateFile, state);
}

function getWorkspaceStateKey(workspace) {
  return path.resolve(workspace).toLowerCase();
}

function getCurrentSession(workspace) {
  const state = loadState();
  return state.sessions?.[getWorkspaceStateKey(workspace)] || null;
}

function setCurrentSession(workspace, sessionId) {
  if (!sessionId) return;
  const state = loadState();
  state.sessions ||= {};
  state.sessions[getWorkspaceStateKey(workspace)] = {
    id: sessionId,
    workspace,
    updatedAt: new Date().toISOString(),
  };
  saveState(state);
}

function clearCurrentSession(workspace) {
  const state = loadState();
  if (state.sessions) delete state.sessions[getWorkspaceStateKey(workspace)];
  saveState(state);
}

function clearAllSessions() {
  const state = loadState();
  state.sessions = {};
  saveState(state);
}

function appendHistory(entry) {
  const history = loadHistory();
  history.unshift(entry);
  saveJson(historyFile, history.slice(0, 80));
}

function formatHistoryText() {
  const history = loadHistory();
  if (!history.length) return "No history yet.\n";

  return history.map((item, index) => {
    const lines = [
      `#${index + 1} ${item.at || ""}`,
      `workspace: ${item.workspace || ""}`,
      `permission: ${item.permission || ""}`,
      `session: ${item.sessionId || ""}`,
      `mode: ${item.isResume ? "resume" : "new"}`,
      "",
      String(item.prompt || "").trim(),
    ];
    return lines.join("\n").trimEnd();
  }).join("\n\n" + "-".repeat(72) + "\n\n") + "\n";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(size) {
  const value = Number(size || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function listWorkspaces() {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return fs.readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => path.join(workspaceRoot, item.name));
}

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const artifactExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
  ".pdf", ".html", ".htm", ".md", ".txt", ".csv", ".json",
  ".docx", ".xlsx", ".pptx", ".zip", ".ps1",
]);
const ignoredArtifactDirs = new Set([".git", "node_modules", ".tmp", "dist", "usb", "tools"]);

function walkFiles(dir, allowedExtensions) {
  if (!fs.existsSync(dir)) return [];
  function walk(dir) {
    const entries = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (ignoredArtifactDirs.has(item.name)) continue;
        entries.push(...walk(filePath));
      } else if (item.isFile() && allowedExtensions.has(path.extname(item.name).toLowerCase())) {
        entries.push(filePath);
      }
    }
    return entries;
  }
  return walk(dir);
}

function toListedFile(filePath, baseDir, urlPrefix, sourceLabel) {
  const relativeName = path.relative(baseDir, filePath).replaceAll("\\", "/");
  const stat = fs.statSync(filePath);
  return {
    name: `${sourceLabel}/${relativeName}`,
    url: `${urlPrefix}/${relativeName.split("/").map(encodeURIComponent).join("/")}`,
    path: filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function listGeneratedImages() {
  return [
    ...walkFiles(artifactsDir, imageExtensions)
      .map((filePath) => toListedFile(filePath, artifactsDir, "/api/artifacts", "artifacts")),
    ...walkFiles(generatedImagesDir, imageExtensions)
      .map((filePath) => toListedFile(filePath, generatedImagesDir, "/api/generated-images", "generated_images")),
  ]
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listArtifacts() {
  return walkFiles(artifactsDir, artifactExtensions)
    .map((filePath) => toListedFile(filePath, artifactsDir, "/api/artifacts", "artifacts"))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listUploads() {
  return walkFiles(uploadsDir, artifactExtensions)
    .map((filePath) => toListedFile(filePath, uploadsDir, "/api/uploads-file", "uploads"))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function snapshotArtifacts(workspace) {
  const snapshot = new Map();
  for (const dir of [workspace, generatedImagesDir]) {
    for (const filePath of walkFiles(dir, artifactExtensions)) {
      const resolved = path.resolve(filePath);
      if (resolved.startsWith(path.resolve(artifactsDir))) continue;
      const stat = fs.statSync(filePath);
      snapshot.set(resolved.toLowerCase(), `${stat.mtimeMs}:${stat.size}`);
    }
  }
  return snapshot;
}

function uniqueArtifactPath(targetDir, originalName) {
  const parsed = path.parse(sanitizeFileName(originalName));
  let filePath = path.join(targetDir, `${parsed.name}${parsed.ext}`);
  let index = 2;
  while (fs.existsSync(filePath)) {
    filePath = path.join(targetDir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return filePath;
}

function collectArtifacts(job) {
  const batch = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = path.join(artifactsDir, `${batch}-${job.id.slice(0, 8)}`);
  const copied = [];
  const baseline = job.artifactBaseline || new Map();

  for (const dir of [job.workspace, generatedImagesDir]) {
    for (const filePath of walkFiles(dir, artifactExtensions)) {
      const resolved = path.resolve(filePath);
      if (resolved.startsWith(path.resolve(artifactsDir))) continue;
      const stat = fs.statSync(filePath);
      const key = resolved.toLowerCase();
      const fingerprint = `${stat.mtimeMs}:${stat.size}`;
      if (baseline.get(key) === fingerprint) continue;
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = uniqueArtifactPath(targetDir, path.basename(filePath));
      fs.copyFileSync(filePath, targetPath);
      copied.push({
        source: filePath,
        path: targetPath,
        name: path.relative(artifactsDir, targetPath).replaceAll("\\", "/"),
        size: stat.size,
        mtimeMs: fs.statSync(targetPath).mtimeMs,
        image: imageExtensions.has(path.extname(targetPath).toLowerCase()),
        url: `/api/artifacts/${path.relative(artifactsDir, targetPath).replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}`,
      });
    }
  }

  if (copied.length) {
    saveJson(path.join(targetDir, "_sources.json"), copied.map((item) => ({
      name: item.name,
      source: item.source,
      size: item.size,
    })));
  }
  return copied.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || "upload.bin"));
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 120) || "upload.bin";
}

function isImageMime(type, fileName) {
  const mime = String(type || "").toLowerCase();
  const ext = path.extname(String(fileName || "")).toLowerCase();
  return mime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
}

function saveUploads(files, workspaceInput) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = path.join(uploadsDir, stamp);
  const workspace = resolveWorkspace(workspaceInput);
  const batchDir = path.join(workspace, ".codex-attachments", stamp);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(batchDir, { recursive: true });

  return files.map((file, index) => {
    const name = sanitizeFileName(file.name || `upload-${index + 1}`);
    const match = String(file.data || "").match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error(`Invalid upload data for ${name}.`);
    const mime = file.type || match[1];
    const bytes = Buffer.from(match[2], "base64");
    const filePath = path.join(batchDir, name);
    const archivePath = path.join(archiveDir, name);
    fs.writeFileSync(filePath, bytes);
    fs.writeFileSync(archivePath, bytes);
    return {
      name,
      path: filePath,
      archivePath,
      type: mime,
      size: bytes.length,
      image: isImageMime(mime, name),
    };
  });
}

function buildPrompt(input, includeBaseInstruction) {
  const base = String(input.prompt || "").trim();
  const prefix = [];

  if (includeBaseInstruction && input.japanese !== false) {
    prefix.push("以後の回答はすべて日本語で返してください。コマンド出力やファイル名などの固有名は必要に応じて原文のまま残してください。");
  }
  if (includeBaseInstruction && input.autonomous === true) {
    prefix.push("可能な限り自律的に作業を進め、実装、検証、結果報告まで行ってください。重大な破壊的操作や認証情報が必要な場合だけ確認してください。");
  }
  if (includeBaseInstruction && input.extraInstruction) {
    prefix.push(String(input.extraInstruction).trim());
  }

  const uploads = Array.isArray(input.uploads) ? input.uploads : [];
  const imageNotes = uploads
    .filter((file) => file.image)
    .map((file) => `- ${file.name}: ${file.path}`);
  const fileNotes = uploads
    .filter((file) => !file.image)
    .map((file) => `- ${file.name}: ${file.path}`);
  if (imageNotes.length) {
    prefix.push(`添付画像・スクリーンショット:\n${imageNotes.join("\n")}`);
  }
  if (fileNotes.length) {
    prefix.push(`添付ファイル:\n${fileNotes.join("\n")}`);
  }

  return [...prefix, base].filter(Boolean).join("\n\n");
}

function addSharedCodexOptions(codexArgs, input) {
  const model = String(input.model || "").trim();
  const permission = String(input.permission || "workspace-write");
  if (model) codexArgs.push("--model", model);
  return permission;
}

function getCodexRunnerForAppServer() {
  if (fs.existsSync(portableCodexExe)) {
    return { command: portableCodexExe, args: ["app-server", "--listen", "stdio://"] };
  }
  if (fs.existsSync(codexJs) && fs.existsSync(nodeExe)) {
    return { command: nodeExe, args: [codexJs, "app-server", "--listen", "stdio://"] };
  }
  return null;
}

function getPortableEnv() {
  const env = buildPortableEnv();
  return env;
}

function readCodexRateLimits() {
  const runner = getCodexRunnerForAppServer();
  if (!runner) {
    return Promise.resolve({ ok: false, error: "Codex CLI is not installed.", rateLimits: null });
  }

  return new Promise((resolve) => {
    const child = spawn(runner.command, runner.args, {
      cwd: root,
      env: getPortableEnv(),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    }

    function send(payload) {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    const timer = setTimeout(() => {
      finish({ ok: false, error: "Timed out while reading Codex rate limits.", rateLimits: null });
    }, 12_000);

    child.on("error", (error) => {
      finish({ ok: false, error: error.message, rateLimits: null });
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2) {
          if (message.result) {
            finish({ ok: true, error: null, rateLimits: message.result, fetchedAt: new Date().toISOString() });
          } else {
            finish({ ok: false, error: message.error?.message || "Failed to read Codex rate limits.", rateLimits: null });
          }
        }
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "portable-codex-gui", title: "Portable Codex GUI", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
      },
    });
  });
}

async function getCachedRateLimits(force = false) {
  const now = Date.now();
  if (!force && rateLimitCache.value && now - rateLimitCache.at < rateLimitCacheMs) {
    return rateLimitCache.value;
  }
  if (!rateLimitPending) {
    rateLimitPending = readCodexRateLimits()
      .then((value) => {
        rateLimitCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        rateLimitPending = null;
      });
  }
  return rateLimitPending;
}

function buildPortableEnv() {
  const pythonInstalled = fs.existsSync(path.join(pythonDir, "python.exe"));
  const portablePaths = pythonInstalled
    ? [nodeDir, npmPrefix, pythonDir, pythonScriptsDir]
    : [nodeDir, npmPrefix];
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    npm_config_prefix: npmPrefix,
    npm_config_cache: npmCache,
    Path: [...portablePaths, process.env.Path || ""].filter(Boolean).join(";"),
  };
  if (pythonInstalled) env.PYTHONHOME = pythonDir;
  return env;
}

function buildCodexArgs(input, workspace, prompt, session) {
  const isResume = Boolean(session?.id && input.resume !== false);
  const codexArgs = isResume
    ? ["exec", "resume"]
    : ["exec", "--cd", workspace, "--skip-git-repo-check", "--color", "never"];
  const permission = addSharedCodexOptions(codexArgs, input);

  if (isResume) codexArgs.push("--skip-git-repo-check");

  if (!isResume && permission === "read-only") {
    codexArgs.push("--sandbox", "read-only");
  } else if (!isResume && permission === "workspace-write") {
    codexArgs.push("--sandbox", "workspace-write");
  } else if (!isResume && permission === "danger-full-access") {
    codexArgs.push("--sandbox", "danger-full-access");
  } else if (permission === "bypass") {
    codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
  }

  const imageUploads = Array.isArray(input.uploads) ? input.uploads.filter((file) => file.image) : [];
  for (const image of imageUploads) {
    codexArgs.push("-i", image.path);
  }

  if (isResume) codexArgs.push(session.id);
  codexArgs.push(prompt);
  return { codexArgs, isResume };
}

function push(job, type, data) {
  job.nextEventId ||= 1;
  const event = { id: job.nextEventId++, type, data, at: new Date().toISOString() };
  job.events.push(event);
  for (const res of job.clients) {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function summarizeJob(job) {
  if (!job) return null;
  const exitEvent = [...job.events].reverse().find((event) => event.type === "exit");
  const artifactEvents = job.events.filter((event) => event.type === "artifacts").flatMap((event) => event.data || []);
  return {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    workspace: job.workspace,
    permission: job.permission,
    sessionId: job.sessionId,
    isResume: job.isResume,
    commandPreview: job.commandPreview,
    exit: exitEvent?.data || null,
    artifacts: artifactEvents,
    events: job.events,
  };
}

function buildAgentHelp() {
  return {
    name: "Portable Codex Agent API",
    version: "1",
    base: "/api/agent",
    notes: [
      "Use this API from local/LAN automation instead of clicking the GUI.",
      "LAN mode uses the same password cookie as the web UI.",
      "Jobs can be monitored by polling /jobs/{id} or streaming /jobs/{id}/events.",
    ],
    endpoints: {
      "GET /api/agent": "API description and endpoint list.",
      "GET /api/agent/status": "Portable GUI/Codex status, artifacts, uploads, UI log summary.",
      "POST /api/agent/run": "Start Codex. Body accepts prompt, workspace, model, permission, resume, japanese, autonomous, extraInstruction, uploads, newSession.",
      "GET /api/agent/jobs/{id}": "Read job status and accumulated events.",
      "GET /api/agent/jobs/{id}/events": "Server-sent events for the job.",
      "POST /api/agent/jobs/{id}/stop": "Stop a running job.",
      "GET /api/agent/files/artifacts": "List generated artifacts.",
      "GET /api/agent/files/images": "List generated images.",
      "GET /api/agent/files/uploads": "List uploaded files.",
      "POST /api/agent/ui-log": "Append a synced UI log item. Body accepts type, kind, text, image, source.",
      "POST /api/agent/ui-log/clear": "Clear synced UI log.",
    },
    examples: {
      run: {
        method: "POST",
        url: "/api/agent/run",
        body: {
          prompt: "このフォルダを調査して要点をまとめて",
          permission: "workspace-write",
          resume: true,
        },
      },
      poll: {
        method: "GET",
        url: "/api/agent/jobs/<id>",
      },
    },
  };
}

function stopJob(job) {
  if (!job || !job.child || job.status !== "running") return;
  job.status = "stopping";
  push(job, "stop", { status: "stopping" });
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(job.child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    job.child.kill("SIGTERM");
  }
}

function startJob(input) {
  const usePortableExe = fs.existsSync(portableCodexExe);
  if (!usePortableExe && (!fs.existsSync(codexJs) || !fs.existsSync(nodeExe))) {
    throw new Error("Codex CLIが見つかりません。先に Install-UsbCodex.ps1 を実行してください。");
  }

  const id = crypto.randomUUID();
  const workspace = resolveWorkspace(input.workspace);
  if (input.newSession === true) clearCurrentSession(workspace);
  const session = input.newSession === true ? null : getCurrentSession(workspace);
  const includeBaseInstruction = !(session?.id && input.resume !== false);
  const prompt = buildPrompt(input, includeBaseInstruction);
  if (!prompt) throw new Error("プロンプトが空です。");

  const { codexArgs, isResume } = buildCodexArgs(input, workspace, prompt, session);
  const job = {
    id,
    clients: new Set(),
    events: [],
    startedAt: new Date().toISOString(),
    status: "running",
    workspace,
    permission: input.permission || "workspace-write",
    prompt,
    sessionId: session?.id || null,
    isResume,
    artifactBaseline: snapshotArtifacts(workspace),
    commandPreview: ["codex.cmd", ...codexArgs.slice(0, -1), "<prompt>"].join(" "),
    child: null,
  };
  jobs.set(id, job);

  const pythonInstalled = fs.existsSync(path.join(pythonDir, "python.exe"));
  const portablePaths = pythonInstalled
    ? [nodeDir, npmPrefix, pythonDir, pythonScriptsDir]
    : [nodeDir, npmPrefix];
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    npm_config_prefix: npmPrefix,
    npm_config_cache: npmCache,
    Path: [...portablePaths, process.env.Path || ""].filter(Boolean).join(";"),
  };
  if (pythonInstalled) env.PYTHONHOME = pythonDir;

  appendHistory({
    id,
    at: job.startedAt,
    workspace,
    permission: job.permission,
    sessionId: job.sessionId,
    isResume: job.isResume,
    prompt: prompt.slice(0, 600),
  });

  const child = usePortableExe
    ? spawn(portableCodexExe, codexArgs, {
      cwd: workspace,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    : spawn(nodeExe, [codexJs, ...codexArgs], {
    cwd: workspace,
    env,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;

  push(job, "meta", {
    id,
    workspace,
    permission: job.permission,
    sessionId: job.sessionId,
    isResume: job.isResume,
    command: job.commandPreview,
  });

  function handleChunk(type, chunk) {
    const text = chunk.toString();
    const match = text.match(/session id:\s*([0-9a-fA-F-]{36})/);
    if (match) {
      job.sessionId = match[1];
      setCurrentSession(workspace, job.sessionId);
      push(job, "session", { id: job.sessionId, workspace });
    }
    push(job, type, text);
  }

  child.stdout.on("data", (chunk) => handleChunk("stdout", chunk));
  child.stderr.on("data", (chunk) => handleChunk("stderr", chunk));
  child.on("error", (error) => {
    job.status = "error";
    push(job, "error", error.message);
  });
  child.on("close", (code, signal) => {
    job.status = job.status === "stopping" ? "stopped" : (code === 0 ? "done" : "failed");
    const artifacts = collectArtifacts(job);
    if (artifacts.length) push(job, "artifacts", artifacts);
    push(job, "exit", { code, signal, status: job.status });
    for (const res of job.clients) res.end();
    job.clients.clear();
  });

  return job;
}

function openCodexLoginShell() {
  const loginBat = path.join(root, "Login-Codex.bat");
  const env = buildPortableEnv();
  const child = spawn("cmd.exe", ["/c", "start", "", loginBat], {
    cwd: root,
    env,
    windowsHide: false,
    stdio: "ignore",
  });
  child.unref();
}

function runCodexLogout() {
  const env = buildPortableEnv();
  let result;
  if (fs.existsSync(portableCodexExe)) {
    result = spawnSync(portableCodexExe, ["logout"], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
    });
  } else if (fs.existsSync(codexCmd)) {
    result = spawnSync("cmd.exe", ["/c", codexCmd, "logout"], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
    });
  } else {
    throw new Error("Codex CLIが見つかりません。ログアウトできませんでした。");
  }

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(message || "Codex CLIのログアウトに失敗しました。");
  }

  rateLimitCache = { at: 0, value: null };
  clearAllSessions();
}

function openFolder(target) {
  const known = {
    artifacts: artifactsDir,
    generatedImages: generatedImagesDir,
    uploads: uploadsDir,
    workspaces: workspaceRoot,
  };
  const folder = known[target];
  if (!folder) throw new Error("Unknown folder target.");
  fs.mkdirSync(folder, { recursive: true });
  const resolvedRoot = path.resolve(root);
  const resolvedFolder = path.resolve(folder);
  if (!resolvedFolder.startsWith(resolvedRoot)) {
    throw new Error("Refusing to open a folder outside portable root.");
  }
  const child = spawn("explorer.exe", [resolvedFolder], {
    windowsHide: false,
    stdio: "ignore",
  });
  child.unref();
}

function openExternalUrl(target) {
  const known = {
    analytics: "https://chatgpt.com/codex/cloud/settings/analytics",
  };
  const url = known[target];
  if (!url) throw new Error("Unknown URL target.");
  const child = spawn("cmd.exe", ["/c", "start", "", url], {
    windowsHide: false,
    stdio: "ignore",
  });
  child.unref();
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(publicDir, `.${pathname}`);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  });
}

function serveGeneratedImage(req, res, name) {
  serveFileFromDir(req, res, generatedImagesDir, name);
}

function serveArtifact(req, res, name) {
  serveFileFromDir(req, res, artifactsDir, name);
}

function serveUploadFile(req, res, name) {
  serveFileFromDir(req, res, uploadsDir, name);
}

function getBrowserFiles(target) {
  if (target === "artifacts") {
    return { title: "成果物", files: listArtifacts() };
  }
  if (target === "generatedImages") {
    return { title: "画像", files: listGeneratedImages() };
  }
  if (target === "uploads") {
    return { title: "添付", files: listUploads() };
  }
  return null;
}

function serveFileBrowser(res, target) {
  const data = getBrowserFiles(target);
  if (!data) {
    sendJson(res, 404, { error: "Unknown browser target." });
    return;
  }

  const items = data.files.map((file) => {
    const ext = path.extname(file.name).toLowerCase();
    const isImage = imageExtensions.has(ext);
    const modified = new Date(file.mtimeMs).toLocaleString("ja-JP", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const preview = isImage
      ? `<a class="thumb" href="${file.url}" target="_blank" rel="noreferrer"><img src="${file.url}" alt=""></a>`
      : `<a class="icon" href="${file.url}" target="_blank" rel="noreferrer">file</a>`;
    return `<article>
      ${preview}
      <div>
        <a class="name" href="${file.url}" target="_blank" rel="noreferrer">${escapeHtml(file.name)}</a>
        <p>${formatBytes(file.size)} / ${escapeHtml(modified)}</p>
      </div>
    </article>`;
  }).join("");

  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Portable Codex ${escapeHtml(data.title)}</title>
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; background: #111316; color: #f3f1ec; }
    main { width: min(1100px, calc(100vw - 28px)); margin: 0 auto; padding: 18px 0 32px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    h1 { margin: 0; font-size: 20px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; }
    nav a { color: #e6bb55; text-decoration: none; border: 1px solid #343a44; padding: 6px 9px; border-radius: 6px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
    article { min-width: 0; display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; align-items: center; border: 1px solid #343a44; background: #1a1d22; border-radius: 8px; padding: 10px; }
    .thumb, .icon { width: 76px; height: 58px; display: grid; place-items: center; border: 1px solid #343a44; border-radius: 6px; background: #090b0d; color: #aeb4be; text-decoration: none; overflow: hidden; }
    img { width: 100%; height: 100%; object-fit: contain; }
    .name { color: #f3f1ec; text-decoration: none; overflow-wrap: anywhere; }
    p { margin: 5px 0 0; color: #aeb4be; font-size: 12px; }
    .empty { color: #aeb4be; border: 1px solid #343a44; padding: 18px; border-radius: 8px; background: #1a1d22; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(data.title)}</h1>
      <nav>
        <a href="/browse/artifacts">成果物</a>
        <a href="/browse/generatedImages">画像</a>
        <a href="/browse/uploads">添付</a>
        <a href="/">チャット</a>
      </nav>
    </header>
    ${data.files.length ? `<section class="grid">${items}</section>` : `<div class="empty">まだファイルはありません。</div>`}
  </main>
</body>
</html>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  res.end(html);
}

function serveFileFromDir(req, res, baseDir, name) {
  const decoded = decodeURIComponent(name || "");
  if (!decoded || decoded.includes("..")) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  const filePath = path.join(baseDir, decoded);
  const resolvedDir = path.resolve(baseDir);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedDir) || !fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(resolvedFile).toLowerCase();
  const type = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  }[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  fs.createReadStream(resolvedFile).pipe(res);
}

ensureDirs();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!authorizeRequest(req, res, url)) {
    if (allowLan && !isLocalRequest(req) && req.method === "GET") {
      serveLanPasswordPage(res);
      return;
    }
    sendJson(res, 403, { error: "LAN access requires a valid password." });
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, {
        root,
        workspaceRoot,
        codexHome,
        codexInstalled: fs.existsSync(codexCmd) || fs.existsSync(portableCodexExe),
        workspaces: listWorkspaces(),
        generatedImages: listGeneratedImages(),
        artifacts: listArtifacts(),
        history: loadHistory(),
        state: loadState(),
        updateStatus: loadJson(updateStatusFile, null),
        codexCliUpdateStatus: loadJson(codexCliUpdateStatusFile, null),
        rateLimits: rateLimitCache.value,
        auth: {
          checked: Boolean(rateLimitCache.value),
          loggedIn: rateLimitCache.value?.ok === true,
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/rate-limits") {
      sendJson(res, 200, await getCachedRateLimits(url.searchParams.get("refresh") === "1"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent") {
      sendJson(res, 200, buildAgentHelp());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/status") {
      const includeFiles = url.searchParams.get("includeFiles") === "1";
      sendJson(res, 200, {
        ok: true,
        root,
        workspaceRoot,
        codexHome,
        codexInstalled: fs.existsSync(codexCmd) || fs.existsSync(portableCodexExe),
        runningJobs: [...jobs.values()].filter((job) => job.status === "running").map(summarizeJob),
        artifacts: includeFiles ? listArtifacts() : undefined,
        images: includeFiles ? listGeneratedImages() : undefined,
        uploads: includeFiles ? listUploads() : undefined,
        uiLogCount: loadUiLog().length,
        updateStatus: loadJson(updateStatusFile, null),
        codexCliUpdateStatus: loadJson(codexCliUpdateStatusFile, null),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/run") {
      const input = JSON.parse(await readBody(req));
      const job = startJob(input);
      sendJson(res, 200, {
        ok: true,
        id: job.id,
        job: summarizeJob(job),
        statusUrl: `/api/agent/jobs/${job.id}`,
        eventsUrl: `/api/agent/jobs/${job.id}/events`,
        stopUrl: `/api/agent/jobs/${job.id}/stop`,
      });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/agent/jobs/") && url.pathname.endsWith("/events")) {
      const id = url.pathname.split("/")[4];
      const job = jobs.get(id);
      if (!job) {
        sendJson(res, 404, { error: "Job not found." });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      for (const event of job.events) {
        res.write(`id: ${event.id}\n`);
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      }
      if (job.status === "running") {
        job.clients.add(res);
        req.on("close", () => job.clients.delete(res));
      } else {
        res.end();
      }
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/agent/jobs/")) {
      const id = url.pathname.split("/")[4];
      const job = jobs.get(id);
      if (!job) {
        sendJson(res, 404, { error: "Job not found." });
        return;
      }
      sendJson(res, 200, { ok: true, job: summarizeJob(job) });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/agent/jobs/") && url.pathname.endsWith("/stop")) {
      const id = url.pathname.split("/")[4];
      const job = jobs.get(id);
      if (!job || !job.child) {
        sendJson(res, 404, { error: "Job not found." });
        return;
      }
      stopJob(job);
      sendJson(res, 200, { ok: true, job: summarizeJob(job) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/files/artifacts") {
      sendJson(res, 200, { ok: true, files: listArtifacts(), browseUrl: "/browse/artifacts" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/files/images") {
      sendJson(res, 200, { ok: true, files: listGeneratedImages(), browseUrl: "/browse/generatedImages" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/files/uploads") {
      sendJson(res, 200, { ok: true, files: listUploads(), browseUrl: "/browse/uploads" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/ui-log") {
      const input = JSON.parse(await readBody(req));
      sendJson(res, 200, { ok: true, event: pushUiLog(input) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/ui-log/clear") {
      clearUiLog();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/history.txt") {
      const text = formatHistoryText();
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(text),
        "cache-control": "no-store",
      });
      res.end(text);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ui-log") {
      sendJson(res, 200, { events: loadUiLog() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ui-log") {
      const input = JSON.parse(await readBody(req));
      sendJson(res, 200, { event: pushUiLog(input) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ui-log/clear") {
      clearUiLog();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ui-log/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      uiLogClients.add(res);
      req.on("close", () => uiLogClients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/uploads") {
      const input = JSON.parse(await readBody(req));
      const files = Array.isArray(input.files) ? input.files : [];
      sendJson(res, 200, { uploads: saveUploads(files, input.workspace) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/generated-images") {
      sendJson(res, 200, { images: listGeneratedImages() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/artifacts") {
      sendJson(res, 200, { artifacts: listArtifacts() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/uploads-list") {
      sendJson(res, 200, { uploads: listUploads() });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/browse/")) {
      serveFileBrowser(res, url.pathname.slice("/browse/".length));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/generated-images/")) {
      serveGeneratedImage(req, res, url.pathname.slice("/api/generated-images/".length));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
      serveArtifact(req, res, url.pathname.slice("/api/artifacts/".length));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/uploads-file/")) {
      serveUploadFile(req, res, url.pathname.slice("/api/uploads-file/".length));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session/clear") {
      const input = JSON.parse(await readBody(req));
      clearCurrentSession(resolveWorkspace(input.workspace));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const input = JSON.parse(await readBody(req));
      const job = startJob(input);
      sendJson(res, 200, { id: job.id });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      openCodexLoginShell();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      runCodexLogout();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/open-folder") {
      const input = JSON.parse(await readBody(req));
      openFolder(input.target);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/open-url") {
      const input = JSON.parse(await readBody(req));
      openExternalUrl(input.target);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/stop")) {
      const id = url.pathname.split("/")[3];
      const job = jobs.get(id);
      if (!job || !job.child) {
        sendJson(res, 404, { error: "Job not found." });
        return;
      }
      stopJob(job);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/events")) {
      const id = url.pathname.split("/")[3];
      const job = jobs.get(id);
      if (!job) {
        res.writeHead(404);
        res.end("Job not found");
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      for (const event of job.events) {
        res.write(`id: ${event.id}\n`);
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      }
      if (job.status === "running") {
        job.clients.add(res);
        req.on("close", () => job.clients.delete(res));
      } else {
        res.end();
      }
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  const shownHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`Portable Codex GUI listening on http://${shownHost}:${port}`);
  if (allowLan) {
    console.log("LAN sharing is enabled. Use the share URL and password printed by Start-CodexGui.ps1.");
  }
});

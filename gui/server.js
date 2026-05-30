const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");

const root = process.env.PORTABLE_CODEX_ROOT || path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");
const workspaceRoot = path.join(root, "workspaces");
const codexHome = path.join(root, "data", "codex-home");
const generatedImagesDir = path.join(codexHome, "generated_images");
const codexCmd = path.join(root, "tools", "npm-global", "codex.cmd");
const codexJs = path.join(root, "tools", "npm-global", "node_modules", "@openai", "codex", "bin", "codex.js");
const nodeDir = path.join(root, "tools", "node");
const nodeExe = path.join(nodeDir, "node.exe");
const npmPrefix = path.join(root, "tools", "npm-global");
const npmCache = path.join(root, "tools", "npm-cache");
const historyFile = path.join(root, "data", "gui-history.json");
const stateFile = path.join(root, "data", "gui-state.json");

const args = process.argv.slice(2);
const portArgIndex = args.indexOf("--port");
const port = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : Number(process.env.PORT || 41731);

const jobs = new Map();

function ensureDirs() {
  for (const dir of [workspaceRoot, codexHome, npmCache, path.dirname(historyFile)]) {
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
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

function resolveWorkspace(input) {
  const requested = String(input || workspaceRoot).trim();
  const full = path.resolve(requested || workspaceRoot);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(historyFile, "utf8"));
  } catch {
    return [];
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
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
  if (state.sessions) {
    delete state.sessions[getWorkspaceStateKey(workspace)];
  }
  saveState(state);
}

function appendHistory(entry) {
  const history = loadHistory();
  history.unshift(entry);
  fs.writeFileSync(historyFile, JSON.stringify(history.slice(0, 80), null, 2), "utf8");
}

function listWorkspaces() {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return fs.readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => path.join(workspaceRoot, item.name));
}

function listGeneratedImages() {
  if (!fs.existsSync(generatedImagesDir)) return [];

  const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
  return fs.readdirSync(generatedImagesDir, { withFileTypes: true })
    .filter((item) => item.isFile() && allowed.has(path.extname(item.name).toLowerCase()))
    .map((item) => {
      const filePath = path.join(generatedImagesDir, item.name);
      const stat = fs.statSync(filePath);
      return {
        name: item.name,
        url: `/api/generated-images/${encodeURIComponent(item.name)}`,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function buildPrompt(input, includeBaseInstruction) {
  const base = String(input.prompt || "").trim();
  const japanese = input.japanese !== false;
  const noQuestions = input.autonomous === true;
  const prefix = [];

  if (includeBaseInstruction && japanese) {
    prefix.push("以後の回答はすべて日本語で返してください。コマンド出力やファイル名などの固有名は必要に応じて原文のまま残してください。");
  }
  if (includeBaseInstruction && noQuestions) {
    prefix.push("可能な限り自律的に作業を進め、実装、検証、結果報告まで行ってください。重大な破壊的操作や認証情報が必要な場合だけ確認してください。");
  }
  if (includeBaseInstruction && input.extraInstruction) {
    prefix.push(String(input.extraInstruction).trim());
  }

  return [...prefix, base].filter(Boolean).join("\n\n");
}

function addSharedCodexOptions(codexArgs, input) {
  const model = String(input.model || "").trim();
  const permission = String(input.permission || "workspace-write");

  if (model) {
    codexArgs.push("--model", model);
  }

  return permission;
}

function buildCodexArgs(input, workspace, prompt, session) {
  const isResume = Boolean(session?.id && input.resume !== false);
  const codexArgs = isResume
    ? ["exec", "resume"]
    : ["exec", "--cd", workspace, "--skip-git-repo-check", "--color", "never"];
  const permission = addSharedCodexOptions(codexArgs, input);

  if (isResume) {
    codexArgs.push("--skip-git-repo-check");
  }

  if (!isResume && permission === "read-only") {
    codexArgs.push("--sandbox", "read-only");
  } else if (!isResume && permission === "workspace-write") {
    codexArgs.push("--sandbox", "workspace-write");
  } else if (!isResume && permission === "danger-full-access") {
    codexArgs.push("--sandbox", "danger-full-access");
  } else if (permission === "bypass") {
    codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
  }

  if (isResume) {
    codexArgs.push(session.id);
  }
  codexArgs.push(prompt);
  return { codexArgs, isResume };
}

function push(job, type, data) {
  const event = {
    type,
    data,
    at: new Date().toISOString(),
  };
  job.events.push(event);
  for (const res of job.clients) {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function stopJob(job) {
  if (!job || !job.child || job.status !== "running") return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(job.child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    job.child.kill("SIGTERM");
  }
}

function startJob(input) {
  if (!fs.existsSync(codexJs) || !fs.existsSync(nodeExe)) {
    throw new Error("codex.cmd が見つかりません。先に Install-UsbCodex.ps1 を実行してください。");
  }

  const id = crypto.randomUUID();
  const workspace = resolveWorkspace(input.workspace);
  if (input.newSession === true) {
    clearCurrentSession(workspace);
  }
  const session = input.newSession === true ? null : getCurrentSession(workspace);
  const includeBaseInstruction = !(session?.id && input.resume !== false);
  const prompt = buildPrompt(input, includeBaseInstruction);
  if (!prompt) {
    throw new Error("プロンプトが空です。");
  }

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
    commandPreview: ["codex.cmd", ...codexArgs.slice(0, -1), "<prompt>"].join(" "),
    child: null,
  };
  jobs.set(id, job);

  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    npm_config_prefix: npmPrefix,
    npm_config_cache: npmCache,
    Path: [nodeDir, npmPrefix, process.env.Path || ""].filter(Boolean).join(";"),
  };

  appendHistory({
    id,
    at: job.startedAt,
    workspace,
    permission: job.permission,
    sessionId: job.sessionId,
    isResume: job.isResume,
    prompt: prompt.slice(0, 600),
  });

  const child = spawn(nodeExe, [codexJs, ...codexArgs], {
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
    job.status = code === 0 ? "done" : "failed";
    push(job, "exit", { code, signal, status: job.status });
    for (const res of job.clients) {
      res.end();
    }
    job.clients.clear();
  });

  return job;
}

function openCodexLoginShell() {
  const loginBat = path.join(root, "Login-Codex.bat");
  const child = spawn("cmd.exe", ["/c", "start", "", loginBat], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      npm_config_prefix: npmPrefix,
      npm_config_cache: npmCache,
      Path: [nodeDir, npmPrefix, process.env.Path || ""].filter(Boolean).join(";"),
    },
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
  const decoded = decodeURIComponent(name || "");
  const base = path.basename(decoded);
  if (base !== decoded) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  const filePath = path.join(generatedImagesDir, base);
  const resolvedDir = path.resolve(generatedImagesDir);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedDir) || !fs.existsSync(resolvedFile)) {
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
  }[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  fs.createReadStream(resolvedFile).pipe(res);
}

ensureDirs();

const server = http.createServer(async (req, res) => {
  if (!isLocalRequest(req)) {
    sendJson(res, 403, { error: "Localhost only." });
    return;
  }

  const url = new URL(req.url, "http://127.0.0.1");

  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, {
        root,
        workspaceRoot,
        codexHome,
        codexInstalled: fs.existsSync(codexCmd),
        workspaces: listWorkspaces(),
        generatedImages: listGeneratedImages(),
        history: loadHistory(),
        state: loadState(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/generated-images") {
      sendJson(res, 200, { images: listGeneratedImages() });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/generated-images/")) {
      serveGeneratedImage(req, res, url.pathname.slice("/api/generated-images/".length));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session/clear") {
      const input = JSON.parse(await readBody(req));
      const workspace = resolveWorkspace(input.workspace);
      clearCurrentSession(workspace);
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

server.listen(port, "127.0.0.1", () => {
  console.log(`Portable Codex GUI listening on http://127.0.0.1:${port}`);
});

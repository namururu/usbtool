const el = {
  codexState: document.querySelector("#codexState"),
  codexHome: document.querySelector("#codexHome"),
  rootPath: document.querySelector("#rootPath"),
  history: document.querySelector("#history"),
  workspace: document.querySelector("#workspace"),
  model: document.querySelector("#model"),
  permission: document.querySelector("#permission"),
  resume: document.querySelector("#resume"),
  japanese: document.querySelector("#japanese"),
  autonomous: document.querySelector("#autonomous"),
  extraInstruction: document.querySelector("#extraInstruction"),
  prompt: document.querySelector("#prompt"),
  loginBtn: document.querySelector("#loginBtn"),
  runBtn: document.querySelector("#runBtn"),
  newSessionBtn: document.querySelector("#newSessionBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  terminal: document.querySelector("#terminal"),
  runState: document.querySelector("#runState"),
  commandPreview: document.querySelector("#commandPreview"),
  sessionState: document.querySelector("#sessionState"),
  tokenState: document.querySelector("#tokenState"),
};

let currentJob = null;
let stream = null;
let statusCache = null;
let currentRun = null;
let latestImageMtime = 0;

function sessionForWorkspace(workspace) {
  const sessions = statusCache?.state?.sessions || {};
  return sessions[String(workspace || "").toLowerCase()] || null;
}

function updateSessionLabel() {
  const session = sessionForWorkspace(el.workspace.value);
  el.sessionState.textContent = session?.id ? `session: ${session.id}` : "session: none";
}

function updateTokenLabel(value) {
  el.tokenState.textContent = value ? `tokens: ${value}` : "tokens: -";
}

function append(text, kind = "") {
  const prefix = kind ? `[${kind}] ` : "";
  el.terminal.textContent += `${prefix}${text}`;
  el.terminal.scrollTop = el.terminal.scrollHeight;
}

function appendLine(text, kind = "") {
  append(`${text}\n`, kind);
}

function appendImageCard(image) {
  const marker = `[image:${image.name}]`;
  if (el.terminal.textContent.includes(marker)) return;

  const url = `${image.url}?t=${Math.round(image.mtimeMs)}`;
  append(`\n${marker}\n`);
  el.terminal.insertAdjacentHTML("beforeend", `
    <div class="image-card">
      <a href="${url}" target="_blank" rel="noreferrer">
        <img src="${url}" alt="${escapeHtml(image.name)}">
      </a>
      <div>${escapeHtml(image.name)}</div>
    </div>
  `);
  el.terminal.scrollTop = el.terminal.scrollHeight;
}

async function showLatestGeneratedImage() {
  const res = await fetch("/api/generated-images");
  if (!res.ok) return;
  const body = await res.json();
  const image = body.images?.[0];
  if (!image) {
    appendLine("画像ファイルがまだ見つかりません。", "error");
    return;
  }
  if (image.mtimeMs < latestImageMtime) return;
  latestImageMtime = image.mtimeMs;
  appendImageCard(image);
}

function setRunning(running) {
  el.runBtn.disabled = running;
  el.stopBtn.disabled = !running || !currentJob;
  el.runState.textContent = running ? "実行中" : "待機中";
  document.body.classList.toggle("is-running", running);
}

function renderHistory(history) {
  el.history.innerHTML = "";
  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "まだ履歴はありません";
    el.history.append(empty);
    return;
  }

  for (const item of history.slice(0, 12)) {
    const button = document.createElement("button");
    button.className = "history-item";
    button.type = "button";
    button.innerHTML = `
      <strong>${escapeHtml(item.permission || "workspace-write")}</strong>
      <span>${escapeHtml(item.prompt || "")}</span>
    `;
    button.addEventListener("click", () => {
      el.workspace.value = item.workspace || el.workspace.value;
      el.permission.value = item.permission || "workspace-write";
      el.prompt.value = item.prompt || "";
    });
    el.history.append(button);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripCodexNoise(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  let inHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (!inHeader) kept.push(line);
      continue;
    }

    if (trimmed.startsWith("OpenAI Codex v")) {
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (trimmed === "--------" || /^[a-zA-Z][\w ]*:/.test(trimmed) || trimmed === "user") {
        continue;
      }
      inHeader = false;
    }

    if (/^\d{4}-\d{2}-\d{2}T.*\b(WARN|ERROR)\b/.test(trimmed)) continue;
    if (trimmed.startsWith("Reading additional input from stdin")) continue;
    if (trimmed.startsWith("ERROR: Reconnecting")) continue;
    if (trimmed === "tokens used") continue;
    if (currentRun?.pendingTokensUsed && /^[\d,]+$/.test(trimmed)) continue;
    if (trimmed === "--------" || trimmed === "user") continue;
    if (/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/.test(trimmed)) continue;

    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function consumeTelemetry(rawText) {
  if (!currentRun) return rawText;

  const lines = String(rawText).replace(/\r\n/g, "\n").split("\n");
  const visible = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (currentRun.pendingTokensUsed && /^[\d,]+$/.test(trimmed)) {
      currentRun.tokensUsed = trimmed;
      currentRun.pendingTokensUsed = false;
      updateTokenLabel(trimmed);
      continue;
    }

    if (trimmed === "tokens used") {
      currentRun.pendingTokensUsed = true;
      continue;
    }

    const inlineTokens = trimmed.match(/^tokens used\s+([\d,]+)$/i);
    if (inlineTokens) {
      currentRun.tokensUsed = inlineTokens[1];
      currentRun.pendingTokensUsed = false;
      updateTokenLabel(inlineTokens[1]);
      continue;
    }

    visible.push(line);
  }

  return visible.join("\n");
}

function appendAssistantText(rawText) {
  const text = stripCodexNoise(consumeTelemetry(rawText));
  if (text.trim()) {
    append(text.endsWith("\n") ? text : `${text}\n`);
    if (text.includes("画像を生成しました")) {
      setTimeout(() => showLatestGeneratedImage().catch(() => {}), 500);
    }
  }
}

async function refreshStatus() {
  const res = await fetch("/api/status");
  const status = await res.json();
  el.codexState.textContent = status.codexInstalled ? "OK" : "未インストール";
  el.codexState.className = status.codexInstalled ? "ok" : "bad";
  el.codexHome.textContent = status.codexHome;
  el.rootPath.textContent = status.root;
  if (!el.workspace.value) {
    el.workspace.value = status.workspaceRoot;
  }
  const latestImage = status.generatedImages?.[0];
  latestImageMtime = latestImage?.mtimeMs || 0;
  statusCache = status;
  updateSessionLabel();
  renderHistory(status.history || []);
}

async function runCodex() {
  const payload = {
    workspace: el.workspace.value,
    model: el.model.value,
    permission: el.permission.value,
    resume: el.resume.checked,
    japanese: el.japanese.checked,
    autonomous: el.autonomous.checked,
    extraInstruction: el.extraInstruction.value,
    prompt: el.prompt.value,
  };

  if (!payload.prompt.trim()) {
    appendLine("依頼が空です。", "error");
    return;
  }

  if (payload.permission === "bypass") {
    const ok = confirm("全突っ張りモードは承認とサンドボックスを飛ばします。このPCを信頼できる場合だけ使ってください。続行しますか？");
    if (!ok) return;
  }

  setRunning(true);
  el.commandPreview.textContent = "";
  currentRun = {
    stderr: "",
    hadError: false,
    meta: null,
    tokensUsed: "",
    pendingTokensUsed: false,
  };
  updateTokenLabel("");

  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) {
    appendLine(body.error || "起動に失敗しました。", "error");
    setRunning(false);
    currentRun = null;
    return;
  }

  currentJob = body.id;
  stream = new EventSource(`/api/jobs/${currentJob}/events`);

  stream.addEventListener("meta", (event) => {
    const data = JSON.parse(event.data);
    currentRun.meta = data;
    el.commandPreview.textContent = data.command || "";
    if (data.sessionId) {
      el.sessionState.textContent = `session: ${data.sessionId}`;
    }
  });
  stream.addEventListener("session", (event) => {
    const data = JSON.parse(event.data);
    el.sessionState.textContent = `session: ${data.id}`;
  });
  stream.addEventListener("stdout", (event) => appendAssistantText(JSON.parse(event.data)));
  stream.addEventListener("stderr", (event) => {
    const text = JSON.parse(event.data);
    currentRun.stderr += text;
    if (/(\bERROR\b|Unauthorized|failed|panic|Exception)/i.test(text)) {
      currentRun.hadError = true;
    }
    appendAssistantText(text);
  });
  stream.addEventListener("error", (event) => {
    if (event.data) {
      currentRun.hadError = true;
      appendLine(JSON.parse(event.data), "error");
    }
  });
  stream.addEventListener("exit", async (event) => {
    const data = JSON.parse(event.data);
    const failed = data.code !== 0 || data.status !== "done" || currentRun?.hadError;

    if (failed) {
      appendLine(`--- 終了 code=${data.code} status=${data.status} ---`, "error");
      if (currentRun?.meta) {
        appendLine(`workspace: ${currentRun.meta.workspace}`, "error");
        appendLine(`permission: ${currentRun.meta.permission}`, "error");
        appendLine(`mode: ${currentRun.meta.isResume ? "resume" : "new"}`, "error");
      }
      const filteredStderr = stripCodexNoise(currentRun?.stderr || "").trim();
      if (filteredStderr) {
        appendLine(filteredStderr, "stderr");
      }
    }

    stream.close();
    stream = null;
    currentJob = null;
    currentRun = null;
    setRunning(false);
    await refreshStatus();
  });
  stream.onerror = () => {
    if (stream) {
      appendLine("イベント接続が切れました。", "error");
      stream.close();
      stream = null;
    }
    currentJob = null;
    currentRun = null;
    setRunning(false);
  };
}

async function stopCodex() {
  if (!currentJob) return;
  await fetch(`/api/jobs/${currentJob}/stop`, { method: "POST" });
}

async function openLogin() {
  const res = await fetch("/api/login", { method: "POST" });
  if (res.ok) {
    appendLine("ログイン用PowerShellを開きました。ログイン後、この画面から再実行してください。");
  } else {
    const body = await res.json().catch(() => ({}));
    appendLine(body.error || "ログイン起動に失敗しました。", "error");
  }
}

async function newSession() {
  await fetch("/api/session/clear", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: el.workspace.value }),
  });
  await refreshStatus();
  appendLine("新規セッションに切り替えました。次の実行では初回指示も送ります。");
}

el.loginBtn.addEventListener("click", openLogin);
el.runBtn.addEventListener("click", runCodex);
el.newSessionBtn.addEventListener("click", newSession);
el.stopBtn.addEventListener("click", stopCodex);
el.clearBtn.addEventListener("click", () => {
  el.terminal.textContent = "";
});
el.workspace.addEventListener("change", updateSessionLabel);

refreshStatus().catch((error) => {
  el.codexState.textContent = "エラー";
  appendLine(error.message, "error");
});

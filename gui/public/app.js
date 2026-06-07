const el = {
  codexState: document.querySelector("#codexState"),
  codexHome: document.querySelector("#codexHome"),
  rootPath: document.querySelector("#rootPath"),
  updateState: document.querySelector("#updateState"),
  history: document.querySelector("#history"),
  historyBtn: document.querySelector("#historyBtn"),
  workspace: document.querySelector("#workspace"),
  model: document.querySelector("#model"),
  activeModel: document.querySelector("#activeModel"),
  tokenBudget: document.querySelector("#tokenBudget"),
  permission: document.querySelector("#permission"),
  bypass: document.querySelector("#bypass"),
  enterToSend: document.querySelector("#enterToSend"),
  resume: document.querySelector("#resume"),
  japanese: document.querySelector("#japanese"),
  autonomous: document.querySelector("#autonomous"),
  extraInstruction: document.querySelector("#extraInstruction"),
  prompt: document.querySelector("#prompt"),
  fileInput: document.querySelector("#fileInput"),
  attachBtn: document.querySelector("#attachBtn"),
  screenshotBtn: document.querySelector("#screenshotBtn"),
  latestImageBtn: document.querySelector("#latestImageBtn"),
  openArtifactsBtn: document.querySelector("#openArtifactsBtn"),
  openImagesBtn: document.querySelector("#openImagesBtn"),
  openUploadsBtn: document.querySelector("#openUploadsBtn"),
  analyticsBtn: document.querySelector("#analyticsBtn"),
  loginBtn: document.querySelector("#loginBtn"),
  runBtn: document.querySelector("#runBtn"),
  newSessionBtn: document.querySelector("#newSessionBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  attachments: document.querySelector("#attachments"),
  terminal: document.querySelector("#terminal"),
  thinking: document.querySelector("#thinking"),
  runState: document.querySelector("#runState"),
  commandPreview: document.querySelector("#commandPreview"),
  sessionState: document.querySelector("#sessionState"),
  tokenState: document.querySelector("#tokenState"),
  rateLimitState: document.querySelector("#rateLimitState"),
};

let currentJob = null;
let stream = null;
let statusCache = null;
let currentRun = null;
let latestImageMtime = 0;
let pendingFiles = [];
let thinkingTimer = null;
let seenEventIds = new Set();
let streamFinished = false;
let runAbortController = null;
let loggedIn = false;
const settingsKey = "portableCodexGuiSettings";
const imageSessionKey = "portableCodexImageSession";

function isAuthErrorText(text) {
  return /(401 Unauthorized|Missing bearer|authentication|ログイン|login)/i.test(String(text || ""));
}

function isNonPersistedItemError(text) {
  return /Items are not persisted when `store` is set to false|Item with id 'ig_[^']+' not found/i.test(String(text || ""));
}

function looksLikeImagePrompt(text) {
  return /(描いて|画像|イラスト|絵|生成|image|illustration|draw)/i.test(String(text || ""));
}

function looksLikeImageGenerationPrompt(text) {
  return /(描いて|描画|画像生成|イラスト|絵を|絵描|作画|生成して|image generation|generate an image|draw|illustration)/i.test(String(text || ""));
}

function looksLikeImageFollowupPrompt(text) {
  return /(文字|テキスト|入れて|載せて|追加|修正|編集|変えて|さっき|直前|この画像|これに|edit|add text|caption|modify)/i.test(String(text || ""));
}

function modelForRequest(prompt) {
  const selected = el.model.value;
  if (selected === "gpt-5.3-codex-spark" && looksLikeImageGenerationPrompt(prompt)) {
    return "gpt-5.5";
  }
  return selected;
}

function readImageSession() {
  try {
    return JSON.parse(localStorage.getItem(imageSessionKey) || "null");
  } catch {
    return null;
  }
}

function writeImageSession(image) {
  if (!image?.path) return;
  localStorage.setItem(imageSessionKey, JSON.stringify({
    workspace: el.workspace.value,
    name: image.name,
    path: image.path,
    mtimeMs: image.mtimeMs,
  }));
}

function clearImageSession() {
  localStorage.removeItem(imageSessionKey);
}

function latestImageForFollowup(prompt) {
  const image = readImageSession();
  if (!image?.path) return null;
  if (!isCurrentWorkspaceImageSession(image)) return null;
  if (!looksLikeImageFollowupPrompt(prompt)) return null;
  return {
    name: image.name || "latest-generated-image",
    path: image.path,
    image: true,
    autoAttached: true,
  };
}

function isCurrentWorkspaceImageSession(image = readImageSession()) {
  if (!image?.path) return false;
  return !image.workspace || image.workspace === el.workspace.value;
}

async function clearCurrentSessionQuietly() {
  await fetch("/api/session/clear", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: el.workspace.value }),
  }).catch(() => {});
  await refreshStatus().catch(() => {});
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sessionForWorkspace(workspace) {
  const sessions = statusCache?.state?.sessions || {};
  return sessions[String(workspace || "").toLowerCase()] || null;
}

function updateSessionLabel() {
  const session = sessionForWorkspace(el.workspace.value);
  el.sessionState.textContent = session?.id ? `session: ${session.id}` : "session: none";
}

function updateTokenLabel(value) {
  const used = Number(String(value || "").replaceAll(",", ""));
  const budget = Number(el.tokenBudget.value || localStorage.getItem("portableCodexTokenBudget") || 0);
  if (!used) {
    el.tokenState.textContent = budget ? `tokens: 0 / 残 ${budget.toLocaleString()}` : "tokens: -";
    return;
  }
  if (!budget) {
    el.tokenState.textContent = `tokens: ${used.toLocaleString()}`;
    return;
  }
  const remaining = Math.max(0, budget - used);
  el.tokenState.textContent = `tokens: ${used.toLocaleString()} / 残 ${remaining.toLocaleString()}`;
}

function updateLoginButton(value = loggedIn) {
  loggedIn = Boolean(value);
  el.loginBtn.textContent = loggedIn ? "ログアウト" : "ログイン";
  el.loginBtn.classList.toggle("danger", loggedIn);
}

function formatLimitWindow(window, fallbackLabel) {
  if (!window) return `${fallbackLabel}: -`;
  const used = Number(window.usedPercent);
  const remaining = Number.isFinite(used) ? Math.max(0, 100 - used) : null;
  const label = window.windowDurationMins && window.windowDurationMins <= 360
    ? "5h"
    : (window.windowDurationMins && window.windowDurationMins >= 1000 ? "week" : fallbackLabel);
  const percent = remaining === null ? "-" : `残${Math.round(remaining)}%`;
  const reset = formatResetLabel(window);
  return `${label}: ${percent}${reset ? ` ${reset}` : ""}`;
}

function getResetMs(window) {
  if (!window?.resetsAt) return "";
  return window.resetsAt > 10_000_000_000 ? window.resetsAt : window.resetsAt * 1000;
}

function formatResetLabel(window) {
  const resetMs = getResetMs(window);
  if (!resetMs) return "";
  const reset = new Date(resetMs);
  const sameDay = reset.toDateString() === new Date().toDateString();
  const date = sameDay
    ? reset.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false })
    : reset.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return `更新 ${date}`;
}

function formatRateLimitBucket(bucket, key = "") {
  const rawName = bucket?.limitName || bucket?.limitId || key || "usage";
  const lowerName = String(rawName).toLowerCase();
  const name = lowerName.includes("spark") || lowerName.includes("sparc")
    ? "Spark"
    : (lowerName.includes("5.5") || lowerName.includes("5_5") || lowerName.includes("gpt-5") ? "5.5" : rawName);
  const primary = formatLimitWindow(bucket?.primary, "primary");
  const secondary = formatLimitWindow(bucket?.secondary, "week");
  return `${name} ${primary} ${secondary}`;
}

function setRateLimitLines(lines) {
  const allLines = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
  const visibleLines = allLines.length <= 2
    ? allLines
    : [allLines[0], allLines.slice(1).join(" | ")];
  el.rateLimitState.innerHTML = "";
  for (const line of visibleLines) {
    const item = document.createElement("span");
    item.textContent = line;
    el.rateLimitState.append(item);
  }
}

function updateRateLimitLabel(payload) {
  if (!payload) {
    setRateLimitLines("usage: -");
    return;
  }
  if (!payload.ok) {
    const message = String(payload.error || "");
    if (/auth|login|authentication/i.test(message)) updateLoginButton(false);
    setRateLimitLines(/auth|login|authentication/i.test(message)
      ? "usage: login required"
      : "usage: unavailable");
    return;
  }
  updateLoginButton(true);
  const buckets = payload.rateLimits?.rateLimitsByLimitId;
  const bucketEntries = buckets && typeof buckets === "object"
    ? Object.entries(buckets).filter(([, value]) => value)
    : [];
  if (bucketEntries.length) {
    setRateLimitLines(bucketEntries.map(([key, value]) => formatRateLimitBucket(value, key)));
    return;
  }
  setRateLimitLines(formatRateLimitBucket(payload.rateLimits?.rateLimits, "usage"));
}

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(settingsKey) || "{}");
  } catch {
    return {};
  }
}

function writeSettings() {
  const settings = {
    workspace: el.workspace.value,
    model: el.model.value,
    tokenBudget: el.tokenBudget.value,
    permission: el.permission.value,
    bypass: el.bypass.checked,
    enterToSend: el.enterToSend.checked,
    resume: el.resume.checked,
    japanese: el.japanese.checked,
    autonomous: el.autonomous.checked,
    extraInstruction: el.extraInstruction.value,
  };
  localStorage.setItem(settingsKey, JSON.stringify(settings));
}

function syncActiveModelFromSettings() {
  if (!el.activeModel) return;
  if (!el.activeModel.options.length) {
    el.activeModel.innerHTML = el.model.innerHTML;
  }
  el.activeModel.value = el.model.value;
}

function setModel(value) {
  el.model.value = value;
  syncActiveModelFromSettings();
  writeSettings();
}

function applySettings(settings) {
  if (settings.workspace) el.workspace.value = settings.workspace;
  if (settings.model !== undefined) el.model.value = settings.model;
  if (settings.tokenBudget !== undefined) el.tokenBudget.value = settings.tokenBudget;
  if (settings.permission) el.permission.value = settings.permission;
  if (settings.bypass !== undefined) el.bypass.checked = Boolean(settings.bypass);
  if (settings.enterToSend !== undefined) el.enterToSend.checked = Boolean(settings.enterToSend);
  if (settings.resume !== undefined) el.resume.checked = Boolean(settings.resume);
  if (settings.japanese !== undefined) el.japanese.checked = Boolean(settings.japanese);
  if (settings.autonomous !== undefined) el.autonomous.checked = Boolean(settings.autonomous);
  if (settings.extraInstruction !== undefined) el.extraInstruction.value = settings.extraInstruction;
  syncActiveModelFromSettings();
}

function append(text, kind = "") {
  const row = document.createElement("div");
  row.className = `log-line ${kind || "assistant"}`;
  row.textContent = text;
  el.terminal.append(row);
  el.terminal.scrollTop = el.terminal.scrollHeight;
}

function appendLine(text, kind = "") {
  append(`${text}\n`, kind);
}

function appendUserMessage(text, uploads = []) {
  const parts = [text || "添付を確認してください。"];
  if (uploads.length) {
    parts.push("");
    parts.push("添付:");
    for (const file of uploads) parts.push(`- ${file.name}`);
  }
  append(parts.join("\n"), "user");
}

function setRunning(running) {
  el.runBtn.disabled = running;
  el.stopBtn.disabled = !running;
  el.runState.textContent = running ? "実行中" : "待機中";
  el.thinking.hidden = !running;
  if (!running && thinkingTimer) {
    clearTimeout(thinkingTimer);
    thinkingTimer = null;
  }
  document.body.classList.toggle("is-running", running);
}

function markActivity() {
  if (!currentJob) return;
  el.thinking.hidden = true;
  if (thinkingTimer) clearTimeout(thinkingTimer);
  thinkingTimer = setTimeout(() => {
    if (currentJob) el.thinking.hidden = false;
  }, 1800);
}

function renderAttachments() {
  el.attachments.innerHTML = "";
  for (const [index, file] of pendingFiles.entries()) {
    const item = document.createElement("div");
    item.className = "attachment";
    const preview = file.type.startsWith("image/") ? `<img src="${file.data}" alt="">` : `<span class="file-icon">FILE</span>`;
    item.innerHTML = `
      ${preview}
      <span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <button type="button" aria-label="削除">x</button>
    `;
    item.querySelector("button").addEventListener("click", () => {
      pendingFiles.splice(index, 1);
      renderAttachments();
    });
    el.attachments.append(item);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name || `paste-${Date.now()}.png`,
      type: file.type || "application/octet-stream",
      size: file.size || 0,
      data: reader.result,
    });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  const items = [...files].filter(Boolean);
  if (!items.length) return;
  const loaded = await Promise.all(items.map(readFileAsDataUrl));
  pendingFiles.push(...loaded);
  renderAttachments();
}

async function captureScreenshot() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    appendLine("このブラウザではスクショ取得が使えません。", "error");
    return;
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const file = new File([blob], `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`, { type: "image/png" });
    await addFiles([file]);
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

async function uploadPendingFiles() {
  if (!pendingFiles.length) return [];
  const res = await fetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: el.workspace.value, files: pendingFiles }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "添付のアップロードに失敗しました。");
  return body.uploads || [];
}

function appendImageCard(image) {
  const marker = `[image:${image.name}]`;
  if (el.terminal.textContent.includes(marker)) return;
  writeImageSession(image);
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

function appendArtifactCards(artifacts) {
  const images = (artifacts || []).filter((item) => item.image);
  for (const image of images) appendImageCard(image);
}

function appendUploadPaths(uploads) {
  if (!uploads?.length) return;
  appendLine("添付を保存しました:", "system");
  for (const file of uploads) {
    appendLine(`- ${file.name}: ${file.path}`, "system");
  }
}

async function showLatestGeneratedImage(options = {}) {
  const baseline = options.baseline ?? latestImageMtime;
  const attempts = options.wait ? 24 : 1;

  for (let i = 0; i < attempts; i += 1) {
  const res = await fetch("/api/generated-images");
  if (!res.ok) return;
  const body = await res.json();
    const image = body.images?.find((item) => item.mtimeMs > baseline) || (options.allowExisting ? body.images?.[0] : null);
    if (image) {
      latestImageMtime = image.mtimeMs;
      appendImageCard(image);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (options.notice !== false) {
    appendLine("画像生成メッセージは検出しましたが、画像ファイルがまだ見つかりません。", "error");
  }
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
  for (const item of history.slice(0, 10)) {
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
      el.bypass.checked = item.permission === "bypass";
      el.prompt.value = item.prompt || "";
    });
    el.history.append(button);
  }
}

function renderHistorySummary(history) {
  const count = Array.isArray(history) ? history.length : 0;
  el.history.textContent = count ? `${count}件` : "履歴なし";
}

function stripCodexNoise(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  let inHeader = false;
  let skippingBaseInstruction = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (currentRun?.userPromptKey && normalizeVisibleText(trimmed) === currentRun.userPromptKey) continue;
    if (/^0\.\d+\.\d+$/.test(trimmed)) continue;
    if (trimmed === "以後の回答はすべて日本語で返してください。コマンド出力やファイル名などの固有名は必要に応じて原文のまま残してください。") {
      skippingBaseInstruction = true;
      continue;
    }
    if (skippingBaseInstruction) {
      if (!trimmed) continue;
      if (
        trimmed === "可能な限り自律的に作業を進め、実装、検証、結果報告まで行ってください。重大な破壊的操作や認証情報が必要な場合だけ確認してください。" ||
        trimmed === "作業後は変更点と検証結果を簡潔に報告してください。"
      ) {
        continue;
      }
      skippingBaseInstruction = false;
    }
    if (!trimmed) {
      if (!inHeader) kept.push(line);
      continue;
    }
    if (trimmed.startsWith("OpenAI Codex v")) {
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (trimmed === "--------" || /^[a-zA-Z][\w ]*:/.test(trimmed) || trimmed === "user") continue;
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

function normalizeVisibleText(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/\s+/g, " "))
    .replace(/\s+/g, " ")
    .trim();
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
    const dedupeKey = normalizeVisibleText(text);
    currentRun.visibleTextKeys ||= new Set();
    currentRun.visibleTextBuffer ||= [];
    if (currentRun.visibleTextKeys.has(dedupeKey)) return;
    if (currentRun.visibleTextBuffer.some((old) => old.includes(dedupeKey) || dedupeKey.includes(old))) return;
    currentRun.visibleTextKeys.add(dedupeKey);
    currentRun.visibleTextBuffer.push(dedupeKey);
    currentRun.visibleTextBuffer = currentRun.visibleTextBuffer.slice(-20);
    markActivity();
    append(text.endsWith("\n") ? text : `${text}\n`);
    if (text.includes("画像を生成しました")) {
      currentRun.imageRequested = true;
      const baseline = currentRun.imageBaselineMtime ?? latestImageMtime;
      showLatestGeneratedImage({ wait: true, baseline, notice: false }).catch(() => {});
    }
  }
}

function shouldHandleEvent(event) {
  if (!event.lastEventId) return true;
  const key = `${currentJob || "job"}:${event.lastEventId}`;
  if (seenEventIds.has(key)) return false;
  seenEventIds.add(key);
  return true;
}

async function refreshStatus() {
  const res = await fetch("/api/status");
  const status = await res.json();
  applySettings(readSettings());
  el.codexState.textContent = status.codexInstalled ? "OK" : "未インストール";
  el.codexState.className = status.codexInstalled ? "ok" : "bad";
  el.codexHome.textContent = status.codexHome;
  el.rootPath.textContent = status.root;
  const updateMessages = [];
  if (status.updateStatus) updateMessages.push(`GUI ${status.updateStatus.status}: ${status.updateStatus.message}`);
  if (status.codexCliUpdateStatus) updateMessages.push(`CLI ${status.codexCliUpdateStatus.status}: ${status.codexCliUpdateStatus.message}`);
  el.updateState.textContent = updateMessages.length ? updateMessages.join(" / ") : "未確認";
  if (!el.workspace.value) el.workspace.value = status.workspaceRoot;
  latestImageMtime = status.generatedImages?.[0]?.mtimeMs || 0;
  updateTokenLabel(currentRun?.tokensUsed || "");
  if (status.auth?.checked) updateLoginButton(status.auth.loggedIn);
  updateRateLimitLabel(status.rateLimits);
  statusCache = status;
  updateSessionLabel();
  renderHistorySummary(status.history || []);
}

async function refreshRateLimits(force = false) {
  const res = await fetch(`/api/rate-limits${force ? "?refresh=1" : ""}`);
  const payload = await res.json();
  updateRateLimitLabel(payload);
}

async function runCodex() {
  if (currentJob) return;
  const prompt = el.prompt.value.trim();
  if (!prompt && !pendingFiles.length) {
    appendLine("依頼または添付が空です。", "error");
    return;
  }

  const permission = el.bypass.checked ? "bypass" : el.permission.value;
  const followupImage = pendingFiles.length ? null : latestImageForFollowup(prompt);
  const hasImageAttachment = pendingFiles.some((file) => String(file.type || "").startsWith("image/"));
  const hasAutoImageAttachment = Boolean(followupImage);
  const hasPreviousImageSession = isCurrentWorkspaceImageSession();
  const forceNewForImage = el.resume.checked && (
    looksLikeImagePrompt(prompt)
    || looksLikeImageFollowupPrompt(prompt)
    || hasImageAttachment
    || hasAutoImageAttachment
    || hasPreviousImageSession
  );
  const effectiveModel = modelForRequest(prompt);
  setRunning(true);
  el.commandPreview.textContent = "";
  currentRun = {
    stderr: "",
    hadError: false,
    meta: null,
    tokensUsed: "",
    pendingTokensUsed: false,
    authNoticeShown: false,
    imageRequested: false,
    imageBaselineMtime: latestImageMtime,
    userPromptKey: normalizeVisibleText(prompt || "添付を確認してください。"),
    visibleTextKeys: new Set(),
    visibleTextBuffer: [],
  };
  updateTokenLabel("");

  let uploads = [];
  try {
    uploads = await uploadPendingFiles();
    if (followupImage) uploads.push(followupImage);
    appendUploadPaths(uploads.filter((file) => !file.autoAttached));
  } catch (error) {
    appendLine(error.message, "error");
    setRunning(false);
    currentRun = null;
    return;
  }
  appendUserMessage(prompt, uploads);
  if (followupImage) {
    appendLine(`直近の生成画像を自動添付しました: ${followupImage.path}`, "system");
  }
  if (effectiveModel !== el.model.value) {
    appendLine(`画像生成のため、この実行だけ ${effectiveModel} で送信します。`, "system");
  }

  const payload = {
    workspace: el.workspace.value,
    model: effectiveModel,
    permission,
    resume: forceNewForImage ? false : el.resume.checked,
    japanese: el.japanese.checked,
    autonomous: el.autonomous.checked,
    extraInstruction: el.extraInstruction.value,
    prompt: prompt || "添付ファイルを確認してください。",
    uploads,
  };

  runAbortController = new AbortController();
  let res;
  let body;
  try {
    res = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: runAbortController.signal,
    });
    body = await res.json();
  } catch (error) {
    if (error.name !== "AbortError") appendLine(error.message, "error");
    runAbortController = null;
    setRunning(false);
    currentRun = null;
    return;
  }
  runAbortController = null;
  if (!res.ok) {
    appendLine(body.error || "起動に失敗しました。", "error");
    setRunning(false);
    currentRun = null;
    return;
  }

  pendingFiles = [];
  renderAttachments();
  el.prompt.value = "";
  currentJob = body.id;
  seenEventIds = new Set();
  streamFinished = false;
  stream = new EventSource(`/api/jobs/${currentJob}/events`);

  stream.addEventListener("meta", (event) => {
    if (!shouldHandleEvent(event)) return;
    streamFinished = true;
    const data = JSON.parse(event.data);
    currentRun.meta = data;
    el.commandPreview.textContent = data.command || "";
    if (data.sessionId) el.sessionState.textContent = `session: ${data.sessionId}`;
  });
  stream.addEventListener("session", (event) => {
    if (!shouldHandleEvent(event)) return;
    const data = JSON.parse(event.data);
    el.sessionState.textContent = `session: ${data.id}`;
  });
  stream.addEventListener("stdout", (event) => {
    if (!shouldHandleEvent(event)) return;
    appendAssistantText(JSON.parse(event.data));
  });
  stream.addEventListener("stderr", (event) => {
    if (!shouldHandleEvent(event)) return;
    const text = JSON.parse(event.data);
    currentRun.stderr += text;
    if (isNonPersistedItemError(text) && !currentRun.nonPersistedNoticeShown) {
      currentRun.nonPersistedNoticeShown = true;
      appendLine("前の画像生成セッションを再開できません。新規セッションで再実行してください。", "error");
      clearCurrentSessionQuietly();
    }
    if (isAuthErrorText(text) && !currentRun.authNoticeShown) {
      currentRun.authNoticeShown = true;
      appendLine("ログインされていません。ログインしてください。", "error");
    }
    if (/(\bERROR\b|Unauthorized|panic|Exception)/i.test(text)) currentRun.hadError = true;
    appendAssistantText(text);
  });
  stream.addEventListener("error", (event) => {
    if (!shouldHandleEvent(event)) return;
    if (event.data) {
      currentRun.hadError = true;
      appendLine(JSON.parse(event.data), "error");
    }
  });
  stream.addEventListener("artifacts", (event) => {
    if (!shouldHandleEvent(event)) return;
    appendArtifactCards(JSON.parse(event.data));
  });
  stream.addEventListener("stop", (event) => {
    if (!shouldHandleEvent(event)) return;
    appendLine("停止しました。", "system");
    if (stream) {
      stream.close();
      stream = null;
    }
    currentJob = null;
    currentRun = null;
    setRunning(false);
  });
  stream.addEventListener("exit", async (event) => {
    if (!shouldHandleEvent(event)) return;
    const data = JSON.parse(event.data);
    const failed = data.code !== 0 || data.status !== "done";
    if (failed) {
      appendLine(`--- 終了 code=${data.code} status=${data.status} ---`, "error");
      if (currentRun?.meta) {
        appendLine(`workspace: ${currentRun.meta.workspace}`, "error");
        appendLine(`permission: ${currentRun.meta.permission}`, "error");
        appendLine(`mode: ${currentRun.meta.isResume ? "resume" : "new"}`, "error");
      }
      const filteredStderr = stripCodexNoise(currentRun?.stderr || "").trim();
      if (filteredStderr && !currentRun?.nonPersistedNoticeShown) appendAssistantText(filteredStderr);
    }
    if (!failed && currentRun?.imageRequested) {
      await showLatestGeneratedImage({
        wait: true,
        baseline: currentRun.imageBaselineMtime ?? latestImageMtime,
        notice: true,
      }).catch(() => {});
      await clearCurrentSessionQuietly();
    }
    stream.close();
    stream = null;
    currentJob = null;
    currentRun = null;
    setRunning(false);
    await refreshStatus();
  });
  stream.onerror = () => {
    if (streamFinished) return;
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
  if (!currentJob && !runAbortController) return;
  el.stopBtn.disabled = true;
  el.runState.textContent = "停止中";
  appendLine("停止しています...", "system");
  if (!currentJob && runAbortController) {
    runAbortController.abort();
    runAbortController = null;
    currentRun = null;
    appendLine("停止しました。", "system");
    setRunning(false);
    return;
  }
  try {
    await fetch(`/api/jobs/${currentJob}/stop`, { method: "POST" });
  } catch (error) {
    appendLine(error.message, "error");
  }
  setTimeout(() => {
    if (!currentJob) return;
    if (stream) {
      stream.close();
      stream = null;
    }
    currentJob = null;
    currentRun = null;
    appendLine("停止しました。", "system");
    setRunning(false);
  }, 2500);
}

async function openLogin() {
  const res = await fetch("/api/login", { method: "POST" });
  if (res.ok) appendLine("ログイン用PowerShellを開きました。ログイン後、この画面から再実行してください。");
  else appendLine("ログイン起動に失敗しました。", "error");
}

async function logoutCodex() {
  el.loginBtn.disabled = true;
  try {
    const res = await fetch("/api/logout", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      appendLine(body.error || "ログアウトに失敗しました。", "error");
      return;
    }
    updateLoginButton(false);
    setRateLimitLines("usage: login required");
    appendLine("ログアウトしました。", "system");
    await refreshStatus().catch(() => {});
  } finally {
    el.loginBtn.disabled = false;
  }
}

async function handleLoginButton() {
  if (loggedIn) {
    await logoutCodex();
  } else {
    await openLogin();
  }
}

async function openFolder(target) {
  const res = await fetch("/api/open-folder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    appendLine(body.error || "フォルダを開けませんでした。", "error");
  }
}

async function openUrl(target) {
  const res = await fetch("/api/open-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    appendLine(body.error || "ページを開けませんでした。", "error");
  }
}

async function newSession() {
  clearImageSession();
  await fetch("/api/session/clear", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: el.workspace.value }),
  });
  await refreshStatus();
  appendLine("新規セッションに切り替えました。次の実行では初回指示も送ります。");
}

el.attachBtn.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", () => addFiles(el.fileInput.files));
el.screenshotBtn.addEventListener("click", () => captureScreenshot().catch((error) => appendLine(error.message, "error")));
el.latestImageBtn.addEventListener("click", () => showLatestGeneratedImage({ allowExisting: true, baseline: 0, notice: true }).catch((error) => appendLine(error.message, "error")));
el.openArtifactsBtn.addEventListener("click", () => openFolder("artifacts"));
el.openImagesBtn.addEventListener("click", () => openFolder("generatedImages"));
el.openUploadsBtn.addEventListener("click", () => openFolder("uploads"));
el.analyticsBtn.addEventListener("click", () => openUrl("analytics"));
el.historyBtn.addEventListener("click", () => window.open("/api/history.txt", "_blank", "noopener,noreferrer"));
el.loginBtn.addEventListener("click", handleLoginButton);
el.runBtn.addEventListener("click", runCodex);
el.newSessionBtn.addEventListener("click", newSession);
el.stopBtn.addEventListener("click", stopCodex);
el.clearBtn.addEventListener("click", () => {
  el.terminal.textContent = "";
});
el.workspace.addEventListener("change", () => {
  updateSessionLabel();
  writeSettings();
});
el.tokenBudget.addEventListener("change", () => {
  writeSettings();
  updateTokenLabel(currentRun?.tokensUsed || "");
});
el.model.addEventListener("change", () => setModel(el.model.value));
el.activeModel.addEventListener("change", () => setModel(el.activeModel.value));
for (const item of [el.permission, el.bypass, el.enterToSend, el.resume, el.japanese, el.autonomous, el.extraInstruction]) {
  item.addEventListener("change", writeSettings);
}

document.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("is-dragging");
});
document.addEventListener("dragleave", () => document.body.classList.remove("is-dragging"));
document.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("is-dragging");
  addFiles(event.dataTransfer.files).catch((error) => appendLine(error.message, "error"));
});
document.addEventListener("paste", (event) => {
  const files = [...event.clipboardData.files];
  if (files.length) addFiles(files).catch((error) => appendLine(error.message, "error"));
});
el.prompt.addEventListener("keydown", (event) => {
  const wantsEnterSend = el.enterToSend.checked && !event.shiftKey;
  const wantsShortcutSend = event.key === "Enter" && (event.ctrlKey || event.metaKey);
  if (event.key === "Enter" && (wantsEnterSend || wantsShortcutSend)) {
    event.preventDefault();
    runCodex();
  }
});

refreshStatus().catch((error) => {
  el.codexState.textContent = "エラー";
  appendLine(error.message, "error");
});
refreshRateLimits(true).catch(() => {});
setInterval(() => {
  refreshRateLimits(false).catch(() => {});
}, 60_000);

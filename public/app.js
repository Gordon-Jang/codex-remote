const state = {
  authValue: localStorage.getItem("codexRemoteToken") || "",
  activeJobId: "",
  eventSource: null,
  jobPollTimer: null,
  terminalSessionId: "",
  terminalEventSource: null,
  terminalPollTimer: null,
  desktopObjectUrl: ""
};

const el = {
  loginView: document.querySelector("#loginView"),
  appView: document.querySelector("#appView"),
  loginForm: document.querySelector("#loginForm"),
  tokenInput: document.querySelector("#tokenInput"),
  loginError: document.querySelector("#loginError"),
  logoutButton: document.querySelector("#logoutButton"),
  statusLine: document.querySelector("#statusLine"),
  tabs: document.querySelectorAll(".tab"),
  panels: {
    run: document.querySelector("#runPanel"),
    sessions: document.querySelector("#sessionsPanel"),
    desktop: document.querySelector("#desktopPanel"),
    security: document.querySelector("#securityPanel")
  },
  jobForm: document.querySelector("#jobForm"),
  promptInput: document.querySelector("#promptInput"),
  workspaceInput: document.querySelector("#workspaceInput"),
  terminalForm: document.querySelector("#terminalForm"),
  terminalInput: document.querySelector("#terminalInput"),
  terminalLog: document.querySelector("#terminalLog"),
  terminalStatus: document.querySelector("#terminalStatus"),
  terminalWorkspaceInput: document.querySelector("#terminalWorkspaceInput"),
  terminalStartButton: document.querySelector("#terminalStartButton"),
  terminalStopButton: document.querySelector("#terminalStopButton"),
  terminalClearButton: document.querySelector("#terminalClearButton"),
  jobList: document.querySelector("#jobList"),
  jobLog: document.querySelector("#jobLog"),
  refreshSessionsButton: document.querySelector("#refreshSessionsButton"),
  sessionList: document.querySelector("#sessionList"),
  sessionTitle: document.querySelector("#sessionTitle"),
  sessionMeta: document.querySelector("#sessionMeta"),
  sessionPreview: document.querySelector("#sessionPreview"),
  desktopPasteInput: document.querySelector("#desktopPasteInput"),
  desktopFocusButton: document.querySelector("#desktopFocusButton"),
  desktopPasteButton: document.querySelector("#desktopPasteButton"),
  desktopSendButton: document.querySelector("#desktopSendButton"),
  desktopScreenshotButton: document.querySelector("#desktopScreenshotButton"),
  desktopClickModeInput: document.querySelector("#desktopClickModeInput"),
  desktopStatus: document.querySelector("#desktopStatus"),
  desktopScreenshot: document.querySelector("#desktopScreenshot"),
  desktopScreenshotEmpty: document.querySelector("#desktopScreenshotEmpty"),
  screenshotFrame: document.querySelector(".screenshot-frame")
};

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.loginError.textContent = "";
  const authValue = el.tokenInput.value.trim();
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: authValue })
    });
    if (!response.ok) throw new Error(await readError(response));
    state.authValue = authValue;
    localStorage.setItem("codexRemoteToken", authValue);
    await bootApp();
  } catch (error) {
    el.loginError.textContent = error.message;
  }
});

el.logoutButton.addEventListener("click", () => {
  apiFetch("/api/logout", { method: "POST" }).catch(() => {});
  localStorage.removeItem("codexRemoteToken");
  state.authValue = "";
  if (state.eventSource) state.eventSource.close();
  if (state.terminalEventSource) state.terminalEventSource.close();
  stopJobPolling();
  stopTerminalPolling();
  showLogin();
});

for (const tab of el.tabs) {
  tab.addEventListener("click", () => {
    showTab(tab.dataset.tab);
    if (tab.dataset.tab === "desktop") {
      loadDesktopStatus();
    }
  });
}

el.jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = el.promptInput.value.trim();
  if (!prompt) return;
  const response = await apiFetch("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      workspace: el.workspaceInput.value.trim()
    })
  });
  const data = await response.json();
  el.promptInput.value = "";
  await loadJobs();
  selectJob(data.job.id);
});

el.terminalStartButton.addEventListener("click", startTerminal);
el.terminalStopButton.addEventListener("click", stopTerminal);
el.terminalClearButton.addEventListener("click", clearTerminal);
el.terminalForm.addEventListener("submit", sendTerminalInput);
el.terminalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    el.terminalForm.requestSubmit();
  }
});

el.refreshSessionsButton.addEventListener("click", loadSessions);
el.desktopFocusButton.addEventListener("click", focusCodexWindow);
el.desktopPasteButton.addEventListener("click", pasteToCodexWindow);
el.desktopSendButton.addEventListener("click", sendEnterToCodexWindow);
el.desktopScreenshotButton.addEventListener("click", refreshCodexScreenshot);
el.desktopClickModeInput.addEventListener("change", () => {
  el.screenshotFrame.classList.toggle("click-mode", el.desktopClickModeInput.checked);
  setDesktopStatus(el.desktopClickModeInput.checked ? "点击截图中的位置来操作 Codex" : "截图点击已关闭");
});
el.desktopScreenshot.addEventListener("click", clickCodexScreenshot);

if (state.authValue) {
  bootApp().catch(() => showLogin());
} else {
  showLogin();
}

async function bootApp() {
  const statusResponse = await apiFetch("/api/status");
  const status = await statusResponse.json();
  el.statusLine.textContent = `Runner: ${status.runner} | Terminal: ${status.terminal || "not configured"} | Codex Home: ${status.codexHome}`;
  el.workspaceInput.value = guessWorkspace();
  el.terminalWorkspaceInput.value = guessWorkspace();
  el.loginView.hidden = true;
  el.appView.hidden = false;
  await Promise.all([loadJobs(), loadTerminal(), loadSessions(), loadDesktopStatus()]);
}

function showLogin() {
  el.loginView.hidden = false;
  el.appView.hidden = true;
  el.tokenInput.value = "";
}

function showTab(name) {
  for (const tab of el.tabs) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  for (const [key, panel] of Object.entries(el.panels)) {
    panel.classList.toggle("active", key === name);
  }
}

async function loadTerminal() {
  const response = await apiFetch("/api/terminal");
  const data = await response.json();
  const running = data.sessions.find((session) => session.status === "running");
  const latest = running || data.sessions[0];
  if (latest) {
    selectTerminal(latest.id);
    return;
  }
  renderTerminal({
    status: "stopped",
    workspace: el.terminalWorkspaceInput.value,
    logs: []
  });
}

async function startTerminal() {
  setTerminalStatus("正在启动终端...");
  const response = await apiFetch("/api/terminal/start", {
    method: "POST",
    body: JSON.stringify({
      workspace: el.terminalWorkspaceInput.value.trim()
    })
  });
  const data = await response.json();
  await selectTerminal(data.session.id);
}

async function selectTerminal(id) {
  state.terminalSessionId = id;
  if (state.terminalEventSource) state.terminalEventSource.close();
  stopTerminalPolling();
  const response = await apiFetch(`/api/terminal/${encodeURIComponent(id)}`);
  const data = await response.json();
  renderTerminal(data.session);
  if (shouldPollJobs()) {
    startTerminalPolling(id);
    return;
  }
  state.terminalEventSource = new EventSource(`/api/terminal/${encodeURIComponent(id)}/events`);
  state.terminalEventSource.addEventListener("snapshot", (event) => {
    renderTerminal(JSON.parse(event.data));
  });
  state.terminalEventSource.addEventListener("error", () => startTerminalPolling(id));
}

async function sendTerminalInput(event) {
  event.preventDefault();
  const text = el.terminalInput.value;
  if (!text.trim()) return;
  if (!state.terminalSessionId) {
    await startTerminal();
  }
  const payload = text.endsWith("\n") ? text : `${text}\n`;
  const response = await apiFetch(`/api/terminal/${encodeURIComponent(state.terminalSessionId)}/input`, {
    method: "POST",
    body: JSON.stringify({ text: payload })
  });
  const data = await response.json();
  el.terminalInput.value = "";
  renderTerminal(data.session);
}

async function stopTerminal() {
  if (!state.terminalSessionId) return;
  const response = await apiFetch(`/api/terminal/${encodeURIComponent(state.terminalSessionId)}/stop`, {
    method: "POST"
  });
  const data = await response.json();
  renderTerminal(data.session);
}

async function clearTerminal() {
  if (!state.terminalSessionId) {
    el.terminalLog.textContent = "";
    return;
  }
  const response = await apiFetch(`/api/terminal/${encodeURIComponent(state.terminalSessionId)}/clear`, {
    method: "POST"
  });
  const data = await response.json();
  renderTerminal(data.session);
}

function renderTerminal(session) {
  const status = session.status || "stopped";
  const workspace = session.workspace || el.terminalWorkspaceInput.value || "";
  if (workspace && !el.terminalWorkspaceInput.value) {
    el.terminalWorkspaceInput.value = workspace;
  }
  setTerminalStatus(`状态: ${status}${workspace ? ` | ${workspace}` : ""}`);
  el.terminalLog.textContent = (session.logs || []).map(formatTerminalLine).join("");
  el.terminalLog.scrollTop = el.terminalLog.scrollHeight;
  el.terminalStopButton.disabled = status !== "running";
}

function formatTerminalLine(line) {
  if (line.stream === "system") {
    return `\n[${formatTime(line.time)}] ${line.text}\n`;
  }
  if (line.stream === "stdin") {
    return `\n> ${line.text}`;
  }
  return line.text;
}

function setTerminalStatus(message) {
  el.terminalStatus.textContent = message;
}

function startTerminalPolling(id) {
  if (state.terminalEventSource) {
    state.terminalEventSource.close();
    state.terminalEventSource = null;
  }
  if (state.terminalPollTimer) return;
  state.terminalPollTimer = setInterval(async () => {
    if (!state.terminalSessionId || state.terminalSessionId !== id) {
      stopTerminalPolling();
      return;
    }
    try {
      const response = await apiFetch(`/api/terminal/${encodeURIComponent(id)}`);
      const data = await response.json();
      renderTerminal(data.session);
      if (["completed", "failed", "stopped"].includes(data.session.status)) {
        stopTerminalPolling();
      }
    } catch {
      stopTerminalPolling();
    }
  }, 1000);
}

function stopTerminalPolling() {
  if (!state.terminalPollTimer) return;
  clearInterval(state.terminalPollTimer);
  state.terminalPollTimer = null;
}

async function loadJobs() {
  const response = await apiFetch("/api/jobs");
  const data = await response.json();
  el.jobList.innerHTML = "";
  if (!data.jobs.length) {
    el.jobList.innerHTML = `<div class="item-meta">暂无任务</div>`;
    return;
  }
  for (const job of data.jobs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `list-item${job.id === state.activeJobId ? " active" : ""}`;
    button.innerHTML = `
      <span class="item-title">${escapeHtml(job.prompt.slice(0, 90))}</span>
      <span class="item-meta">${escapeHtml(job.status)} · ${formatTime(job.updatedAt)}</span>
    `;
    button.addEventListener("click", () => selectJob(job.id));
    el.jobList.appendChild(button);
  }
}

async function selectJob(id) {
  state.activeJobId = id;
  if (state.eventSource) state.eventSource.close();
  stopJobPolling();
  const response = await apiFetch(`/api/jobs/${encodeURIComponent(id)}`);
  const data = await response.json();
  renderJob(data.job);
  if (shouldPollJobs()) {
    startJobPolling(id);
    return;
  }
  state.eventSource = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  state.eventSource.addEventListener("snapshot", (event) => {
    renderJob(JSON.parse(event.data));
    loadJobs();
  });
  state.eventSource.addEventListener("error", () => startJobPolling(id));
}

function renderJob(job) {
  el.jobLog.textContent = job.logs.map((line) => {
    return `[${formatTime(line.time)}] ${line.stream}: ${line.text}`;
  }).join("\n");
  el.jobLog.scrollTop = el.jobLog.scrollHeight;
}

function startJobPolling(id) {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (state.jobPollTimer) return;
  state.jobPollTimer = setInterval(async () => {
    if (!state.activeJobId || state.activeJobId !== id) {
      stopJobPolling();
      return;
    }
    try {
      const response = await apiFetch(`/api/jobs/${encodeURIComponent(id)}`);
      const data = await response.json();
      renderJob(data.job);
      loadJobs();
      if (["completed", "failed"].includes(data.job.status)) {
        stopJobPolling();
      }
    } catch {
      stopJobPolling();
    }
  }, 1000);
}

function stopJobPolling() {
  if (!state.jobPollTimer) return;
  clearInterval(state.jobPollTimer);
  state.jobPollTimer = null;
}

function shouldPollJobs() {
  return window.location.hostname.endsWith(".trycloudflare.com");
}

async function loadSessions() {
  const response = await apiFetch("/api/sessions?limit=100");
  const data = await response.json();
  el.sessionList.innerHTML = "";
  if (!data.sessions.length) {
    el.sessionList.innerHTML = `<div class="item-meta">没有找到会话文件</div>`;
    return;
  }
  for (const session of data.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "list-item";
    button.innerHTML = `
      <span class="item-title">${escapeHtml(session.title || session.id)}</span>
      <span class="item-meta">${formatTime(session.updatedAt)} · ${Math.round(session.size / 1024)} KB</span>
    `;
    button.addEventListener("click", () => selectSession(session.id, button));
    el.sessionList.appendChild(button);
  }
}

async function selectSession(id, button) {
  for (const item of el.sessionList.querySelectorAll(".list-item")) {
    item.classList.remove("active");
  }
  button.classList.add("active");
  const response = await apiFetch(`/api/sessions/${encodeURIComponent(id)}`);
  const session = await response.json();
  el.sessionTitle.textContent = session.title || session.id;
  el.sessionMeta.textContent = `${session.updatedAt} | ${session.path}`;
  el.sessionPreview.textContent = session.preview.join("\n\n") || "这个会话没有可显示的文本预览。";
}

async function loadDesktopStatus() {
  try {
    const response = await apiFetch("/api/desktop/codex/status");
    const status = await response.json();
    setDesktopStatus(status.available ? "桌面桥可用" : "桌面桥仅支持 Windows");
  } catch (error) {
    setDesktopStatus(error.message, true);
  }
}

async function focusCodexWindow() {
  await desktopAction("/api/desktop/codex/focus", {}, "已聚焦 Codex");
}

async function pasteToCodexWindow() {
  const text = el.desktopPasteInput.value;
  if (!text.trim()) {
    setDesktopStatus("请输入要粘贴的文本", true);
    return;
  }
  const data = await desktopAction("/api/desktop/codex/paste", {
    body: JSON.stringify({ text })
  }, "已粘贴到 Codex");
  if (data?.result?.chars) {
    setDesktopStatus(`已粘贴到 Codex · ${data.result.chars} 字符`);
    el.desktopPasteInput.value = "";
  }
}

async function sendEnterToCodexWindow() {
  if (!confirm("确认发送 Enter 到 Codex？")) return;
  await desktopAction("/api/desktop/codex/send-enter", {}, "已发送 Enter");
}

async function refreshCodexScreenshot() {
  try {
    setDesktopStatus("正在刷新截图...");
    const response = await apiFetch("/api/desktop/codex/screenshot", { method: "POST" });
    const data = await response.json();
    await renderCodexScreenshot(data.result.screenshotUrl);
    setDesktopStatus(`截图已刷新 · ${data.result.width}x${data.result.height}`);
  } catch (error) {
    setDesktopStatus(error.message, true);
  }
}

async function clickCodexScreenshot(event) {
  if (!el.desktopClickModeInput.checked || el.desktopScreenshot.hidden) return;
  const rect = el.desktopScreenshot.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  const data = await desktopAction("/api/desktop/codex/click", {
    body: JSON.stringify({
      x: Number(x.toFixed(6)),
      y: Number(y.toFixed(6))
    })
  }, "已点击 Codex");
  if (data?.result?.ok) {
    setDesktopStatus(`已点击 Codex · ${Math.round(x * 100)}%, ${Math.round(y * 100)}%`);
  }
}

async function desktopAction(url, options, successMessage) {
  try {
    setDesktopStatus("正在执行...");
    const response = await apiFetch(url, { method: "POST", ...options });
    const data = await response.json();
    setDesktopStatus(successMessage);
    return data;
  } catch (error) {
    setDesktopStatus(error.message, true);
    return null;
  }
}

async function renderCodexScreenshot(url) {
  const response = await apiFetch(url);
  const blob = await response.blob();
  if (state.desktopObjectUrl) {
    URL.revokeObjectURL(state.desktopObjectUrl);
  }
  state.desktopObjectUrl = URL.createObjectURL(blob);
  el.desktopScreenshot.src = state.desktopObjectUrl;
  el.desktopScreenshot.hidden = false;
  el.desktopScreenshotEmpty.hidden = true;
}

function setDesktopStatus(message, isError = false) {
  el.desktopStatus.textContent = message;
  el.desktopStatus.classList.toggle("error", isError);
}

async function apiFetch(url, options = {}) {
  const headers = {
    "Authorization": `Bearer ${state.authValue}`,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem("codexRemoteToken");
      showLogin();
    }
    throw new Error(await readError(response));
  }
  return response;
}

async function readError(response) {
  try {
    const data = await response.json();
    return data.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

function guessWorkspace() {
  return "";
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

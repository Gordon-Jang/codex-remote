import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import express from "express";

loadDotEnv(path.join(process.cwd(), ".env"));

const app = express();
const host = process.env.CODEX_REMOTE_HOST || "127.0.0.1";
const port = Number(process.env.CODEX_REMOTE_PORT || 8765);
const requiredAuthSecret = process.env.CODEX_REMOTE_TOKEN || "";
const adminAuthSecret = process.env.CODEX_REMOTE_ADMIN_TOKEN || "";
const codexHome = resolveCodexHome();
const sessionsDir = path.join(codexHome, "sessions");
const archivedDir = path.join(codexHome, "archived_sessions");
const runtimeDir = path.join(process.cwd(), "runtime");
const screenshotsDir = path.join(runtimeDir, "screenshots");
const desktopBridgeScript = path.join(process.cwd(), "scripts", "desktop-bridge.ps1");
const desktopBridgeAvailable = process.platform === "win32";
const jobs = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(process.cwd(), "public"), {
  extensions: ["html"],
  maxAge: "5m"
}));

app.get("/api/health", (req, res) => {
  if (adminAuthSecret && req.get("authorization") !== `Bearer ${adminAuthSecret}`) {
    return res.status(401).json({ ok: false });
  }
  const body = { ok: true };
  if (adminAuthSecret) {
    body.codexHome = codexHome;
  }
  res.json(body);
});

app.post("/api/login", (req, res) => {
  const authValue = String(req.body?.token || "");
  if (!requiredAuthSecret) {
    return res.status(503).json({ error: "CODEX_REMOTE_TOKEN is not configured" });
  }
  if (!constantTimeEquals(authValue, requiredAuthSecret)) {
    return res.status(401).json({ error: "Invalid token" });
  }
  res.setHeader("Set-Cookie", buildAuthCookie(authValue));
  res.json({ ok: true });
});

app.use("/api", requireAuth);

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "codex_remote_token=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/status", async (_req, res) => {
  res.json({
    codexHome,
    runner: process.env.CODEX_REMOTE_RUNNER || "mock",
    sessionsReadable: await exists(sessionsDir),
    archivedReadable: await exists(archivedDir),
    desktopBridgeAvailable,
    canWriteAppSessions: false,
    note: "Desktop Codex sessions are treated as read-only because there is no stable public session-control API exposed here."
  });
});

app.get("/api/desktop/codex/status", (_req, res) => {
  res.json({
    available: desktopBridgeAvailable,
    platform: process.platform
  });
});

app.post("/api/desktop/codex/focus", async (_req, res) => {
  await respondWithDesktopAction(res, "focus");
});

app.post("/api/desktop/codex/screenshot", async (_req, res) => {
  await respondWithDesktopAction(res, "screenshot");
});

app.post("/api/desktop/codex/paste", async (req, res) => {
  const text = String(req.body?.text || "");
  if (!text.trim()) {
    return res.status(400).json({ error: "Text is required" });
  }
  if (text.length > 12000) {
    return res.status(400).json({ error: "Text is too long" });
  }
  await respondWithDesktopAction(res, "paste", { text });
});

app.post("/api/desktop/codex/send-enter", async (_req, res) => {
  await respondWithDesktopAction(res, "send-enter");
});

app.post("/api/desktop/codex/click", async (req, res) => {
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    return res.status(400).json({ error: "Click coordinates must be between 0 and 1" });
  }
  await respondWithDesktopAction(res, "click", { x, y });
});

app.get("/api/desktop/codex/screenshots/:name", (req, res) => {
  const name = path.basename(req.params.name);
  if (name !== req.params.name || !/^codex-\d{8}-\d{6}-\d{3}\.png$/.test(name)) {
    return res.status(404).json({ error: "Screenshot not found" });
  }
  res.sendFile(path.join(screenshotsDir, name));
});

app.get("/api/sessions", async (req, res) => {
  const includeArchived = req.query.archived === "1";
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const records = await listSessionRecords(includeArchived);
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ sessions: records.slice(0, limit) });
});

app.get("/api/sessions/:id", async (req, res) => {
  const session = await findSessionById(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  const preview = await readSessionPreview(session.path);
  res.json({ ...session, preview });
});

app.get("/api/jobs", (_req, res) => {
  res.json({ jobs: Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

app.post("/api/jobs", async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  const workspace = String(req.body?.workspace || process.cwd()).trim();
  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }
  if (prompt.length > 12000) {
    return res.status(400).json({ error: "Prompt is too long" });
  }
  const job = createJob(prompt, workspace);
  jobs.set(job.id, job);
  runJob(job);
  res.status(202).json({ job });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json({ job });
});

app.get("/api/jobs/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).end();
  }
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  sendEvent(res, "snapshot", job);
  const listener = (changedJob) => {
    if (changedJob.id === job.id) {
      sendEvent(res, "snapshot", changedJob);
    }
  };
  app.onJobUpdate(listener);
  req.on("close", () => app.offJobUpdate(listener));
});

const listeners = new Set();
app.onJobUpdate = (listener) => listeners.add(listener);
app.offJobUpdate = (listener) => listeners.delete(listener);

app.listen(port, host, () => {
  console.log(`Codex Remote listening on http://${host}:${port}`);
  if (!requiredAuthSecret) {
    console.warn("CODEX_REMOTE_TOKEN is not configured. Login will be disabled until you set it.");
  }
});

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
}

function resolveCodexHome() {
  if (process.env.CODEX_HOME) {
    return path.resolve(process.env.CODEX_HOME);
  }
  return path.join(os.homedir(), ".codex");
}

function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const cookieAuthValue = parseCookies(req.get("cookie") || "").codex_remote_token || "";
  const authValue = header.startsWith("Bearer ") ? header.slice(7) : cookieAuthValue;
  if (!requiredAuthSecret) {
    return res.status(503).json({ error: "CODEX_REMOTE_TOKEN is not configured" });
  }
  if (!constantTimeEquals(authValue, requiredAuthSecret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function buildAuthCookie(authValue) {
  const parts = [
    `codex_remote_token=${encodeURIComponent(authValue)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/api",
    "Max-Age=2592000"
  ];
  if (process.env.CODEX_REMOTE_SECURE_COOKIE === "1") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function exists(target) {
  try {
    await fs.promises.access(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function respondWithDesktopAction(res, action, options = {}) {
  try {
    const result = await runDesktopBridge(action, options);
    res.json({ result });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || "Desktop bridge failed",
      details: error.details || undefined
    });
  }
}

async function runDesktopBridge(action, options = {}) {
  if (!desktopBridgeAvailable) {
    throw httpError(501, "Desktop bridge is only available on Windows.");
  }
  if (!await exists(desktopBridgeScript)) {
    throw httpError(500, "Desktop bridge script is missing.");
  }

  let tempDir = "";
  const args = ["-Action", action];
  if (action === "screenshot") {
    await fs.promises.mkdir(screenshotsDir, { recursive: true });
    args.push("-OutDir", screenshotsDir);
  }

  if (action === "paste") {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-remote-paste-"));
    const textFile = path.join(tempDir, "prompt.txt");
    await fs.promises.writeFile(textFile, options.text, "utf8");
    args.push("-TextFile", textFile);
  }

  if (action === "click") {
    args.push("-X", String(options.x), "-Y", String(options.y));
  }

  try {
    const result = await spawnDesktopBridge(args);
    delete result.path;
    if (result.file) {
      result.screenshotUrl = `/api/desktop/codex/screenshots/${encodeURIComponent(result.file)}`;
    }
    return result;
  } finally {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }
}

function spawnDesktopBridge(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Sta",
      "-File",
      desktopBridgeScript,
      ...args
    ], {
      cwd: process.cwd(),
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(httpError(504, "Desktop bridge timed out."));
    }, 15000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(httpError(500, error.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(httpError(500, firstMeaningfulLine(stderr) || `Desktop bridge exited with code ${code}.`, firstMeaningfulLine(stdout)));
        return;
      }
      try {
        const line = stdout.split(/\r?\n/).filter(Boolean).at(-1);
        resolve(JSON.parse(line));
      } catch {
        reject(httpError(500, "Desktop bridge returned invalid JSON.", stdout.slice(0, 500)));
      }
    });
  });
}

function firstMeaningfulLine(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function httpError(status, message, details = "") {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

async function listSessionRecords(includeArchived) {
  const records = [];
  const activeFiles = await findJsonlFiles(sessionsDir);
  for (const file of activeFiles) {
    records.push(await sessionRecordFromFile(file, false));
  }

  if (includeArchived && await exists(archivedDir)) {
    const archivedFiles = await findJsonlFiles(archivedDir);
    for (const file of archivedFiles) {
      records.push(await sessionRecordFromFile(file, true));
    }
  }

  const indexed = await readSessionIndex();
  return records.map((record) => ({
    ...record,
    title: indexed.get(record.id)?.thread_name || record.title
  }));
}

async function readSessionIndex() {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const index = new Map();
  if (!await exists(indexPath)) return index;
  const text = await fs.promises.readFile(indexPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.id) index.set(item.id, item);
    } catch {
      // Ignore malformed lines; the session files remain the source of truth.
    }
  }
  return index;
}

async function findJsonlFiles(root) {
  if (!await exists(root)) return [];
  const result = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(full);
      }
    }
  }
  return result;
}

async function sessionRecordFromFile(file, archived) {
  const stat = await fs.promises.stat(file);
  const basename = path.basename(file, ".jsonl");
  const id = basename.match(/([0-9a-f]{4,}-[0-9a-f-]{8,})$/i)?.[1] || basename;
  const preview = await readFirstMeaningfulText(file);
  return {
    id,
    title: preview || id,
    path: file,
    archived,
    size: stat.size,
    updatedAt: stat.mtime.toISOString()
  };
}

async function readFirstMeaningfulText(file) {
  const lines = await readHeadLines(file, 150);
  for (const line of lines) {
    const text = extractDisplayText(line);
    if (text && text.length > 8) return text.slice(0, 120);
  }
  return "";
}

async function findSessionById(id) {
  const all = await listSessionRecords(true);
  return all.find((session) => session.id === id);
}

async function readSessionPreview(file) {
  const lines = await readTailLines(file, 120);
  const messages = [];
  for (const line of lines) {
    const text = extractDisplayText(line);
    if (text) {
      messages.push(text);
    }
  }
  return messages.slice(-30);
}

async function readHeadLines(file, maxLines) {
  const text = await fs.promises.readFile(file, "utf8");
  return text.split(/\r?\n/).slice(0, maxLines);
}

async function readTailLines(file, maxLines) {
  const text = await fs.promises.readFile(file, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines);
}

function extractDisplayText(line) {
  try {
    const item = JSON.parse(line);
    const candidates = [
      item.thread_name,
      item.message,
      item.text,
      item.content,
      item.payload?.message,
      item.payload?.text,
      item.payload?.content,
      item.item?.content,
      item.item?.message?.content
    ];
    for (const candidate of candidates) {
      const text = normalizeText(candidate);
      if (text) return text;
    }
  } catch {
    return "";
  }
  return "";
}

function normalizeText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean).join(" ").trim();
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return normalizeText(value.text);
    if (typeof value.content === "string") return normalizeText(value.content);
  }
  return "";
}

function createJob(prompt, workspace) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    prompt,
    workspace,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    logs: []
  };
}

function runJob(job) {
  const runner = process.env.CODEX_REMOTE_RUNNER || "mock";
  appendLog(job, "system", `Runner: ${runner}`);
  job.status = "running";
  touchJob(job);

  if (runner === "mock") {
    appendLog(job, "stdout", "Dry run only. Configure CODEX_REMOTE_RUNNER=command after you have a trusted Codex/agent wrapper.");
    appendLog(job, "stdout", `Prompt: ${job.prompt}`);
    job.status = "completed";
    touchJob(job);
    return;
  }

  if (runner === "powershell-echo") {
    spawnForJob(job, "powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "Write-Output ('Received remote prompt: ' + $env:CODEX_REMOTE_PROMPT)"
    ], { CODEX_REMOTE_PROMPT: job.prompt });
    return;
  }

  if (runner === "command") {
    const command = process.env.CODEX_REMOTE_COMMAND;
    if (!command) {
      appendLog(job, "stderr", "CODEX_REMOTE_COMMAND is required when CODEX_REMOTE_RUNNER=command.");
      job.status = "failed";
      touchJob(job);
      return;
    }
    const promptFile = writePromptFile(job);
    spawnForJob(job, command, [], { CODEX_REMOTE_PROMPT_FILE: promptFile });
    return;
  }

  appendLog(job, "stderr", `Unknown runner: ${runner}`);
  job.status = "failed";
  touchJob(job);
}

function writePromptFile(job) {
  const dir = path.join(os.tmpdir(), "codex-remote-prompts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${job.id}.txt`);
  fs.writeFileSync(file, job.prompt, "utf8");
  return file;
}

function spawnForJob(job, command, args, extraEnv) {
  appendLog(job, "system", `Starting process in ${job.workspace}`);
  const child = spawn(command, args, {
    cwd: job.workspace || process.cwd(),
    env: { ...process.env, ...extraEnv },
    shell: true,
    windowsHide: true
  });

  child.stdout.on("data", (chunk) => appendLog(job, "stdout", chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => appendLog(job, "stderr", chunk.toString("utf8")));
  child.on("error", (error) => {
    appendLog(job, "stderr", error.message);
    job.status = "failed";
    touchJob(job);
  });
  child.on("close", (code) => {
    appendLog(job, "system", `Process exited with code ${code}`);
    job.status = code === 0 ? "completed" : "failed";
    touchJob(job);
  });
}

function appendLog(job, stream, text) {
  const entry = {
    time: new Date().toISOString(),
    stream,
    text: String(text).slice(0, 8000)
  };
  job.logs.push(entry);
  if (job.logs.length > 500) {
    job.logs.splice(0, job.logs.length - 500);
  }
  touchJob(job);
}

function touchJob(job) {
  job.updatedAt = new Date().toISOString();
  for (const listener of listeners) {
    listener(job);
  }
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

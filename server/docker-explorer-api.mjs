/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 *
 * Local API: bridges Docker CLI for container file operations.
 * Run on the same machine as Docker Desktop / daemon. Bind to localhost only.
 */
import express from "express";
import cors from "cors";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

const MAX_READ_BYTES = 5 * 1024 * 1024;

/** JSON body limit for PUT /file (align with editor + MAX_READ_BYTES headroom). */
const MAX_WRITE_JSON_BYTES = "20mb";

/** Server-side blocked extensions for text read/write via API (download still allowed) */
const DEFAULT_BLOCKED = new Set([
  "exe",
  "dll",
  "so",
  "dylib",
  "bat",
  "cmd",
  "msi",
  "scr",
  "com",
  "pif",
  "sys",
  "drv",
  "jar",
  "war",
  "ear",
  "ps1",
  "vbs",
  "wsf",
  "msc",
  "hta",
  "bin",
]);

function extOf(p) {
  const base = path.basename(p);
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i + 1).toLowerCase();
}

function isBlockedExt(ext, extraBlocked) {
  const e = (ext || "").toLowerCase().replace(/^\./, "");
  if (DEFAULT_BLOCKED.has(e)) return true;
  for (const b of extraBlocked || []) {
    if (b && e === String(b).toLowerCase().replace(/^\./, "")) return true;
  }
  return false;
}

/** Container inspect has no `.Os`; use Platform and/or image inspect (`.Os`). */
function osFromPlatformValue(plat) {
  if (plat == null) return null;
  if (typeof plat === "string") {
    if (!plat.trim()) return null;
    const first = plat.toLowerCase().split("/")[0] ?? "";
    if (first === "windows") return "windows";
    if (first === "linux") return "linux";
    if (plat.toLowerCase().includes("windows")) return "windows";
    return "linux";
  }
  if (typeof plat === "object") {
    const o = plat.OS ?? plat.os;
    if (typeof o === "string") {
      return o.toLowerCase() === "windows" ? "windows" : "linux";
    }
  }
  return null;
}

function firstInspectObject(stdout) {
  const t = stripBom(stdout.trim());
  const parsed = JSON.parse(t);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

async function dockerInspectOs(containerId) {
  const { stdout } = await execFileAsync(
    "docker",
    ["inspect", "--format", "{{json .}}", containerId],
    { encoding: "utf8" }
  );
  let data;
  try {
    data = firstInspectObject(stdout);
  } catch {
    return "linux";
  }
  const fromPlat = osFromPlatformValue(data?.Platform);
  if (fromPlat) return fromPlat;
  const imageRef = data?.Image;
  if (typeof imageRef === "string" && imageRef.length > 0) {
    try {
      const { stdout: imgOut } = await execFileAsync(
        "docker",
        ["image", "inspect", "--format", "{{.Os}}", imageRef],
        { encoding: "utf8" }
      );
      const t = imgOut.trim().toLowerCase();
      return t === "windows" ? "windows" : "linux";
    } catch {
      /* ignore */
    }
  }
  return "linux";
}

async function listContainers() {
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "--format",
    "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
  ]);
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length >= 4) {
      out.push({
        id: parts[0],
        name: parts[1],
        image: parts[2],
        status: parts.slice(3).join("\t"),
      });
    }
  }
  return out;
}

/**
 * Windows container paths must not be passed raw in `docker exec -e VAR=value`:
 * segments like `-c` inside `apache-tomcat-configuired\...` can be misparsed by the
 * Docker CLI / runtime and corrupt the path (e.g. spaces inserted). Pass UTF-8
 * paths as Base64 in `*_B64` env vars and decode inside PowerShell.
 */
const PS_ENV_LIST_B64 = "DEXP_LIST_PATH_B64";
const PS_ENV_DELETE_B64 = "DEXP_DELETE_PATH_B64";
const PS_ENV_READ_B64 = "DEXP_READ_PATH_B64";
const PS_ENV_MAX_READ = "DEXP_MAX_READ_BYTES";
const PS_ENV_WRITE_B64 = "DEXP_WRITE_PATH_B64";
const PS_ENV_COPY_FROM_B64 = "DEXP_COPY_FROM_B64";
const PS_ENV_COPY_TO_B64 = "DEXP_COPY_TO_B64";

function winPathToDockerEnvB64(containerPath) {
  return Buffer.from(containerPath, "utf8").toString("base64");
}

/** `$p` = decoded path from Base64 env (must match PS_ENV_*_B64 name). */
function psDecodePathFromB64Env(envB64Name) {
  return `$p=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:${envB64Name}))`;
}

async function dockerExecPowershellWithPathB64(
  containerId,
  envB64Name,
  containerPath,
  psCommand,
  execOptions = {}
) {
  const b64 = winPathToDockerEnvB64(containerPath);
  return execFileAsync(
    "docker",
    [
      "exec",
      "-e",
      `${envB64Name}=${b64}`,
      containerId,
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      psCommand,
    ],
    { encoding: "utf8", ...execOptions }
  );
}

/**
 * Hyper-V isolated Windows containers often reject `docker cp` while running;
 * read file bytes via PowerShell inside the container.
 */
async function readFileBytesFromWindowsContainer(containerId, containerPath) {
  // FileShare.ReadWrite: Tomcat log files stay open for write; ReadAllBytes fails without share.
  const ps = [
    "$ErrorActionPreference='Stop'",
    psDecodePathFromB64Env(PS_ENV_READ_B64),
    `$max=[int64]$env:${PS_ENV_MAX_READ}`,
    "if (-not $p) { throw 'read path empty' }",
    "$fs=New-Object System.IO.FileStream($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)",
    "try { if ($fs.Length -gt $max) { throw [System.IO.IOException]('file too large: ' + $fs.Length + ' bytes') }; $len=[int]$fs.Length; $bytes=New-Object byte[] $len; [void]$fs.Read($bytes, 0, $len) } finally { $fs.Dispose() }",
    "[Convert]::ToBase64String($bytes)",
  ].join(";");
  const readB64 = winPathToDockerEnvB64(containerPath);
  const { stdout } = await execFileAsync(
    "docker",
    [
      "exec",
      "-e",
      `${PS_ENV_READ_B64}=${readB64}`,
      "-e",
      `${PS_ENV_MAX_READ}=${String(MAX_READ_BYTES)}`,
      containerId,
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ],
    {
      encoding: "utf8",
      maxBuffer: Math.ceil(MAX_READ_BYTES * 1.4) + 1024 * 1024,
    }
  );
  const b64 = stdout.replace(/\s/g, "");
  return Buffer.from(b64, "base64");
}

/** Write UTF-8 file via stdin (avoids `docker cp` on Hyper-V Windows containers). */
async function writeUtf8FileToWindowsContainer(containerId, containerPath, utf8Text) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    psDecodePathFromB64Env(PS_ENV_WRITE_B64),
    "if (-not $p) { throw 'write path empty' }",
    "$ms=New-Object System.IO.MemoryStream",
    "$in=[System.Console]::OpenStandardInput()",
    "$b=New-Object byte[] 65536",
    "while ($true) { $n = $in.Read($b, 0, $b.Length); if ($n -eq 0) { break }; [void]$ms.Write($b, 0, $n) }",
    "[System.IO.File]::WriteAllBytes($p, $ms.ToArray())",
  ].join(";");
  const writeB64 = winPathToDockerEnvB64(containerPath);
  await execFileAsync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      `${PS_ENV_WRITE_B64}=${writeB64}`,
      containerId,
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ],
    {
      encoding: "utf8",
      input: Buffer.from(utf8Text ?? "", "utf8"),
      // stderr from PowerShell can exceed 64KiB on some hosts; tiny maxBuffer caused false failures.
      maxBuffer: 4 * 1024 * 1024,
      // No hard kill while streaming large stdin into docker exec.
      timeout: 0,
    }
  );
}

function stripBom(s) {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

/** Parse PowerShell JSON output (handles BOM / stray lines). */
function parsePsJson(stdout) {
  const t = stripBom(stdout.trim());
  if (!t) return [];
  try {
    const data = JSON.parse(t);
    if (data == null) return [];
    return Array.isArray(data) ? data : [data];
  } catch {
    const i = t.indexOf("[");
    const j = t.lastIndexOf("]");
    if (i >= 0 && j > i) {
      return JSON.parse(t.slice(i, j + 1));
    }
    throw new Error(`Invalid JSON from PowerShell: ${t.slice(0, 200)}`);
  }
}

/** Line-based listing (avoids JSON edge cases with special file names). */
async function listDirWindowsTsv(containerId, dirPath) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    psDecodePathFromB64Env(PS_ENV_LIST_B64),
    "if (-not $p) { throw 'list path env empty' }",
    "Get-ChildItem -LiteralPath $p -Force | ForEach-Object { ($_.Name -replace [char]9,' ') + [char]9 + $(if($_.PSIsContainer){1}else{0}) + [char]9 + [int64]$_.Length + [char]9 + $_.LastWriteTimeUtc.ToString('o') }",
  ].join(";");
  const { stdout, stderr } = await dockerExecPowershellWithPathB64(
    containerId,
    PS_ENV_LIST_B64,
    dirPath,
    ps
  );
  if (stderr && /not found|cannot find/i.test(stderr)) {
    throw new Error(stderr.trim());
  }
  const lines = stripBom(stdout).split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    const parts = line.split("\t");
    const name = parts[0] ?? "";
    const isDirectory = parts[1] === "1" || parts[1] === "True";
    const size = parseInt(parts[2] ?? "0", 10) || 0;
    const mtime = parts[3] ?? "";
    return { name, isDirectory, size, mtime };
  });
}

/** CMD-quoted path (always quote — unquoted paths can be mis-parsed). */
function cmdQuotedWinPath(dirPath) {
  const normalized =
    /^[A-Za-z]:$/.test(dirPath) ? `${dirPath}\\` : dirPath;
  return `"${normalized.replace(/"/g, '""')}"`;
}

/** `dir /a:d /b` + `dir /a /b` — works when PowerShell is missing (Nano Server). */
async function listDirWindowsCmd(containerId, dirPath) {
  const forCmd = cmdQuotedWinPath(dirPath);
  const { stdout: dirsOut } = await execFileAsync(
    "docker",
    ["exec", containerId, "cmd.exe", "/s", "/c", `dir /a:d /b ${forCmd}`],
    { encoding: "utf8" }
  );
  const { stdout: allOut } = await execFileAsync(
    "docker",
    ["exec", containerId, "cmd.exe", "/s", "/c", `dir /a /b ${forCmd}`],
    { encoding: "utf8" }
  );
  const dirSet = new Set(
    dirsOut
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const names = allOut
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((n) => n !== "." && n !== "..");
  return names.map((name) => ({
    name,
    isDirectory: dirSet.has(name),
    size: 0,
    mtime: "",
  }));
}

async function listDirWindowsJson(containerId, dirPath) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8`,
    `$OutputEncoding=[Text.UTF8Encoding]::UTF8`,
    psDecodePathFromB64Env(PS_ENV_LIST_B64),
    "if (-not $p) { throw 'list path env empty' }",
    "Get-ChildItem -LiteralPath $p -Force | Select-Object @{n='name';e={$_.Name}},@{n='isDir';e={$_.PSIsContainer}},@{n='size';e={[int64]$_.Length}},@{n='mtime';e={$_.LastWriteTimeUtc.ToString('o')}} | ConvertTo-Json -Compress -Depth 4",
  ].join(";");
  const { stdout } = await dockerExecPowershellWithPathB64(
    containerId,
    PS_ENV_LIST_B64,
    dirPath,
    ps
  );
  const arr = parsePsJson(stdout);
  return arr.map((x) => ({
    name: x.name,
    isDirectory: !!x.isDir,
    size: x.size ?? 0,
    mtime: x.mtime ?? "",
  }));
}

async function listDirWindows(containerId, dirPath) {
  try {
    return await listDirWindowsTsv(containerId, dirPath);
  } catch (e1) {
    try {
      return await listDirWindowsJson(containerId, dirPath);
    } catch (e2) {
      try {
        return await listDirWindowsCmd(containerId, dirPath);
      } catch (e3) {
        const msg = [e1, e2, e3]
          .map((e) => e?.message || String(e))
          .join(" | ");
        throw new Error(`Windows list failed: ${msg}`);
      }
    }
  }
}

function quoteSh(s) {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

function backupTimestampYyyyMMddHHmm() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes())
  );
}

function normalizedContainerPath(filePath, platform) {
  return platform === "windows"
    ? filePath.replace(/\//g, "\\")
    : filePath.replace(/\\/g, "/");
}

/** Same folder: `{name}_{yyyyMMddHHmm}{ext}`; null if not .yml / .yaml. */
function siblingYamlBackupPath(filePath, platform, ts) {
  const norm = normalizedContainerPath(filePath, platform);
  const parse =
    platform === "windows" ? path.win32.parse(norm) : path.posix.parse(norm);
  const extRaw = (parse.ext || "").slice(1).toLowerCase();
  if (extRaw !== "yml" && extRaw !== "yaml") return null;
  const join = platform === "windows" ? path.win32.join : path.posix.join;
  const backupName = `${parse.name}_${ts}${parse.ext}`;
  return join(parse.dir || (platform === "windows" ? "\\" : "/"), backupName);
}

async function copyFileInsideWindowsContainerIfExists(
  containerId,
  fromPath,
  toPath
) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$pFrom=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:${PS_ENV_COPY_FROM_B64}))`,
    `$pTo=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:${PS_ENV_COPY_TO_B64}))`,
    "if (-not $pFrom -or -not $pTo) { throw 'copy paths empty' }",
    "if (Test-Path -LiteralPath $pFrom) { Copy-Item -LiteralPath $pFrom -Destination $pTo -Force }",
  ].join(";");
  const fromB64 = winPathToDockerEnvB64(fromPath);
  const toB64 = winPathToDockerEnvB64(toPath);
  await execFileAsync(
    "docker",
    [
      "exec",
      "-e",
      `${PS_ENV_COPY_FROM_B64}=${fromB64}`,
      "-e",
      `${PS_ENV_COPY_TO_B64}=${toB64}`,
      containerId,
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 0 }
  );
}

async function copyFileInsideLinuxContainerIfExists(
  containerId,
  fromPath,
  toPath
) {
  const inner = `if [ -f ${quoteSh(fromPath)} ]; then cp ${quoteSh(
    fromPath
  )} ${quoteSh(toPath)}; fi`;
  await execFileAsync(
    "docker",
    ["exec", containerId, "sh", "-c", inner],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 0 }
  );
}

/** Before overwriting .yml/.yaml, copy existing file beside it (skipped if missing). */
async function backupYamlSiblingBeforeSave(containerId, filePath, platform) {
  const ts = backupTimestampYyyyMMddHHmm();
  const dest = siblingYamlBackupPath(filePath, platform, ts);
  if (!dest) return;
  const src = normalizedContainerPath(filePath, platform);
  if (platform === "windows") {
    await copyFileInsideWindowsContainerIfExists(containerId, src, dest);
  } else {
    await copyFileInsideLinuxContainerIfExists(containerId, src, dest);
  }
}

async function listDirLinux(containerId, dirPath) {
  try {
    const inner = `find ${quoteSh(dirPath)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%s\\t%T@\\n'`;
    const { stdout } = await execFileAsync(
      "docker",
      ["exec", containerId, "sh", "-c", inner],
      { encoding: "utf8" }
    );
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    return lines.map((line) => {
      const [name, type, size, mtime] = line.split("\t");
      return {
        name,
        isDirectory: type === "d",
        size: parseInt(size, 10) || 0,
        mtime: mtime || "",
      };
    });
  } catch {
    const { stdout } = await execFileAsync(
      "docker",
      ["exec", containerId, "ls", "-1", dirPath],
      { encoding: "utf8" }
    );
    return stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((name) => ({ name, isDirectory: false, size: 0, mtime: "" }));
  }
}

async function dockerCpFromContainer(containerId, containerPath, hostPath) {
  const spec =
    (await dockerInspectOs(containerId)) === "windows"
      ? `${containerId}:${containerPath.replace(/\//g, "\\")}`
      : `${containerId}:${containerPath}`;
  await execFileAsync("docker", ["cp", spec, hostPath]);
}

async function dockerCpToContainer(hostPath, containerId, containerPath) {
  const osName = await dockerInspectOs(containerId);
  const dest =
    osName === "windows"
      ? `${containerId}:${containerPath.replace(/\//g, "\\")}`
      : `${containerId}:${containerPath}`;
  await execFileAsync("docker", ["cp", hostPath, dest]);
}

async function deleteInContainer(containerId, containerPath, platform) {
  if (platform === "windows") {
    const ps = [
      "$ErrorActionPreference='Stop'",
      psDecodePathFromB64Env(PS_ENV_DELETE_B64),
      "if (-not $p) { throw 'delete path env empty' }",
      "Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop",
    ].join(";");
    await dockerExecPowershellWithPathB64(
      containerId,
      PS_ENV_DELETE_B64,
      containerPath,
      ps
    );
  } else {
    await execFileAsync("docker", [
      "exec",
      containerId,
      "rm",
      "-rf",
      containerPath,
    ]);
  }
}

function tmpFile() {
  return path.join(os.tmpdir(), `dexp-${crypto.randomBytes(8).toString("hex")}`);
}

const MAX_EXEC_OUTPUT_CHARS = 400_000;

function truncateOut(s) {
  if (!s || s.length <= MAX_EXEC_OUTPUT_CHARS) return s || "";
  return `${s.slice(0, MAX_EXEC_OUTPUT_CHARS)}\n... (output truncated)`;
}

/**
 * One-shot command in container (not a PTY). `command` is a single argv to cmd/sh — avoids host shell injection.
 */
async function execInContainer(containerId, platform, cwd, command, shell) {
  const cmd = String(command ?? "").trim();
  if (!cmd) {
    throw new Error("command required");
  }
  if (cmd.length > 32 * 1024) {
    throw new Error("command too long");
  }
  const args = ["exec"];
  const wd = cwd != null ? String(cwd).trim() : "";
  if (wd) {
    args.push("-w", wd);
  }
  args.push(containerId);

  if (platform === "windows") {
    const sh = shell === "powershell" ? "powershell" : "cmd";
    if (sh === "powershell") {
      args.push(
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        cmd
      );
    } else {
      args.push("cmd.exe", "/s", "/c", cmd);
    }
  } else {
    args.push("sh", "-c", cmd);
  }

  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      encoding: "utf8",
      maxBuffer: 12 * 1024 * 1024,
    });
    return {
      stdout: truncateOut(stdout),
      stderr: truncateOut(stderr),
      exitCode: 0,
    };
  } catch (e) {
    const stdout = truncateOut(
      e.stdout != null ? String(e.stdout) : ""
    );
    const stderr = truncateOut(
      e.stderr != null ? String(e.stderr) : String(e?.message || e)
    );
    const code =
      typeof e.code === "number" && !Number.isNaN(e.code) ? e.code : 1;
    return { stdout, stderr, exitCode: code };
  }
}

export function createApp() {
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: MAX_WRITE_JSON_BYTES }));
  // Avoid Node default short socket timeouts on long docker exec + large bodies.
  const longMs = 15 * 60 * 1000;
  app.use((req, res, next) => {
    req.setTimeout(longMs);
    res.setTimeout(longMs);
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "TigerClawDockerManager" });
  });

  app.get("/api/containers", async (_req, res) => {
    try {
      const containers = await listContainers();
      const detailed = [];
      for (const c of containers) {
        let platform = "linux";
        try {
          platform = await dockerInspectOs(c.id);
        } catch {
          /* ignore */
        }
        detailed.push({ ...c, platform });
      }
      res.json({ containers: detailed });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/container/:id/info", async (req, res) => {
    try {
      const platform = await dockerInspectOs(req.params.id);
      res.json({ id: req.params.id, platform });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/container/:id/list", async (req, res) => {
    const dirPath = req.query.path;
    if (!dirPath || typeof dirPath !== "string") {
      return res.status(400).json({ error: "path query required" });
    }
    try {
      const platform = await dockerInspectOs(req.params.id);
      const entries =
        platform === "windows"
          ? await listDirWindows(req.params.id, dirPath)
          : await listDirLinux(req.params.id, dirPath);
      res.json({ path: dirPath, entries, platform });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/container/:id/file", async (req, res) => {
    const filePath = req.query.path;
    const extraBlocked = req.query.block?.split(",").filter(Boolean) || [];
    if (!filePath || typeof filePath !== "string") {
      return res.status(400).json({ error: "path query required" });
    }
    const ext = extOf(filePath);
    if (isBlockedExt(ext, extraBlocked)) {
      return res.status(403).json({ error: "File type not allowed" });
    }
    try {
      const platform = await dockerInspectOs(req.params.id);
      let buf;
      if (platform === "windows") {
        buf = await readFileBytesFromWindowsContainer(req.params.id, filePath);
      } else {
        const hostTmp = tmpFile();
        try {
          await dockerCpFromContainer(req.params.id, filePath, hostTmp);
          const st = await fs.stat(hostTmp);
          if (st.size > MAX_READ_BYTES) {
            await fs.unlink(hostTmp).catch(() => {});
            return res.status(413).json({ error: "File too large" });
          }
          buf = await fs.readFile(hostTmp);
        } finally {
          await fs.unlink(hostTmp).catch(() => {});
        }
      }
      if (buf.length > MAX_READ_BYTES) {
        return res.status(413).json({ error: "File too large" });
      }
      const text = buf.toString("utf8");
      const extLower = extOf(filePath);
      const forceText =
        extLower === "log" || extLower === "out" || extLower === "trace";
      const looksBinary = forceText
        ? false
        : /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text.slice(0, 4096));
      res.json({
        path: filePath,
        content: looksBinary ? null : text,
        binary: looksBinary,
        size: buf.length,
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/container/:id/file", async (req, res) => {
    const { path: filePath, content, extraBlocked = [] } = req.body || {};
    if (!filePath || typeof filePath !== "string") {
      return res.status(400).json({ error: "path required" });
    }
    const ext = extOf(filePath);
    if (isBlockedExt(ext, extraBlocked)) {
      return res.status(403).json({ error: "File type not allowed" });
    }
    try {
      const platform = await dockerInspectOs(req.params.id);
      await backupYamlSiblingBeforeSave(req.params.id, filePath, platform);
      if (platform === "windows") {
        await writeUtf8FileToWindowsContainer(
          req.params.id,
          filePath,
          content ?? ""
        );
      } else {
        const hostTmp = tmpFile();
        try {
          await fs.writeFile(hostTmp, content ?? "", "utf8");
          await dockerCpToContainer(hostTmp, req.params.id, filePath);
        } finally {
          await fs.unlink(hostTmp).catch(() => {});
        }
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.delete("/api/container/:id/file", async (req, res) => {
    const targetPath = req.query.path;
    if (!targetPath || typeof targetPath !== "string") {
      return res.status(400).json({ error: "path query required" });
    }
    try {
      const platform = await dockerInspectOs(req.params.id);
      await deleteInContainer(req.params.id, targetPath, platform);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/container/:id/download", async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== "string") {
      return res.status(400).json({ error: "path query required" });
    }
    try {
      const platform = await dockerInspectOs(req.params.id);
      const name = path.basename(filePath.replace(/\\/g, "/"));
      if (platform === "windows") {
        const buf = await readFileBytesFromWindowsContainer(
          req.params.id,
          filePath
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${name.replace(/"/g, "")}"`
        );
        res.type("application/octet-stream");
        res.send(buf);
      } else {
        const hostTmp = tmpFile();
        try {
          await dockerCpFromContainer(req.params.id, filePath, hostTmp);
          res.download(hostTmp, name, (err) => {
            fs.unlink(hostTmp).catch(() => {});
            if (err && !res.headersSent) res.status(500).end();
          });
        } catch (e) {
          await fs.unlink(hostTmp).catch(() => {});
          throw e;
        }
      }
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post("/api/container/:id/exec", async (req, res) => {
    const { command, cwd, shell } = req.body || {};
    if (!command || typeof command !== "string") {
      return res.status(400).json({ error: "command required" });
    }
    const cwdStr =
      cwd != null && typeof cwd === "string" ? cwd : undefined;
    const shellStr =
      shell === "powershell" || shell === "cmd" || shell === "sh"
        ? shell
        : undefined;
    try {
      const platform = await dockerInspectOs(req.params.id);
      const resolvedShell =
        platform === "windows"
          ? shellStr === "powershell"
            ? "powershell"
            : "cmd"
          : "sh";
      const result = await execInContainer(
        req.params.id,
        platform,
        cwdStr,
        command,
        resolvedShell
      );
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return app;
}

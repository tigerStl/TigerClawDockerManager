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
import { execFile, spawn } from "child_process";
import { once } from "events";
import { promisify } from "util";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import multer from "multer";
import extract from "extract-zip";

const execFileAsync = promisify(execFile);

const MAX_READ_BYTES = 5 * 1024 * 1024;

/** JSON body limit for PUT /file (align with editor + MAX_READ_BYTES headroom). */
const MAX_WRITE_JSON_BYTES = "20mb";

/** Server-side: block writes for these (includes scripts). */
const DEFAULT_BLOCKED_WRITE = new Set([
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

/** Server-side: block reads for GET /file only (bat/cmd/ps1 allowed for browse / view-only). Download route has no extension block. */
const DEFAULT_BLOCKED_READ = new Set(
  [...DEFAULT_BLOCKED_WRITE].filter((x) => x !== "bat" && x !== "cmd" && x !== "ps1")
);

function extOf(p) {
  const base = path.basename(p);
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i + 1).toLowerCase();
}

function isBlockedExtRead(ext, extraBlocked) {
  const e = (ext || "").toLowerCase().replace(/^\./, "");
  if (DEFAULT_BLOCKED_READ.has(e)) return true;
  for (const b of extraBlocked || []) {
    if (b && e === String(b).toLowerCase().replace(/^\./, "")) return true;
  }
  return false;
}

function isBlockedExtWrite(ext, extraBlocked) {
  const e = (ext || "").toLowerCase().replace(/^\./, "");
  if (DEFAULT_BLOCKED_WRITE.has(e)) return true;
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
const PS_ENV_MKDIR_B64 = "DEXP_MKDIR_PATH_B64";
const PS_ENV_STAT_B64 = "DEXP_STAT_PATH_B64";

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

/**
 * Write raw bytes via stdin to a path inside a Windows container (avoids `docker cp`).
 * Required for Hyper-V–isolated Windows containers: `docker cp` to a running container often fails with
 * "filesystem operations against a running Hyper-V container are not supported".
 */
async function writeBytesFileToWindowsContainer(containerId, containerPath, buffer) {
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
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  const args = [
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
  ];

  /** `execFile({ input })` is unreliable for large/stdin payloads to `docker exec` on some Windows hosts; stream explicitly. */
  const child = spawn("docker", args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errText = "";
  child.stderr?.on("data", (chunk) => {
    errText += String(chunk);
  });
  child.stdout?.on("data", (chunk) => {
    errText += String(chunk);
  });

  try {
    await pipeline(Readable.from(buf), child.stdin);
  } catch (e) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    throw e;
  }

  const [code] = await once(child, "close");
  if (code !== 0) {
    const tail = errText.trim().slice(0, 4000);
    throw new Error(
      `docker exec failed writing file (exit ${code}): ${tail || "(no output)"}`
    );
  }
}

/** Write UTF-8 text (same transport as binary — avoids `docker cp` on Hyper-V Windows containers). */
async function writeUtf8FileToWindowsContainer(containerId, containerPath, utf8Text) {
  await writeBytesFileToWindowsContainer(
    containerId,
    containerPath,
    Buffer.from(utf8Text ?? "", "utf8")
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
    "Get-ChildItem -LiteralPath $p -Force | ForEach-Object { $sz = if ($_.PSIsContainer) { [int64]0 } else { [int64]($_.Length) }; ($_.Name -replace [char]9,' ') + [char]9 + $(if($_.PSIsContainer){1}else{0}) + [char]9 + $sz + [char]9 + $_.LastWriteTimeUtc.ToString('o') }",
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

/**
 * One line from `cmd.exe dir /a` (non-/b) — extracts name, dir flag, file size.
 * Locale/date formats vary; we key off `<DIR>` and a trailing "size name" tail.
 */
function parseWindowsDirListingLine(line) {
  const t = line.replace(/\r$/, "").trimEnd();
  const trimmed = t.trim();
  if (!trimmed) return null;
  const low = trimmed.toLowerCase();
  if (
    low.includes("bytes free") ||
    (low.includes("file(s)") && low.includes("bytes")) ||
    low.includes("dir(s)")
  ) {
    return null;
  }
  if (/^(volume|驱动器)/i.test(trimmed) || /directory of/i.test(trimmed)) {
    return null;
  }

  const dirIdx = trimmed.search(/\s<DIR>\s+/i);
  if (dirIdx >= 0) {
    const name = trimmed.slice(dirIdx).replace(/^\s*<DIR>\s+/i, "").trim();
    if (!name || name === "." || name === "..") return null;
    return { name, isDirectory: true, size: 0, mtime: "" };
  }

  const fileTail = trimmed.match(/\s([\d,]+)\s+(\S(?:.*\S)?)\s*$/);
  if (!fileTail) return null;
  if (!/^\d/.test(trimmed)) return null;
  const size = parseInt(fileTail[1].replace(/,/g, ""), 10);
  if (!Number.isFinite(size) || size < 0) return null;
  const name = fileTail[2].trim();
  if (!name || name === "." || name === "..") return null;
  return { name, isDirectory: false, size, mtime: "" };
}

/** `dir /a` full listing — works when PowerShell is missing (Nano Server). Parses sizes from standard dir output. */
async function listDirWindowsCmd(containerId, dirPath) {
  const forCmd = cmdQuotedWinPath(dirPath);
  const { stdout } = await execFileAsync(
    "docker",
    ["exec", containerId, "cmd.exe", "/s", "/c", `dir /a ${forCmd}`],
    { encoding: "utf8" }
  );
  const seen = new Set();
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const row = parseWindowsDirListingLine(line);
    if (!row) continue;
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    out.push(row);
  }
  return out;
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
  /** GNU find -printf (fast). BusyBox find often lacks -printf — then all sizes were 0 via ls fallback. */
  const tryGnuFind = `find ${quoteSh(dirPath)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%s\\t%T@\\n' 2>/dev/null`;
  /** Portable: find names + stat for size/mtime (BusyBox/GNU). */
  const portableStat =
    "find " +
    quoteSh(dirPath) +
    " -mindepth 1 -maxdepth 1 2>/dev/null | while IFS= read -r p; do " +
    '[ -e "$p" ] || continue; b=$(basename "$p"); ' +
    'if [ -d "$p" ]; then t=d; else t=f; fi; ' +
    'sz=$(stat -c %s "$p" 2>/dev/null || echo 0); ' +
    'mt=$(stat -c %Y "$p" 2>/dev/null || echo 0); ' +
    "printf '%s\\t%s\\t%s\\t%s\\n' \"$b\" \"$t\" \"$sz\" \"$mt\"; " +
    "done";

  function mapLines(lines) {
    return lines.map((line) => {
      const parts = line.split("\t");
      const name = parts[0] ?? "";
      const type = parts[1] ?? "";
      const size = parseInt(parts[2] ?? "0", 10) || 0;
      const rawMt = parts[3] ?? "";
      let mtime = rawMt;
      if (/^\d+(\.\d+)?$/.test(rawMt.trim())) {
        const sec = parseFloat(rawMt);
        if (Number.isFinite(sec)) {
          mtime = new Date(sec * 1000).toISOString();
        }
      }
      return {
        name,
        isDirectory: type === "d",
        size,
        mtime,
      };
    });
  }

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["exec", containerId, "sh", "-c", tryGnuFind],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    );
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length > 0) {
      return mapLines(lines);
    }
  } catch {
    /* try portable */
  }

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["exec", containerId, "sh", "-c", portableStat],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    );
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length > 0) {
      return mapLines(lines);
    }
  } catch {
    /* last resort */
  }

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

async function dockerCpFromContainer(containerId, containerPath, hostPath) {
  const spec =
    (await dockerInspectOs(containerId)) === "windows"
      ? `${containerId}:${containerPath.replace(/\//g, "\\")}`
      : `${containerId}:${containerPath}`;
  await execFileAsync("docker", ["cp", spec, hostPath]);
}

async function dockerCpToContainer(hostPath, containerId, containerPath) {
  const osName = await dockerInspectOs(containerId);
  if (osName === "windows") {
    const buf = await fs.readFile(hostPath);
    await writeBytesFileToWindowsContainer(
      containerId,
      containerPath.replace(/\//g, "\\"),
      buf
    );
    return;
  }
  const dest = `${containerId}:${containerPath}`;
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

/** Max single archive or per-file size for folder upload (bytes). */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

function sanitizeRelativePath(originalname) {
  const norm = String(originalname || "")
    .replace(/\\/g, "/")
    .replace(/^\//, "")
    .trim();
  const parts = norm.split("/").filter((p) => p && p !== "..");
  if (!parts.length) {
    throw new Error("invalid relative path");
  }
  return path.join(...parts);
}

function normalizeContainerTargetPath(targetPath, platform) {
  const t = String(targetPath || "").trim();
  if (!t) {
    throw new Error("targetPath required");
  }
  if (t.includes("..")) {
    throw new Error("targetPath must not contain '..'");
  }
  return platform === "windows"
    ? t.replace(/\//g, "\\")
    : t.replace(/\\/g, "/");
}

async function ensureDirectoryInContainer(containerId, containerPath, platform) {
  if (platform === "windows") {
    const ps = [
      "$ErrorActionPreference='Stop'",
      psDecodePathFromB64Env(PS_ENV_MKDIR_B64),
      "if (-not $p) { throw 'mkdir path empty' }",
      "New-Item -ItemType Directory -Force -Path $p | Out-Null",
    ].join(";");
    const b64 = winPathToDockerEnvB64(containerPath);
    await execFileAsync(
      "docker",
      [
        "exec",
        "-e",
        `${PS_ENV_MKDIR_B64}=${b64}`,
        containerId,
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        ps,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 0 }
    );
  } else {
    await execFileAsync(
      "docker",
      ["exec", containerId, "mkdir", "-p", containerPath],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 0 }
    );
  }
}

async function extractZipOnHost(zipPath, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  await extract(zipPath, { dir: destDir });
}

/**
 * Copy a host directory tree into a container destination.
 * Linux: `docker cp`. Windows: walk files and stream each via exec (Hyper-V containers reject `docker cp`).
 */
async function dockerCpHostDirContentsToContainer(
  hostDir,
  containerId,
  containerDestDir,
  containerPlatform
) {
  const resolved = path.resolve(hostDir);
  if (containerPlatform === "windows") {
    const rootWin = containerDestDir.replace(/\//g, "\\");
    await copyHostTreeIntoWindowsContainer(containerId, resolved, rootWin);
    return;
  }
  const hostSrc = path.join(resolved, ".");
  const dest = `${containerId}:${containerDestDir}`;
  await execFileAsync(
    "docker",
    ["cp", hostSrc, dest],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 0 }
  );
}

/** Recursively copy host folder into a Windows container without `docker cp`. */
async function copyHostTreeIntoWindowsContainer(
  containerId,
  hostRootAbs,
  containerRootWin
) {
  const root = path.resolve(hostRootAbs);
  const cr = containerRootWin;

  async function walk(currentHost) {
    const ents = await fs.readdir(currentHost, { withFileTypes: true });
    for (const ent of ents) {
      const hostFull = path.join(currentHost, ent.name);
      const rel = path.relative(root, hostFull);
      const parts = rel.split(/[/\\]+/).filter(Boolean);
      const containerPath = path.win32.join(cr, ...parts);
      if (ent.isDirectory()) {
        await ensureDirectoryInContainer(containerId, containerPath, "windows");
        await walk(hostFull);
      } else {
        await ensureDirectoryInContainer(
          containerId,
          path.win32.dirname(containerPath),
          "windows"
        );
        const buf = await fs.readFile(hostFull);
        await writeBytesFileToWindowsContainer(containerId, containerPath, buf);
      }
    }
  }

  await ensureDirectoryInContainer(containerId, cr, "windows");
  await walk(root);
}

const zipMulter = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, os.tmpdir());
    },
    filename(_req, _file, cb) {
      cb(null, `dexp-${crypto.randomBytes(12).toString("hex")}.zip`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const fileMulter = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, os.tmpdir());
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || "") || ".bin";
      cb(null, `dexp-${crypto.randomBytes(12).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

function createTreeMulter(stagingBase) {
  return multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        try {
          const rel = sanitizeRelativePath(file.originalname);
          const destDir = path.join(stagingBase, path.dirname(rel));
          fs.mkdir(destDir, { recursive: true })
            .then(() => cb(null, destDir))
            .catch(cb);
        } catch (e) {
          cb(e);
        }
      },
      filename(_req, file, cb) {
        try {
          const rel = sanitizeRelativePath(file.originalname);
          cb(null, path.basename(rel));
        } catch (e) {
          cb(e);
        }
      },
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES },
  });
}

const MAX_EXEC_OUTPUT_CHARS = 400_000;

function truncateOut(s) {
  if (!s || s.length <= MAX_EXEC_OUTPUT_CHARS) return s || "";
  return `${s.slice(0, MAX_EXEC_OUTPUT_CHARS)}\n... (output truncated)`;
}

/** Linux only: one long-running `docker exec -i … sh` per container; commands are queued (same shell process). */
const linuxPersistentSessions = new Map();

function posixSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function execLinuxPersistentShell(containerId, cwd, command) {
  const cmd = String(command ?? "").trim();
  if (!cmd) {
    throw new Error("command required");
  }
  if (cmd.length > 32 * 1024) {
    throw new Error("command too long");
  }
  let session = linuxPersistentSessions.get(containerId);
  if (
    !session ||
    session.proc.exitCode !== null ||
    session.proc.killed
  ) {
    const boot =
      'while IFS= read -r __b64; do ' +
      '__s=$(printf "%s" "$__b64" | base64 -d 2>/dev/null) || continue; ' +
      'eval "$__s" || true; done';
    const proc = spawn(
      "docker",
      ["exec", "-i", containerId, "sh", "-c", boot],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    session = { proc, chain: Promise.resolve(), lastStderr: "" };
    proc.on("exit", () => {
      linuxPersistentSessions.delete(containerId);
    });
    proc.stderr?.on("data", (d) => {
      session.lastStderr = (session.lastStderr || "") + String(d);
    });
    linuxPersistentSessions.set(containerId, session);
  }

  const token = crypto.randomBytes(8).toString("hex");
  const marker = `__DEXP_T_${token}__`;
  const cwdQ = posixSingleQuote((cwd != null && String(cwd).trim()) || "/");
  const script = `cd ${cwdQ} 2>/dev/null || cd /; ${cmd}; printf '\\n${marker}%s\\n' "$?"`;
  const line = Buffer.from(script, "utf8").toString("base64");

  const { proc } = session;
  const escMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escMarker}(\\d+)`);

  const p = new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => {
      proc.stdout.removeListener("data", onData);
      finish(new Error("persistent exec timeout (120s)"));
    }, 120_000);
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(re);
      if (!m) return;
      const exitCode = parseInt(m[1], 10);
      const idx = buf.indexOf(marker);
      const stdoutText = idx >= 0 ? buf.slice(0, idx).trimEnd() : buf;
      proc.stdout.removeListener("data", onData);
      finish(null, {
        stdout: truncateOut(stdoutText),
        stderr: truncateOut(session.lastStderr || ""),
        exitCode: Number.isFinite(exitCode) ? exitCode : 1,
        reusedSession: true,
      });
      session.lastStderr = "";
    };
    proc.stdout.on("data", onData);
    session.lastStderr = "";
    proc.stdin.write(`${line}\n`, (err) => {
      if (err) {
        proc.stdout.removeListener("data", onData);
        finish(err);
      }
    });
  });

  session.chain = session.chain.catch(() => {}).then(() => p);
  return p;
}

async function fileMetaInContainer(containerId, filePath, platform) {
  if (platform === "windows") {
    const ps = [
      "$ErrorActionPreference='Stop'",
      `$p=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:${PS_ENV_STAT_B64}))`,
      "if (-not $p) { throw 'stat path empty' }",
      "$i=Get-Item -LiteralPath $p",
      "Write-Output (($i.Length.ToString()) + [char]9 + $i.LastWriteTimeUtc.ToString('o'))",
    ].join(";");
    const b64 = winPathToDockerEnvB64(filePath);
    const { stdout } = await execFileAsync(
      "docker",
      [
        "exec",
        "-e",
        `${PS_ENV_STAT_B64}=${b64}`,
        containerId,
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        ps,
      ],
      { encoding: "utf8", maxBuffer: 65536, timeout: 60_000 }
    );
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    const tab = line.indexOf("\t");
    if (tab < 0) {
      throw new Error("stat output unexpected");
    }
    const sizeStr = line.slice(0, tab);
    const mtime = line.slice(tab + 1);
    return {
      path: filePath,
      size: parseInt(sizeStr, 10) || 0,
      mtime: mtime || "",
    };
  }
  const { stdout } = await execFileAsync(
    "docker",
    ["exec", containerId, "stat", "-c", "%s %Y", filePath],
    { encoding: "utf8", maxBuffer: 8192, timeout: 60_000 }
  );
  const parts = stdout.trim().split(/\s+/);
  const sizeStr = parts[0] ?? "0";
  const mt = parts[1] ?? "";
  const sec = parseInt(mt, 10);
  return {
    path: filePath,
    size: parseInt(sizeStr, 10) || 0,
    mtime:
      Number.isFinite(sec) && sec > 0
        ? new Date(sec * 1000).toISOString()
        : "",
  };
}

/**
 * One-shot command in container (not a PTY). `command` is a single argv to cmd/sh — avoids host shell injection.
 * `reuseSession` (Linux + sh): reuse one long-running `docker exec -i … sh` per container.
 */
async function execInContainer(
  containerId,
  platform,
  cwd,
  command,
  shell,
  reuseSession = false
) {
  const cmd = String(command ?? "").trim();
  if (!cmd) {
    throw new Error("command required");
  }
  if (cmd.length > 32 * 1024) {
    throw new Error("command too long");
  }
  if (
    reuseSession &&
    platform === "linux" &&
    shell !== "powershell" &&
    shell !== "cmd"
  ) {
    try {
      return await execLinuxPersistentShell(containerId, cwd, cmd);
    } catch (e) {
      /* fall back to one-shot */
    }
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
      reusedSession: false,
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
    return {
      stdout,
      stderr,
      exitCode: code,
      reusedSession: false,
    };
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
    if (isBlockedExtRead(ext, extraBlocked)) {
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
        extLower === "log" ||
        extLower === "out" ||
        extLower === "trace" ||
        extLower === "yml" ||
        extLower === "yaml" ||
        extLower === "xml" ||
        extLower === "json" ||
        extLower === "properties" ||
        extLower === "config" ||
        extLower === "conf" ||
        extLower === "cfg" ||
        extLower === "ini" ||
        extLower === "env" ||
        extLower === "toml" ||
        extLower === "md";
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

  /** Lightweight size + mtime for polling (change detection). */
  app.get("/api/container/:id/file-meta", async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== "string") {
      return res.status(400).json({ error: "path query required" });
    }
    try {
      const platform = await dockerInspectOs(req.params.id);
      const meta = await fileMetaInContainer(req.params.id, filePath, platform);
      res.json(meta);
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.put("/api/container/:id/file", async (req, res) => {
    const body = req.body || {};
    const filePath =
      typeof body.filePath === "string"
        ? body.filePath
        : typeof body.path === "string"
          ? body.path
          : "";
    const { content, extraBlocked } = body;
    const extra =
      Array.isArray(extraBlocked) ? extraBlocked : [];
    if (!filePath) {
      return res.status(400).json({ error: "filePath or path required" });
    }
    const ext = extOf(filePath);
    if (isBlockedExtWrite(ext, extra)) {
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
    const { command, cwd, shell, reuseSession } = req.body || {};
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
        resolvedShell,
        !!reuseSession
      );
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  /**
   * Multipart: `targetPath` (container dir), `archive` (.zip).
   * Extract on the Docker host, then `docker cp` into the container (works for Linux/Windows containers).
   */
  app.post(
    "/api/container/:id/upload-zip",
    (req, res, next) => {
      zipMulter.single("archive")(req, res, (err) => {
        if (err) {
          return res
            .status(400)
            .json({ error: String(err?.message || err) });
        }
        next();
      });
    },
    async (req, res) => {
      const targetPathRaw = req.body?.targetPath;
      if (!targetPathRaw || typeof targetPathRaw !== "string") {
        if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: "targetPath required" });
      }
      let zipPath;
      let extractDir;
      try {
        if (!req.file?.path) {
          return res.status(400).json({ error: "zip file required (field: archive)" });
        }
        zipPath = req.file.path;
        const platform = await dockerInspectOs(req.params.id);
        const targetPath = normalizeContainerTargetPath(targetPathRaw, platform);
        await ensureDirectoryInContainer(req.params.id, targetPath, platform);
        extractDir = path.join(
          os.tmpdir(),
          `dexp-extract-${crypto.randomBytes(8).toString("hex")}`
        );
        await extractZipOnHost(zipPath, extractDir);
        await dockerCpHostDirContentsToContainer(
          extractDir,
          req.params.id,
          targetPath,
          platform
        );
        res.json({ ok: true, targetPath });
      } catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
      } finally {
        if (zipPath) await fs.unlink(zipPath).catch(() => {});
        if (extractDir) {
          await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  );

  /**
   * Multipart: `targetPath`, multiple `files` with relative paths (browser: webkitRelativePath).
   */
  app.post("/api/container/:id/upload-folder", (req, res) => {
    const stagingBase = path.join(
      os.tmpdir(),
      `dexp-tree-${crypto.randomBytes(10).toString("hex")}`
    );
    const treeUpload = createTreeMulter(stagingBase).array("files", 100_000);

    fs.mkdir(stagingBase, { recursive: true })
      .then(
        () =>
          new Promise((resolve, reject) => {
            treeUpload(req, res, (err) => {
              if (err) reject(err);
              else resolve();
            });
          })
      )
      .then(async () => {
        const targetPathRaw = req.body?.targetPath;
        if (!targetPathRaw || typeof targetPathRaw !== "string") {
          throw new Error("targetPath required");
        }
        const files = req.files;
        if (!files?.length) {
          throw new Error("no files (field: files)");
        }
        const platform = await dockerInspectOs(req.params.id);
        const targetPath = normalizeContainerTargetPath(targetPathRaw, platform);
        await ensureDirectoryInContainer(req.params.id, targetPath, platform);
        await dockerCpHostDirContentsToContainer(
          stagingBase,
          req.params.id,
          targetPath,
          platform
        );
        res.json({ ok: true, targetPath, fileCount: files.length });
      })
      .catch((e) => {
        const msg = String(e?.message || e);
        const code =
          /required|no files|invalid relative/i.test(msg) ? 400 : 500;
        res.status(code).json({ error: msg });
      })
      .finally(() =>
        fs.rm(stagingBase, { recursive: true, force: true }).catch(() => {})
      );
  });

  /**
   * Multipart: `targetPath` (container directory), single `file` — copied as `basename(originalname)` into that folder.
   */
  app.post(
    "/api/container/:id/upload-file",
    (req, res, next) => {
      fileMulter.single("file")(req, res, (err) => {
        if (err) {
          return res
            .status(400)
            .json({ error: String(err?.message || err) });
        }
        next();
      });
    },
    async (req, res) => {
      const targetDirRaw = req.body?.targetPath;
      let hostTmp;
      try {
        if (!targetDirRaw || typeof targetDirRaw !== "string") {
          if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
          return res.status(400).json({ error: "targetPath required" });
        }
        if (!req.file?.path) {
          return res.status(400).json({ error: 'file required (field: "file")' });
        }
        hostTmp = req.file.path;
        const safeOrig = String(req.file.originalname || "").replace(/[/\\]/g, "");
        const baseName = path.basename(safeOrig) || "upload.bin";
        const platform = await dockerInspectOs(req.params.id);
        const targetDir = normalizeContainerTargetPath(targetDirRaw, platform);
        const joinF = platform === "windows" ? path.win32.join : path.posix.join;
        const destPath = joinF(targetDir, baseName);
        await ensureDirectoryInContainer(req.params.id, targetDir, platform);
        await dockerCpToContainer(hostTmp, req.params.id, destPath);
        res.json({ ok: true, targetPath: targetDir, filePath: destPath });
      } catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
      } finally {
        if (hostTmp) await fs.unlink(hostTmp).catch(() => {});
      }
    }
  );

  return app;
}

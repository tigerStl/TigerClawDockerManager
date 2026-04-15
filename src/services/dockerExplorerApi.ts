/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 */

import axios from "axios";

/** Prefer server `{ error: "..." }` body over generic axios status text. */
export function apiErrorMessage(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const data = e.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error;
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Large saves go through docker exec + stdin; allow long waits (default axios 120s caused frequent timeouts). */
const client = axios.create({
  baseURL: "",
  timeout: 900_000,
});

export type ContainerRow = {
  id: string;
  name: string;
  image: string;
  status: string;
  platform: string;
};

export type FsEntry = {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
};

export async function fetchHealth(): Promise<boolean> {
  try {
    const { data } = await client.get<{ ok?: boolean }>("/api/health");
    return !!data?.ok;
  } catch {
    return false;
  }
}

export async function listContainers(): Promise<ContainerRow[]> {
  const { data } = await client.get<{ containers: ContainerRow[] }>(
    "/api/containers"
  );
  return data.containers ?? [];
}

export async function listDirectory(
  containerId: string,
  dirPath: string
): Promise<{ entries: FsEntry[]; platform: string; path: string }> {
  const { data } = await client.get<{
    entries: FsEntry[];
    platform: string;
    path: string;
  }>(`/api/container/${encodeURIComponent(containerId)}/list`, {
    params: { path: dirPath },
  });
  return data;
}

export async function readFileText(
  containerId: string,
  filePath: string,
  extraBlocked: string[]
): Promise<{ content: string | null; binary: boolean; size: number }> {
  const { data } = await client.get<{
    content: string | null;
    binary: boolean;
    size: number;
  }>(`/api/container/${encodeURIComponent(containerId)}/file`, {
    params: { path: filePath, block: extraBlocked.join(",") },
  });
  return data;
}

/** Size + mtime for polling (detect external file changes in the container). */
export async function fetchFileMeta(
  containerId: string,
  filePath: string
): Promise<{ path: string; size: number; mtime: string }> {
  const { data } = await client.get<{
    path: string;
    size: number;
    mtime: string;
  }>(`/api/container/${encodeURIComponent(containerId)}/file-meta`, {
    params: { path: filePath },
  });
  return data;
}

export async function writeFileText(
  containerId: string,
  filePath: string,
  content: string,
  extraBlocked: string[]
): Promise<void> {
  await client.put(
    `/api/container/${encodeURIComponent(containerId)}/file`,
    /** `filePath` avoids any tooling that mishandles a JSON key named `path`. */
    { filePath, path: filePath, content, extraBlocked },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 900_000,
    }
  );
}

export async function deletePath(
  containerId: string,
  targetPath: string
): Promise<void> {
  await client.delete(
    `/api/container/${encodeURIComponent(containerId)}/file`,
    { params: { path: targetPath } }
  );
}

export type ContainerExecShell = "cmd" | "powershell" | "sh";

export type ContainerExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  reusedSession?: boolean;
};

export async function execInContainer(
  containerId: string,
  body: {
    command: string;
    cwd?: string;
    shell?: ContainerExecShell;
    /** Linux + sh: reuse one long-running `docker exec -i … sh` (session continuity). */
    reuseSession?: boolean;
  }
): Promise<ContainerExecResult> {
  const { data } = await client.post<ContainerExecResult>(
    `/api/container/${encodeURIComponent(containerId)}/exec`,
    body
  );
  return data;
}

export function downloadUrl(containerId: string, filePath: string): string {
  const q = new URLSearchParams({ path: filePath });
  return `/api/container/${encodeURIComponent(containerId)}/download?${q}`;
}

/** Upload a .zip; server extracts on host and copies contents into `targetPath` in the container. */
export async function uploadZipToContainer(
  containerId: string,
  targetPath: string,
  file: File
): Promise<{ ok: boolean; targetPath: string }> {
  const fd = new FormData();
  fd.append("targetPath", targetPath);
  fd.append("archive", file, file.name);
  const { data } = await client.post<{ ok: boolean; targetPath: string }>(
    `/api/container/${encodeURIComponent(containerId)}/upload-zip`,
    fd,
    { timeout: 900_000 }
  );
  return data;
}

/** Upload a folder (relative paths preserved); server stages files then `docker cp` into `targetPath`. */
export async function uploadFolderToContainer(
  containerId: string,
  targetPath: string,
  files: FileList | File[]
): Promise<{ ok: boolean; targetPath: string; fileCount: number }> {
  const fd = new FormData();
  fd.append("targetPath", targetPath);
  for (const f of Array.from(files)) {
    const rel =
      (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
      f.name;
    fd.append("files", f, rel);
  }
  const { data } = await client.post<{
    ok: boolean;
    targetPath: string;
    fileCount: number;
  }>(`/api/container/${encodeURIComponent(containerId)}/upload-folder`, fd, {
    timeout: 900_000,
  });
  return data;
}

/** Upload one file into `targetPath` (container directory); uses the original file name. */
export async function uploadFileToContainer(
  containerId: string,
  targetPath: string,
  file: File
): Promise<{ ok: boolean; targetPath: string; filePath: string }> {
  const fd = new FormData();
  fd.append("targetPath", targetPath);
  fd.append("file", file, file.name);
  const { data } = await client.post<{
    ok: boolean;
    targetPath: string;
    filePath: string;
  }>(`/api/container/${encodeURIComponent(containerId)}/upload-file`, fd, {
    timeout: 900_000,
  });
  return data;
}

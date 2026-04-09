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

const client = axios.create({
  baseURL: "",
  timeout: 120000,
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

export async function writeFileText(
  containerId: string,
  filePath: string,
  content: string,
  extraBlocked: string[]
): Promise<void> {
  await client.put(`/api/container/${encodeURIComponent(containerId)}/file`, {
    path: filePath,
    content,
    extraBlocked,
  });
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
};

export async function execInContainer(
  containerId: string,
  body: {
    command: string;
    cwd?: string;
    shell?: ContainerExecShell;
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

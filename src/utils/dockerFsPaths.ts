/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 */

/** Join container path segments (Windows vs Linux). */
export function joinContainerPath(
  platform: string,
  parent: string,
  name: string
): string {
  const isWin = platform === "windows";
  const p = parent.replace(/[\\/]+$/, "");
  if (isWin) {
    if (/^[A-Za-z]:$/.test(p)) return `${p}\\${name}`;
    return `${p}\\${name}`;
  }
  if (p === "" || p === "/") return `/${name}`;
  return `${p}/${name}`;
}

export function parentDir(platform: string, p: string): string {
  const isWin = platform === "windows";
  if (isWin) {
    const x = p.replace(/\\+$/, "");
    if (/^[A-Za-z]:$/.test(x)) return x;
    const i = x.lastIndexOf("\\");
    if (i <= 2 && /^[A-Za-z]:\\/.test(x)) return x.slice(0, 2);
    if (i <= 0) return "C:\\";
    return x.slice(0, i);
  }
  const y = p.replace(/\/+$/, "") || "/";
  if (y === "/") return "/";
  const j = y.lastIndexOf("/");
  if (j <= 0) return "/";
  return y.slice(0, j) || "/";
}

export function rootPath(platform: string): string {
  return platform === "windows" ? "C:\\" : "/";
}

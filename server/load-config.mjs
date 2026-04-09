/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 */

import fs from "fs";
import path from "path";
import { parse } from "yaml";

/**
 * Load optional `docker-manager.config.yml`. Callers apply env overrides.
 *
 * @param {{ projectRoot: string }} opts
 * @returns {{ configPath: string|null, port?: number, host?: string }}
 */
export function resolveDockerManagerConfig(opts) {
  const projectRoot = opts.projectRoot;
  const candidates = [];
  if (process.env.DOCKER_MANAGER_CONFIG) {
    candidates.push(process.env.DOCKER_MANAGER_CONFIG);
  }
  candidates.push(path.join(process.cwd(), "docker-manager.config.yml"));
  if (projectRoot) {
    candidates.push(path.join(projectRoot, "docker-manager.config.yml"));
  }
  try {
    candidates.push(
      path.join(path.dirname(process.execPath), "docker-manager.config.yml")
    );
  } catch (_) {
    /* noop */
  }

  for (const p of candidates) {
    if (!p) continue;
    try {
      if (!fs.existsSync(p)) continue;
      const doc = parse(fs.readFileSync(p, "utf8"));
      const port = doc.port != null ? Number(doc.port) : undefined;
      const host =
        typeof doc.host === "string" ? doc.host.trim() : undefined;
      const okPort =
        Number.isFinite(port) && port >= 1 && port <= 65535 ? port : undefined;
      return {
        configPath: p,
        port: okPort,
        host: host || undefined,
      };
    } catch (e) {
      console.warn(
        `[TigerClawDockerManager] Ignoring invalid config file ${p}:`,
        e.message
      );
    }
  }
  return { configPath: null, port: undefined, host: undefined };
}

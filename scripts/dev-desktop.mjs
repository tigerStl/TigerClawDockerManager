/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 *
 * Desktop dev: Vite + wait-on + Electron, using port from docker-manager.config.yml when present.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDockerManagerConfig } from "../server/load-config.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { port = 9847 } = resolveDockerManagerConfig({ projectRoot: root });

const electronCmd = `wait-on http-get://127.0.0.1:${port}/api/health -t 120000 && cross-env ELECTRON_START_URL=http://127.0.0.1:${port} electron .`;

const child = spawn(
  "concurrently",
  ["-k", "vite", electronCmd],
  { cwd: root, shell: true, stdio: "inherit", env: process.env }
);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

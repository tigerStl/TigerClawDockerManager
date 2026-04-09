/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 */

import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error ESM server module (no TS types)
import { createApp } from "./server/docker-explorer-api.mjs";
import { resolveDockerManagerConfig } from "./server/load-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fileCfg = resolveDockerManagerConfig({ projectRoot: __dirname });
const devPort = fileCfg.port ?? 9847;

const apiApp = createApp();

export default defineConfig({
  plugins: [
    react(),
    {
      name: "docker-explorer-api",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const u = req.url ?? "";
          if (!u.startsWith("/api")) return next();
          apiApp(req, res, next);
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          const u = req.url ?? "";
          if (!u.startsWith("/api")) return next();
          apiApp(req, res, next);
        });
      },
    },
  ],
  server: {
    port: devPort,
  },
  preview: {
    port: devPort,
  },
});

/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 *
 * Production server: serves Vite `dist` + Docker explorer API on the same port.
 * Dev: use `npm run dev` (Vite middleware). This file is for `npm start` and pkg exe.
 */
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createApp } from "./docker-explorer-api.mjs";
import { resolveDockerManagerConfig } from "./load-config.mjs";

const rootFile =
  typeof __filename !== "undefined"
    ? __filename
    : fileURLToPath(import.meta.url);
const __rootDir = path.dirname(rootFile);
const distDir = path.join(__rootDir, "..", "dist");

const app = express();
app.use(createApp());

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    const indexHtml = path.join(distDir, "index.html");
    if (!fs.existsSync(indexHtml)) return next();
    res.sendFile(indexHtml);
  });
} else {
  app.use((_req, res) => {
    res
      .status(503)
      .type("text")
      .send("dist/ missing — run npm run build before npm start");
  });
}

const __appRoot = path.join(__rootDir, "..");
const fileCfg = resolveDockerManagerConfig({ projectRoot: __appRoot });
const port = Number(
  process.env.DOCKER_MANAGER_PORT ||
    process.env.PORT ||
    fileCfg.port ||
    9847
);
const host =
  process.env.DOCKER_MANAGER_HOST || fileCfg.host || "127.0.0.1";

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`TigerClawDockerManager http://${host}:${port}/`);
});

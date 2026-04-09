/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 *
 * Electron shell: loads the same Vite UI in a native window (no external browser).
 * - Dev: set ELECTRON_START_URL (Vite port matches docker-manager.config.yml / default 9847).
 * - Prod: require bundled server (build/docker-manager.cjs) then open http://HOST:PORT
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { pathToFileURL } = require("url");

/** Production HTTP target (after optional docker-manager.config.yml + env). */
let serverPort = 9847;
let serverHost = "127.0.0.1";

async function refreshRuntimeFromDisk() {
  try {
    const mod = await import(
      pathToFileURL(path.join(__dirname, "..", "server", "load-config.mjs")).href
    );
    const fileCfg = mod.resolveDockerManagerConfig({
      projectRoot: path.join(__dirname, ".."),
    });
    serverPort = Number(
      process.env.DOCKER_MANAGER_PORT ||
        process.env.PORT ||
        fileCfg.port ||
        9847
    );
    serverHost =
      process.env.DOCKER_MANAGER_HOST || fileCfg.host || "127.0.0.1";
  } catch (e) {
    console.warn("[TigerClawDockerManager] Config:", e.message);
    serverPort = Number(
      process.env.DOCKER_MANAGER_PORT || process.env.PORT || 9847
    );
    serverHost = process.env.DOCKER_MANAGER_HOST || "127.0.0.1";
  }
}

let mainWindow = null;
let splashWindow = null;

function createSplashWindow() {
  const htmlPath = path.join(__dirname, "splash.html");
  if (!fs.existsSync(htmlPath)) {
    return null;
  }
  const w = new BrowserWindow({
    width: 400,
    height: 420,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#0d1117",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  w.loadFile(htmlPath);
  return w;
}

function waitForServer(port, host, maxMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(
        `http://${host}:${port}/api/health`,
        { timeout: 2000 },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on("error", () => {
        if (Date.now() - started > maxMs) {
          reject(new Error("Server did not become ready in time"));
        } else {
          setTimeout(tryOnce, 150);
        }
      });
      req.on("timeout", () => {
        req.destroy();
        if (Date.now() - started > maxMs) {
          reject(new Error("Server did not become ready in time"));
        } else {
          setTimeout(tryOnce, 150);
        }
      });
    };
    tryOnce();
  });
}

function loadServerBundleOnce() {
  const entry = path.join(__dirname, "..", "build", "docker-manager.cjs");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Missing ${entry}. Run: npm run build && npm run bundle`
    );
  }
  require(entry);
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

async function createWindow() {
  splashWindow = createSplashWindow();

  const devUrl = process.env.ELECTRON_START_URL;
  let url;
  try {
    if (devUrl) {
      url = devUrl.replace(/\/$/, "") + "/dockerfileManager";
    } else {
      loadServerBundleOnce();
      await waitForServer(serverPort, serverHost);
      url = `http://${serverHost}:${serverPort}/dockerfileManager`;
    }
  } catch (err) {
    closeSplash();
    throw err;
  }

  const iconPng = path.join(__dirname, "icon.png");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: "TigerClawDockerManager",
    icon: fs.existsSync(iconPng) ? iconPng : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    closeSplash();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  try {
    await mainWindow.loadURL(url);
  } catch (err) {
    closeSplash();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
    mainWindow = null;
    throw err;
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(targetUrl)) {
      event.preventDefault();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await refreshRuntimeFromDisk();
  createWindow().catch((err) => {
    console.error(err);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    refreshRuntimeFromDisk()
      .then(() => createWindow())
      .catch(console.error);
  }
});

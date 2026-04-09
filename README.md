# TigerClawDockerManager

Standalone tool: browse files inside running Docker containers and run one-shot shell commands via `docker exec`. **Desktop app** uses **Electron** — a **native window** with the same React UI (no separate browser tab required).

**Branding:** Windows builds use the **TigerClaw** icon (`build-res/icon.png`) — three amber claw marks on a dark field — configured for `electron-builder` so the packaged `.exe` is not the default Electron icon.

## Requirements

- Node.js 20+ (development)
- Docker CLI on PATH, Docker Desktop/daemon running

## Development

**Web only** (default browser URL http://127.0.0.1:9847 unless you set a port in `docker-manager.config.yml`):

```powershell
npm install
npm run dev
```

**Desktop window** (recommended — same UI inside Electron):

```powershell
npm run dev:desktop
```

Waits for Vite + `/api/health`, then opens the Electron shell.

## Production

### Windows app (`.exe` with its own window)

```powershell
npm install
npm run pack:win
```

Output under **`release/`** (e.g. portable `TigerClawDockerManager x.x.x.exe` — exact name depends on electron-builder).

Double-click the built executable: it **starts the embedded server** and **opens the UI in an Electron window** (default **English** UI; use **中文** in the header to switch).

### Headless server only (no window, optional)

For a small **Node/pkg** binary without Electron (advanced):

```powershell
npm run pack:server
```

Produces something like `release/docker-manager-server.exe` — you would still open a browser manually to the printed URL.

### Port and host (`docker-manager.config.yml`)

Optional YAML next to the project, next to the packaged `.exe`, or in the current working directory. Copy `docker-manager.config.example.yml` to `docker-manager.config.yml` and edit:

```yaml
port: 9847
host: 127.0.0.1
```

You can point to a specific file with `DOCKER_MANAGER_CONFIG` (absolute path). **Environment variables override** the file.

### Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `DOCKER_MANAGER_CONFIG` | — | Absolute path to a YAML file (overrides default search locations) |
| `DOCKER_MANAGER_PORT` / `PORT` | `9847` | HTTP port (overrides YAML) |
| `DOCKER_MANAGER_HOST` | `127.0.0.1` | Bind address (overrides YAML) |

## Security

The API is intended for **localhost** use only. Do not expose it to a network without authentication and TLS.

---

## 中文说明

TigerClawDockerManager 是一款**本地工具**：在运行中的 Docker 容器内浏览文件，并通过 `docker exec` 执行一次性 shell 命令。**桌面版**基于 **Electron**，在同一套 React 界面外再套一层**原生窗口**（无需单独开浏览器标签页）。

**品牌与图标：** Windows 打包使用 **TigerClaw** 图标（`build-res/icon.png`：深色背景上的琥珀色爪痕），经 `electron-builder` 配置，避免使用默认 Electron 图标。

### 环境要求

- Node.js 20+（开发构建）
- 系统已安装 Docker CLI，且 Docker Desktop / 守护进程在运行

### 开发调试

**仅 Web（浏览器）**（默认 http://127.0.0.1:9847；若在 `docker-manager.config.yml` 中配置了端口则使用该端口）：

```powershell
npm install
npm run dev
```

**桌面窗口（推荐，同一套界面在 Electron 内打开）：**

```powershell
npm run dev:desktop
```

会等待 Vite 与 `/api/health` 就绪后，再启动 Electron 外壳窗口。

### 生产构建

#### Windows 桌面应用（自带窗口的 `.exe`）

```powershell
npm install
npm run pack:win
```

产物在 **`release/`** 目录（例如便携版 `TigerClawDockerManager x.x.x.exe`，具体名称以 electron-builder 为准）。

双击生成的可执行文件：会**启动内置 HTTP 服务**，并在 **Electron 窗口**中打开界面（界面默认**英文**，可在标题栏切换 **中文**）。

#### 仅无界面服务端（可选，进阶）

打包不含 Electron 的小型 **Node/pkg** 可执行文件：

```powershell
npm run pack:server
```

会生成类似 `release/docker-manager-server.exe` 的文件；需在浏览器中手动打开控制台打印的 URL。

### 端口与监听地址（`docker-manager.config.yml`）

可选 YAML：可放在项目目录、打包后的 `.exe` 同目录，或当前工作目录。将 `docker-manager.config.example.yml` 复制为 `docker-manager.config.yml` 后编辑，例如：

```yaml
port: 9847
host: 127.0.0.1
```

也可通过环境变量 `DOCKER_MANAGER_CONFIG` 指定**绝对路径**指向某个 YAML 文件。**环境变量的优先级高于配置文件。**

### 环境变量

| 变量 | 默认值 | 含义 |
|------|--------|------|
| `DOCKER_MANAGER_CONFIG` | — | YAML 配置文件的绝对路径（覆盖默认搜索路径） |
| `DOCKER_MANAGER_PORT` / `PORT` | `9847` | HTTP 端口（覆盖 YAML） |
| `DOCKER_MANAGER_HOST` | `127.0.0.1` | 监听地址（覆盖 YAML） |

### 安全提示

本工具提供的 API 仅适用于 **本机（localhost）** 场景。若无身份校验与 TLS，请勿暴露到公网或其它不可信网络。

/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "../styles/dockerExplorer.css";
import {
  listContainers,
  listDirectory,
  readFileText,
  writeFileText,
  deletePath,
  downloadUrl,
  fetchHealth,
  apiErrorMessage,
  execInContainer,
  type ContainerExecShell,
  type ContainerRow,
  type FsEntry,
} from "../services/dockerExplorerApi";
import {
  joinContainerPath,
  parentDir,
  rootPath,
} from "../utils/dockerFsPaths";

const SETTINGS_KEY = "dockerExplorer.settings.v1";

/** Client-side: never offer edit for these (server also enforces) */
const BUILTIN_BLOCKED = new Set([
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

type Settings = {
  editableExtensions: string[];
  extraBlocked: string[];
};

const DEFAULT_SETTINGS: Settings = {
  editableExtensions: [
    "txt",
    "log",
    "xml",
    "config",
    "json",
    "yml",
    "yaml",
    "cfg",
    "conf",
    "ini",
    "md",
    "properties",
    "env",
    "toml",
    "gitattributes",
    "gitignore",
    "csv",
  ],
  extraBlocked: [],
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, editableExtensions: [...DEFAULT_SETTINGS.editableExtensions] };
    const p = JSON.parse(raw) as Settings;
    return {
      editableExtensions: Array.isArray(p.editableExtensions)
        ? p.editableExtensions.map((x) => String(x).toLowerCase().replace(/^\./, ""))
        : [...DEFAULT_SETTINGS.editableExtensions],
      extraBlocked: Array.isArray(p.extraBlocked)
        ? p.extraBlocked.map((x) => String(x).toLowerCase().replace(/^\./, ""))
        : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS, editableExtensions: [...DEFAULT_SETTINGS.editableExtensions] };
  }
}

function saveSettings(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  if (i <= 0) return "";
  return fileName.slice(i + 1).toLowerCase();
}

function basename(p: string): string {
  const s = p.replace(/\\/g, "/");
  const j = s.lastIndexOf("/");
  return j >= 0 ? s.slice(j + 1) : p;
}

export type EditorTab = {
  id: string;
  path: string;
  content: string;
  dirty: boolean;
  readOnly: boolean;
  binary: boolean;
};

export type DockerFileExplorerLang = "zh" | "en";

type DexpCopy = {
  container: string;
  selectContainer: string;
  refresh: string;
  path: string;
  open: string;
  up: string;
  delete: string;
  download: string;
  settings: string;
  loading: string;
  colName: string;
  colSize: string;
  colModified: string;
  closeTab: string;
  readOnly: string;
  binaryNotEditable: string;
  binaryPlaceholder: string;
  save: string;
  editorHint: string;
  settingsEditableTitle: string;
  settingsEditableBody: string;
  settingsBlockedTitle: string;
  settingsBlockedBody: string;
  settingsBuiltinHint: string;
  cancel: string;
  saveDone: string;
  saving: string;
  consoleTitle: string;
  consoleHint: string;
  consoleRun: string;
  consoleShow: string;
  consoleHide: string;
  consoleCwd: string;
  shellCmd: string;
  shellPs: string;
  shellSh: string;
  confirmDeleteFolder: (full: string) => string;
  confirmDeleteFile: (full: string) => string;
};

const DEXP_COPY: Record<DockerFileExplorerLang, DexpCopy> = {
  zh: {
    container: "容器",
    selectContainer: "— 选择运行中的容器 —",
    refresh: "刷新列表",
    path: "路径",
    open: "打开",
    up: "上级",
    delete: "删除",
    download: "复制到本地",
    settings: "设置",
    loading: "加载中…",
    colName: "名称",
    colSize: "大小",
    colModified: "修改时间",
    closeTab: "关闭",
    readOnly: "只读",
    binaryNotEditable: "二进制/不可编辑",
    binaryPlaceholder: "(二进制或不可显示为文本)",
    save: "保存",
    editorHint:
      "双击文件在标签页中打开。可编辑类型在「设置」中配置；exe、dll 等受保护类型不可修改。",
    settingsEditableTitle: "可编辑文件类型",
    settingsEditableBody:
      "仅允许编辑下列扩展名（逗号或空格分隔，不含句点）。exe、dll、bat、ps1、jar 等始终在服务器端拒绝。",
    settingsBlockedTitle: "额外禁止的扩展名（可选）",
    settingsBlockedBody: "在允许列表之外再屏蔽的扩展名，例如特定环境下的敏感类型。",
    settingsBuiltinHint:
      "当前内置始终禁止：exe、dll、so、bat、cmd、msi、jar、ps1、js、bin 等（与后端一致）。",
    cancel: "取消",
    saveDone: "已保存",
    saving: "保存中…",
    consoleTitle: "容器控制台",
    consoleHint: "工作目录为上方「路径」；Enter 执行单条命令（非交互式）。",
    consoleRun: "执行",
    consoleShow: "显示控制台",
    consoleHide: "收起",
    consoleCwd: "工作目录",
    shellCmd: "CMD",
    shellPs: "PowerShell",
    shellSh: "sh",
    confirmDeleteFolder: (full) => `确定删除文件夹？\n${full}`,
    confirmDeleteFile: (full) => `确定删除文件？\n${full}`,
  },
  en: {
    container: "Container",
    selectContainer: "— Select a running container —",
    refresh: "Refresh",
    path: "Path",
    open: "Open",
    up: "Up",
    delete: "Delete",
    download: "Download",
    settings: "Settings",
    loading: "Loading…",
    colName: "Name",
    colSize: "Size",
    colModified: "Modified",
    closeTab: "Close",
    readOnly: "read-only",
    binaryNotEditable: "binary / not editable",
    binaryPlaceholder: "(Binary or not displayable as text)",
    save: "Save",
    editorHint:
      "Double-click a file to open it in a tab. Editable extensions are configured in Settings; protected types such as exe and dll cannot be modified.",
    settingsEditableTitle: "Editable file extensions",
    settingsEditableBody:
      "Only these extensions may be edited (comma- or space-separated, without a leading dot). exe, dll, bat, ps1, jar, etc. are always rejected on the server.",
    settingsBlockedTitle: "Additional blocked extensions (optional)",
    settingsBlockedBody:
      "Extensions to block on top of the allow list, for environment-specific sensitive types.",
    settingsBuiltinHint:
      "Built-in blocks always include exe, dll, so, bat, cmd, msi, jar, ps1, js, bin, etc. (same as the API).",
    cancel: "Cancel",
    saveDone: "Saved",
    saving: "Saving…",
    consoleTitle: "Container console",
    consoleHint:
      "Working directory is Path above; Enter runs one non-interactive command.",
    consoleRun: "Run",
    consoleShow: "Show console",
    consoleHide: "Hide",
    consoleCwd: "Working dir",
    shellCmd: "CMD",
    shellPs: "PowerShell",
    shellSh: "sh",
    confirmDeleteFolder: (full) => `Delete folder?\n${full}`,
    confirmDeleteFile: (full) => `Delete file?\n${full}`,
  },
};

export type DockerFileExplorerProps = {
  language?: DockerFileExplorerLang;
};

export default function DockerFileExplorer({
  language = "en",
}: DockerFileExplorerProps) {
  const t = DEXP_COPY[language];
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [containers, setContainers] = useState<ContainerRow[]>([]);
  const [containerId, setContainerId] = useState("");
  const [platform, setPlatform] = useState("windows");
  const [currentPath, setCurrentPath] = useState("C:\\");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<FsEntry | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editableRaw, setEditableRaw] = useState("");
  const [blockedRaw, setBlockedRaw] = useState("");
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveDoneFlash, setSaveDoneFlash] = useState(false);
  const saveDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [consoleInput, setConsoleInput] = useState("");
  const [consoleBusy, setConsoleBusy] = useState(false);
  const [consoleShell, setConsoleShell] =
    useState<ContainerExecShell>("cmd");
  const [consoleLines, setConsoleLines] = useState<
    { id: number; kind: "cmd" | "out" | "err" | "exit"; text: string }[]
  >([]);
  const consoleLineId = useRef(0);
  const consoleOutRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    return () => {
      if (saveDoneTimerRef.current) clearTimeout(saveDoneTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (platform !== "windows") {
      setConsoleShell("sh");
    } else {
      setConsoleShell((s) => (s === "sh" ? "cmd" : s));
    }
  }, [platform]);

  useEffect(() => {
    const el = consoleOutRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [consoleLines]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId]
  );

  const refreshContainers = useCallback(async () => {
    try {
      const list = await listContainers();
      setContainers(list);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => {
    fetchHealth().then(setApiOk);
  }, []);

  useEffect(() => {
    refreshContainers();
  }, [refreshContainers]);

  const loadDir = useCallback(async () => {
    if (!containerId) return;
    setLoading(true);
    setErr(null);
    try {
      const data = await listDirectory(containerId, currentPath);
      setPlatform(data.platform);
      setEntries(data.entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      }));
    } catch (e) {
      setErr(apiErrorMessage(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [containerId, currentPath]);

  useEffect(() => {
    loadDir();
  }, [loadDir]);

  useEffect(() => {
    if (!containerId) return;
    const c = containers.find((x) => x.id === containerId);
    if (c) setPlatform(c.platform);
  }, [containerId, containers]);

  const onSelectContainer = (id: string) => {
    setContainerId(id);
    const c = containers.find((x) => x.id === id);
    const plat = c?.platform || "linux";
    setPlatform(plat);
    setCurrentPath(rootPath(plat));
    setSelected(null);
    setTabs([]);
    setActiveTabId(null);
    setConsoleLines([]);
    setConsoleInput("");
  };

  const isEditable = useCallback(
    (fileName: string) => {
      const ext = extOf(fileName);
      if (!ext) return false;
      if (BUILTIN_BLOCKED.has(ext)) return false;
      if (settings.extraBlocked.includes(ext)) return false;
      return settings.editableExtensions.includes(ext);
    },
    [settings]
  );

  const openFile = async (entry: FsEntry) => {
    if (entry.isDirectory) {
      setCurrentPath(joinContainerPath(platform, currentPath, entry.name));
      setSelected(null);
      return;
    }
    const full = joinContainerPath(platform, currentPath, entry.name);
    const id = full;
    if (tabs.some((t) => t.id === id)) {
      setActiveTabId(id);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const data = await readFileText(
        containerId,
        full,
        settings.extraBlocked
      );
      const readOnly = !isEditable(entry.name) || data.binary;
      setTabs((prev) => [
        ...prev,
        {
          id,
          path: full,
          content: data.binary ? "" : data.content ?? "",
          dirty: false,
          readOnly,
          binary: data.binary,
        },
      ]);
      setActiveTabId(id);
    } catch (e) {
      setErr(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const updateActiveContent = (text: string) => {
    if (!activeTabId) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId ? { ...t, content: text, dirty: true } : t
      )
    );
  };

  const saveActive = async () => {
    if (!activeTab || activeTab.readOnly || !containerId) return;
    setErr(null);
    setSaveBusy(true);
    setSaveDoneFlash(false);
    if (saveDoneTimerRef.current) {
      clearTimeout(saveDoneTimerRef.current);
      saveDoneTimerRef.current = null;
    }
    try {
      await writeFileText(
        containerId,
        activeTab.path,
        activeTab.content,
        settings.extraBlocked
      );
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id ? { ...t, dirty: false } : t
        )
      );
      setSaveDoneFlash(true);
      saveDoneTimerRef.current = setTimeout(() => {
        setSaveDoneFlash(false);
        saveDoneTimerRef.current = null;
      }, 2500);
    } catch (e) {
      setErr(apiErrorMessage(e));
    } finally {
      setSaveBusy(false);
    }
  };

  const runConsoleCommand = async () => {
    if (!containerId) {
      setErr(
        language === "en"
          ? "Select a container first."
          : "请先选择容器。"
      );
      return;
    }
    const line = consoleInput.trim();
    if (!line || consoleBusy) return;

    const pushLines = (
      chunks: { kind: "cmd" | "out" | "err" | "exit"; text: string }[]
    ) => {
      setConsoleLines((prev) => {
        const next = [...prev];
        for (const c of chunks) {
          consoleLineId.current += 1;
          next.push({ id: consoleLineId.current, ...c });
        }
        while (next.length > 400) next.shift();
        return next;
      });
    };

    setConsoleBusy(true);
    setErr(null);
    pushLines([{ kind: "cmd", text: `$ ${line}` }]);
    setConsoleInput("");
    try {
      const shell: ContainerExecShell =
        platform === "windows" ? consoleShell : "sh";
      const r = await execInContainer(containerId, {
        command: line,
        cwd: currentPath,
        shell,
      });
      const extra: { kind: "out" | "err" | "exit"; text: string }[] = [];
      if (r.stdout) extra.push({ kind: "out", text: r.stdout });
      if (r.stderr) extra.push({ kind: "err", text: r.stderr });
      extra.push({
        kind: "exit",
        text:
          (language === "en" ? "exit code " : "退出码 ") + String(r.exitCode),
      });
      pushLines(extra);
    } catch (e) {
      pushLines([
        { kind: "err", text: apiErrorMessage(e) },
        {
          kind: "exit",
          text: language === "en" ? "exit code 1" : "退出码 1",
        },
      ]);
    } finally {
      setConsoleBusy(false);
    }
  };

  const closeTab = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next.length ? next[next.length - 1].id : null);
      }
      return next;
    });
  };

  const onDelete = async () => {
    if (!selected || !containerId) return;
    const full = joinContainerPath(platform, currentPath, selected.name);
    const ok = window.confirm(
      selected.isDirectory
        ? t.confirmDeleteFolder(full)
        : t.confirmDeleteFile(full)
    );
    if (!ok) return;
    setLoading(true);
    try {
      await deletePath(containerId, full);
      setTabs((prev) => prev.filter((t) => !t.path.startsWith(full)));
      if (activeTabId && tabs.find((t) => t.id === activeTabId)?.path.startsWith(full)) {
        setActiveTabId(null);
      }
      await loadDir();
      setSelected(null);
    } catch (e) {
      setErr(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const onDownload = () => {
    if (!selected || selected.isDirectory || !containerId) return;
    const full = joinContainerPath(platform, currentPath, selected.name);
    const a = document.createElement("a");
    a.href = downloadUrl(containerId, full);
    a.download = selected.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const breadcrumbParts = useMemo(() => {
    const isWin = platform === "windows";
    const p = currentPath.replace(/\\$/,"").replace(/\/$/,"");
    if (!isWin) {
      if (p === "" || p === "/") return [{ label: "/", path: "/" }];
      const parts = p.split("/").filter(Boolean);
      const out: { label: string; path: string }[] = [];
      let acc = "";
      out.push({ label: "/", path: "/" });
      for (const seg of parts) {
        acc += "/" + seg;
        out.push({ label: seg, path: acc });
      }
      return out;
    }
    const m = p.match(/^([A-Za-z]:)(\\.*)?$/);
    if (!m) return [{ label: p, path: p }];
    const drive = m[1];
    const rest = (m[2] || "").split("\\").filter(Boolean);
    const out: { label: string; path: string }[] = [{ label: drive, path: drive + "\\" }];
    let acc = drive + "\\";
    for (const seg of rest) {
      acc = acc.endsWith("\\") ? acc + seg : acc + "\\" + seg;
      out.push({ label: seg, path: acc });
    }
    return out;
  }, [currentPath, platform]);

  const openSettings = () => {
    setEditableRaw(settings.editableExtensions.join(", "));
    setBlockedRaw(settings.extraBlocked.join(", "));
    setSettingsOpen(true);
  };

  const saveSettingsClick = () => {
    const editable = editableRaw
      .split(/[,\s]+/)
      .map((x) => x.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean);
    const blocked = blockedRaw
      .split(/[,\s]+/)
      .map((x) => x.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean);
    const next: Settings = { editableExtensions: editable, extraBlocked: blocked };
    setSettings(next);
    saveSettings(next);
    setSettingsOpen(false);
  };

  return (
    <div className="dexp">
      {apiOk === false && (
        <div className="dexp-banner">
          {language === "en" ? (
            <>
              Cannot reach the Docker file API (<code>/api</code>). Run{" "}
              <code>npm run dev</code> locally and ensure the Vite dev server
              loads the Docker API middleware.
            </>
          ) : (
            <>
              无法连接 Docker 文件 API（<code>/api</code>）。请确认已在本机运行{" "}
              <code>npm run dev</code>，且 Vite 已加载 Docker API 中间件。
            </>
          )}
        </div>
      )}

      <div className="dexp-toolbar">
        <label>{t.container}</label>
        <select
          value={containerId}
          onChange={(e) => onSelectContainer(e.target.value)}
          style={{ minWidth: 200 }}
        >
          <option value="">{t.selectContainer}</option>
          {containers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.image.slice(0, 40)})
            </option>
          ))}
        </select>
        <button type="button" className="dexp-btn" onClick={() => refreshContainers()}>
          {t.refresh}
        </button>
        <label>{t.path}</label>
        <input
          className="dexp-path-input"
          value={currentPath}
          onChange={(e) => setCurrentPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") loadDir();
          }}
        />
        <button type="button" className="dexp-btn dexp-btn-primary" onClick={() => loadDir()}>
          {t.open}
        </button>
        <button
          type="button"
          className="dexp-btn"
          onClick={() =>
            setCurrentPath((p) => parentDir(platform, p))
          }
          disabled={!containerId}
        >
          {t.up}
        </button>
        <button
          type="button"
          className="dexp-btn dexp-btn-danger"
          disabled={!selected || !containerId}
          onClick={() => onDelete()}
        >
          {t.delete}
        </button>
        <button
          type="button"
          className="dexp-btn"
          disabled={!selected || selected.isDirectory || !containerId}
          onClick={() => onDownload()}
        >
          {t.download}
        </button>
        <button type="button" className="dexp-btn" onClick={openSettings}>
          {t.settings}
        </button>
        {loading && (
          <span style={{ color: "var(--muted)", fontSize: 11 }}>{t.loading}</span>
        )}
      </div>

      {err && (
        <div className="dexp-banner" style={{ background: "rgba(248,81,73,0.08)" }}>
          {err}
        </div>
      )}

      <div className="dexp-body">
        <div className="dexp-split">
        <div className="dexp-list-pane">
          <div className="dexp-breadcrumb">
            {breadcrumbParts.map((b, i) => (
              <span key={b.path + i}>
                {i > 0 && <span> \ </span>}
                <button
                  type="button"
                  onClick={() => setCurrentPath(b.path)}
                >
                  {b.label}
                </button>
              </span>
            ))}
          </div>
          <div className="dexp-table-wrap">
            <table className="dexp-table">
              <thead>
                <tr>
                  <th style={{ width: "52%" }}>{t.colName}</th>
                  <th style={{ width: "16%" }}>{t.colSize}</th>
                  <th>{t.colModified}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((en) => (
                  <tr
                    key={en.name}
                    className={
                      selected?.name === en.name ? "dexp-row-sel" : ""
                    }
                    onClick={() => setSelected(en)}
                    onDoubleClick={() => openFile(en)}
                  >
                    <td>
                      <span className="dexp-icon">{en.isDirectory ? "📁" : "📄"}</span>
                      {en.name}
                    </td>
                    <td>
                      {en.isDirectory ? "—" : formatSize(en.size)}
                    </td>
                    <td>{en.mtime || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="dexp-editor-pane">
          <div className="dexp-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`dexp-tab ${activeTabId === tab.id ? "dexp-tab-active" : ""}`}
                onClick={() => setActiveTabId(tab.id)}
                title={tab.path}
              >
                {basename(tab.path)}
                {tab.dirty ? " *" : ""}
                <button
                  type="button"
                  className="dexp-tab-close"
                  onClick={(e) => closeTab(tab.id, e)}
                  title={t.closeTab}
                >
                  ×
                </button>
              </button>
            ))}
          </div>
          <div className="dexp-editor-body">
            {activeTab ? (
              <>
                <div className="dexp-editor-meta">
                  {activeTab.path}
                  {activeTab.readOnly && ` · ${t.readOnly}`}
                  {activeTab.binary && ` · ${t.binaryNotEditable}`}
                </div>
                <textarea
                  className="dexp-editor-textarea"
                  value={activeTab.binary ? t.binaryPlaceholder : activeTab.content}
                  onChange={(e) => updateActiveContent(e.target.value)}
                  disabled={activeTab.readOnly || activeTab.binary}
                  spellCheck={false}
                />
                <div className="dexp-editor-actions">
                  {saveDoneFlash && (
                    <span className="dexp-save-feedback" role="status">
                      {t.saveDone}
                    </span>
                  )}
                  <button
                    type="button"
                    className="dexp-btn dexp-btn-primary"
                    disabled={
                      activeTab.readOnly ||
                      activeTab.binary ||
                      !activeTab.dirty ||
                      saveBusy
                    }
                    onClick={() => void saveActive()}
                  >
                    {saveBusy ? t.saving : t.save}
                  </button>
                </div>
              </>
            ) : (
              <div className="dexp-editor-meta" style={{ padding: 8 }}>
                {t.editorHint}
              </div>
            )}
          </div>
        </div>
        </div>

        <div
          className={`dexp-console ${
            consoleOpen ? "" : "dexp-console--collapsed"
          }`}
        >
          <div className="dexp-console-bar">
            <button
              type="button"
              className="dexp-btn"
              onClick={() => setConsoleOpen((o) => !o)}
            >
              {consoleOpen ? t.consoleHide : t.consoleShow}
            </button>
            <span className="dexp-console-title">{t.consoleTitle}</span>
            <span className="dexp-console-hint">{t.consoleHint}</span>
          </div>
          {consoleOpen && (
            <>
              <pre ref={consoleOutRef} className="dexp-console-output">
                {consoleLines.length === 0 ? (
                  <span className="dexp-console-placeholder">
                    {language === "en"
                      ? "Output appears here."
                      : "输出将显示在此处。"}
                  </span>
                ) : (
                  consoleLines.map((ln) => (
                    <span
                      key={ln.id}
                      className={
                        ln.kind === "cmd"
                          ? "dexp-cl-cmd"
                          : ln.kind === "err"
                            ? "dexp-cl-err"
                            : ln.kind === "exit"
                              ? "dexp-cl-exit"
                              : "dexp-cl-out"
                      }
                    >
                      {ln.text}
                      {"\n"}
                    </span>
                  ))
                )}
              </pre>
              <div className="dexp-console-input-row">
                <div className="dexp-console-cwd">
                  {t.consoleCwd}:{" "}
                  <code title={currentPath}>{currentPath}</code>
                </div>
                <div className="dexp-console-controls">
                  {platform === "windows" ? (
                    <select
                      className="dexp-console-shell"
                      value={consoleShell}
                      onChange={(e) =>
                        setConsoleShell(e.target.value as ContainerExecShell)
                      }
                      aria-label="Shell"
                    >
                      <option value="cmd">{t.shellCmd}</option>
                      <option value="powershell">{t.shellPs}</option>
                    </select>
                  ) : (
                    <span className="dexp-console-shell-label">{t.shellSh}</span>
                  )}
                  <input
                    className="dexp-console-cmd"
                    value={consoleInput}
                    onChange={(e) => setConsoleInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void runConsoleCommand();
                    }}
                    placeholder={platform === "windows" ? "dir" : "ls -la"}
                    disabled={!containerId || consoleBusy}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Command"
                  />
                  <button
                    type="button"
                    className="dexp-btn dexp-btn-primary"
                    disabled={
                      !containerId || consoleBusy || !consoleInput.trim()
                    }
                    onClick={() => void runConsoleCommand()}
                  >
                    {consoleBusy ? t.loading : t.consoleRun}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {settingsOpen && (
        <div
          className="dexp-modal-overlay"
          role="presentation"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="dexp-modal"
            role="dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{t.settingsEditableTitle}</h3>
            <p>{t.settingsEditableBody}</p>
            <textarea
              value={editableRaw}
              onChange={(e) => setEditableRaw(e.target.value)}
              placeholder="txt, log, xml, json, yml..."
            />
            <h3 style={{ marginTop: 10 }}>{t.settingsBlockedTitle}</h3>
            <p>{t.settingsBlockedBody}</p>
            <textarea
              value={blockedRaw}
              onChange={(e) => setBlockedRaw(e.target.value)}
              placeholder={
                language === "en" ? "e.g. dat, bak" : "例如: dat bak"
              }
            />
            <div className="dexp-hint">{t.settingsBuiltinHint}</div>
            <div className="dexp-modal-actions">
              <button type="button" className="dexp-btn" onClick={() => setSettingsOpen(false)}>
                {t.cancel}
              </button>
              <button type="button" className="dexp-btn dexp-btn-primary" onClick={saveSettingsClick}>
                {t.save}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

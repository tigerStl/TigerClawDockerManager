/**
 * TigerClawDockerManager — part of the TigerClaw series (TigerClaw 系列产品).
 * @version 1.0.0
 * @author tiger liu
 * @copyright Copyright (c) 2026 tiger liu. All rights reserved.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  uploadZipToContainer,
  uploadFolderToContainer,
  uploadFileToContainer,
  fetchFileMeta,
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

/** Client-side: never offer edit for these (server also enforces on PUT) */
const BUILTIN_BLOCKED = new Set([
  "exe",
  "dll",
  "so",
  "dylib",
  "msi",
  "scr",
  "com",
  "pif",
  "sys",
  "drv",
  "jar",
  "war",
  "ear",
  "vbs",
  "wsf",
  "msc",
  "hta",
  "bin",
]);

/** Scripts: open in editor as read-only (browse); server rejects saves for these types */
const BUILTIN_SCRIPT_VIEW_ONLY = new Set(["bat", "cmd", "ps1"]);

type Settings = {
  editableExtensions: string[];
  extraBlocked: string[];
  /** e.g. Dockerfile, Makefile — server still enforces dangerous types on PUT */
  editableNoExtension: boolean;
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
  editableNoExtension: true,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw)
      return {
        ...DEFAULT_SETTINGS,
        editableExtensions: [...DEFAULT_SETTINGS.editableExtensions],
      };
    const p = JSON.parse(raw) as Settings;
    return {
      editableExtensions: Array.isArray(p.editableExtensions)
        ? p.editableExtensions.map((x) => String(x).toLowerCase().replace(/^\./, ""))
        : [...DEFAULT_SETTINGS.editableExtensions],
      extraBlocked: Array.isArray(p.extraBlocked)
        ? p.extraBlocked.map((x) => String(x).toLowerCase().replace(/^\./, ""))
        : [],
      editableNoExtension:
        typeof (p as Settings).editableNoExtension === "boolean"
          ? (p as Settings).editableNoExtension
          : DEFAULT_SETTINGS.editableNoExtension,
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      editableExtensions: [...DEFAULT_SETTINGS.editableExtensions],
    };
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

/** Parse list `mtime` (ISO or empty) for sorting */
function mtimeMs(mtime: string): number {
  if (!mtime || mtime === "—") return 0;
  const t = Date.parse(mtime.trim());
  return Number.isFinite(t) ? t : 0;
}

type ListSortColumn = "name" | "mtime";
type ListSortDir = "asc" | "desc";

type ListSortState = { column: ListSortColumn; dir: ListSortDir };

const LIST_SORT_STORAGE_KEY = "dockerExplorer.listSort.v1";
const LEGACY_FILE_SORT_KEY = "dockerExplorer.fileSort.v1";

function loadListSortState(): ListSortState {
  try {
    const raw = localStorage.getItem(LIST_SORT_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ListSortState>;
      if (
        (p.column === "name" || p.column === "mtime") &&
        (p.dir === "asc" || p.dir === "desc")
      ) {
        return { column: p.column, dir: p.dir };
      }
    }
    const legacy = localStorage.getItem(LEGACY_FILE_SORT_KEY);
    if (legacy === "mtimeDesc")
      return { column: "mtime", dir: "desc" };
    if (legacy === "mtimeAsc") return { column: "mtime", dir: "asc" };
  } catch {
    /* noop */
  }
  return { column: "name", dir: "asc" };
}

function saveListSortState(s: ListSortState) {
  try {
    localStorage.setItem(LIST_SORT_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* noop */
  }
}

function basename(p: string): string {
  const s = p.replace(/\\/g, "/");
  const j = s.lastIndexOf("/");
  return j >= 0 ? s.slice(j + 1) : p;
}

const ED_SPLIT_KEY = "dockerExplorer.split/editorWidthPx";
/** Keep in sync with `.dexp-splitter` flex-basis / width in dockerExplorer.css */
const ED_SPLITTER_W = 12;
/** Minimum width (px) for the file list pane — allows dragging the splitter left only until the list hits this width. */
const ED_LIST_MIN_W = 300;
const ED_EDITOR_MIN_W = 160;

/** Layout width of the split row (matches `style.width` / flex math; stable under page zoom vs getBoundingClientRect). */
function splitRootLayoutWidthPx(el: HTMLElement): number {
  const ow = el.offsetWidth;
  if (ow > 0) return ow;
  const br = el.getBoundingClientRect().width;
  return Number.isFinite(br) && br > 0 ? br : 0;
}

/** Keeps editor + splitter + list within the split row (no horizontal overflow). */
function clampEditorPaneWidth(w: number, splitRootWidthPx: number): number {
  const maxEditor = splitRootWidthPx - ED_SPLITTER_W - ED_LIST_MIN_W;
  if (!Number.isFinite(maxEditor) || maxEditor <= 0) {
    return Math.max(40, Math.min(w, 120));
  }
  if (maxEditor < ED_EDITOR_MIN_W) {
    // Never force editor wider than maxEditor — that would shrink the list below ED_LIST_MIN_W.
    return Math.max(1, Math.min(w, maxEditor));
  }
  // Upper bound is only maxEditor (split width − splitter − list min). Do not cap with a fixed px
  // (e.g. 900) or after maximizing the window the list cannot shrink further while dragging.
  return Math.max(ED_EDITOR_MIN_W, Math.min(w, maxEditor));
}

function defaultEditorPaneWidth(): number {
  if (typeof window === "undefined") return 420;
  try {
    const raw = localStorage.getItem(ED_SPLIT_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n) && n >= ED_EDITOR_MIN_W) {
      return clampEditorPaneWidth(n, window.innerWidth - 24);
    }
  } catch {
    /* noop */
  }
  return clampEditorPaneWidth(
    Math.min(640, Math.max(280, Math.floor(window.innerWidth * 0.42))),
    window.innerWidth - 24
  );
}

function findNextRange(
  text: string,
  q: string,
  from: number
): [number, number] | null {
  if (!q) return null;
  let i = text.indexOf(q, from);
  if (i < 0 && from > 0) i = text.indexOf(q, 0);
  if (i < 0) return null;
  return [i, i + q.length];
}

function findPrevRange(
  text: string,
  q: string,
  selStart: number
): [number, number] | null {
  if (!q) return null;
  let i = selStart > 0 ? text.lastIndexOf(q, selStart - 1) : -1;
  if (i < 0) i = text.lastIndexOf(q);
  if (i < 0) return null;
  return [i, i + q.length];
}

function IconClose() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconFindPrev() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 15l-6-6-6 6" />
    </svg>
  );
}

function IconFindNext() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M23 4v6h-6" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

const AUTO_REFRESH_KEY = "dockerExplorer.autoRefresh.v1";

type AutoRefreshCfg = { enabled: boolean; intervalMs: number };

function loadAutoRefreshCfg(): AutoRefreshCfg {
  try {
    const raw = localStorage.getItem(AUTO_REFRESH_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<AutoRefreshCfg>;
      const intervalMs =
        typeof p.intervalMs === "number" && p.intervalMs >= 10_000
          ? p.intervalMs
          : 60_000;
      return {
        enabled: !!p.enabled,
        intervalMs: Math.min(3_600_000, intervalMs),
      };
    }
  } catch {
    /* noop */
  }
  return { enabled: false, intervalMs: 60_000 };
}

function saveAutoRefreshCfg(c: AutoRefreshCfg) {
  localStorage.setItem(AUTO_REFRESH_KEY, JSON.stringify(c));
}

export type EditorTab = {
  id: string;
  path: string;
  content: string;
  dirty: boolean;
  readOnly: boolean;
  binary: boolean;
  /** `${size}:${mtime}` from file-meta; used for auto-refresh change detection */
  remoteSig?: string;
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
  colDownload: string;
  downloadFileTitle: string;
  closeTab: string;
  closeEditorTab: string;
  readOnly: string;
  binaryNotEditable: string;
  binaryPlaceholder: string;
  save: string;
  saveDisabledReadOnly: string;
  saveDisabledBinary: string;
  saveDisabledNoChanges: string;
  editorHint: string;
  settingsEditableTitle: string;
  settingsEditableBody: string;
  settingsEditableNoExt: string;
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
  copyPath: string;
  copyPathDone: string;
  findInFile: string;
  findNext: string;
  findPrev: string;
  uploadToggle: string;
  uploadToggleOpen: string;
  uploadToggleClosed: string;
  uploadTitle: string;
  uploadModeZip: string;
  uploadModeFolder: string;
  uploadModeFile: string;
  uploadTarget: string;
  uploadPickZip: string;
  uploadPickFolder: string;
  uploadPickFile: string;
  uploadSubmit: string;
  uploadBusy: string;
  uploadNoZip: string;
  uploadNoFolder: string;
  uploadNoFile: string;
  uploadHint: string;
  editorRefresh: string;
  editorAutoRefresh: string;
  editorDeleteFile: string;
  confirmDeleteEditorFile: (full: string) => string;
  refreshDirtyWarn: string;
  autoRefreshTitle: string;
  autoRefreshEnable: string;
  autoRefreshInterval: string;
  autoRefreshHint: string;
  autoRefreshFsEvents: string;
  consoleReuseShell: string;
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
    colDownload: "下载",
    downloadFileTitle: "下载到本机默认下载文件夹",
    closeTab: "关闭",
    closeEditorTab: "关闭当前标签",
    readOnly: "只读",
    binaryNotEditable: "二进制/不可编辑",
    binaryPlaceholder: "(二进制或不可显示为文本)",
    save: "保存",
    saveDisabledReadOnly:
      "只读或当前设置不允许编辑此扩展名，无法保存（请在「设置」中检查可编辑类型）。",
    saveDisabledBinary: "判定为二进制/不可编辑内容，无法保存。",
    saveDisabledNoChanges: "没有修改，无需保存。",
    editorHint:
      "双击文件在标签页中打开。可编辑类型在「设置」中配置；exe、dll 等受保护类型不可修改。",
    settingsEditableTitle: "可编辑文件类型",
    settingsEditableBody:
      "仅允许编辑下列扩展名（逗号或空格分隔，不含句点）。可填 * 表示除下方禁止项外的所有扩展名。bat、cmd、ps1 可浏览为只读；保存时 exe、dll、jar 等仍由服务器拒绝。",
    settingsEditableNoExt:
      "允许编辑无扩展名文件（如 Dockerfile、Makefile）",
    settingsBlockedTitle: "额外禁止的扩展名（可选）",
    settingsBlockedBody: "在允许列表之外再屏蔽的扩展名，例如特定环境下的敏感类型。",
    settingsBuiltinHint:
      "内置禁止直接编辑：exe、dll、so、msi、jar、bin 等；bat、cmd、ps1 仅只读打开；保存脚本仍由服务器拒绝。",
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
    copyPath: "复制路径",
    copyPathDone: "已复制",
    findInFile: "在文件中查找",
    findNext: "下一处",
    findPrev: "上一处",
    uploadToggle: "上传…",
    uploadToggleOpen: "已打开",
    uploadToggleClosed: "已收起",
    uploadTitle: "上传到容器目录",
    uploadModeZip: "ZIP 压缩包",
    uploadModeFolder: "本地文件夹",
    uploadModeFile: "单个文件",
    uploadTarget: "容器内目标目录",
    uploadPickZip: "选择 .zip",
    uploadPickFolder: "选择文件夹",
    uploadPickFile: "选择文件",
    uploadSubmit: "上传",
    uploadBusy: "上传中…",
    uploadNoZip: "请选择 .zip 文件。",
    uploadNoFolder: "请选择文件夹（含文件）。",
    uploadNoFile: "请选择一个文件。",
    uploadHint:
      "ZIP 在本机解压后复制到目标目录；文件夹会保留相对路径；单个文件以原文件名放入目标目录。单文件最大约 512MB。",
    editorRefresh: "重新加载",
    editorAutoRefresh: "自动刷新",
    editorDeleteFile: "删除文件",
    confirmDeleteEditorFile: (full) =>
      `警告：将从容器中永久删除文件（不可恢复）：\n\n${full}\n\n确定删除？`,
    refreshDirtyWarn:
      "内容已修改未保存。重新加载将丢弃本地修改，是否继续？",
    autoRefreshTitle: "自动刷新",
    autoRefreshEnable: "启用定时从容器重新读取此文件",
    autoRefreshInterval: "间隔",
    autoRefreshHint:
      "通过定时比对文件大小与修改时间实现；有未保存修改时不会覆盖。",
    autoRefreshFsEvents:
      "Docker API 通常不提供宿主机可订阅的容器内文件系统实时事件；若需即时性可在容器内自行运行 inotify 等工具。",
    consoleReuseShell: "复用 Linux shell 会话（实验）",
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
    colDownload: "DL",
    downloadFileTitle: "Download to your default Downloads folder",
    closeTab: "Close",
    closeEditorTab: "Close tab",
    readOnly: "read-only",
    binaryNotEditable: "binary / not editable",
    binaryPlaceholder: "(Binary or not displayable as text)",
    save: "Save",
    saveDisabledReadOnly:
      "Read-only or extension not editable in Settings — cannot save.",
    saveDisabledBinary: "Marked as binary / not editable — cannot save.",
    saveDisabledNoChanges: "No changes to save.",
    editorHint:
      "Double-click a file to open it in a tab. Editable extensions are configured in Settings; protected types such as exe and dll cannot be modified.",
    settingsEditableTitle: "Editable file extensions",
    settingsEditableBody:
      "Only these extensions may be edited (comma- or space-separated, without a leading dot). Use * to allow any extension except built-in / extra blocks. bat, cmd, ps1 open read-only; exe, dll, jar saves are still rejected on the server.",
    settingsEditableNoExt:
      "Allow editing files with no extension (e.g. Dockerfile, Makefile)",
    settingsBlockedTitle: "Additional blocked extensions (optional)",
    settingsBlockedBody:
      "Extensions to block on top of the allow list, for environment-specific sensitive types.",
    settingsBuiltinHint:
      "Built-in: exe, dll, so, msi, jar, bin, etc. are not editable; bat, cmd, ps1 are view-only; saving scripts is still blocked by the API.",
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
    copyPath: "Copy path",
    copyPathDone: "Copied",
    findInFile: "Find in file",
    findNext: "Next match",
    findPrev: "Previous match",
    uploadToggle: "Upload…",
    uploadToggleOpen: "Open",
    uploadToggleClosed: "Closed",
    uploadTitle: "Upload into container folder",
    uploadModeZip: "ZIP archive",
    uploadModeFolder: "Local folder",
    uploadModeFile: "Single file",
    uploadTarget: "Target path in container",
    uploadPickZip: "Choose .zip",
    uploadPickFolder: "Choose folder",
    uploadPickFile: "Choose file",
    uploadSubmit: "Upload",
    uploadBusy: "Uploading…",
    uploadNoZip: "Select a .zip file.",
    uploadNoFolder: "Select a folder (with files).",
    uploadNoFile: "Select a file.",
    uploadHint:
      "ZIP is extracted on the host, then copied into the target. Folder upload preserves relative paths. Single file uses the original file name in the target folder. Max ~512MB per file.",
    editorRefresh: "Reload",
    editorAutoRefresh: "Auto refresh",
    editorDeleteFile: "Delete file",
    confirmDeleteEditorFile: (full) =>
      `Warning: permanently delete this file in the container (cannot undo):\n\n${full}\n\nDelete?`,
    refreshDirtyWarn:
      "You have unsaved changes. Reload will discard local edits. Continue?",
    autoRefreshTitle: "Auto refresh",
    autoRefreshEnable: "Periodically re-read this file from the container",
    autoRefreshInterval: "Interval",
    autoRefreshHint:
      "Uses polling (size + modification time). Won't overwrite while the tab has unsaved edits.",
    autoRefreshFsEvents:
      "Docker does not expose real-time file-change events to the host API; use polling, or run inotify (or similar) inside the container if you need instant updates.",
    consoleReuseShell: "Reuse Linux shell session (experimental)",
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
  const [rawEntries, setRawEntries] = useState<FsEntry[]>([]);
  const [listSort, setListSort] = useState<ListSortState>(loadListSortState);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<FsEntry | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editableRaw, setEditableRaw] = useState("");
  const [blockedRaw, setBlockedRaw] = useState("");
  const [editableNoExt, setEditableNoExt] = useState(true);
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
  const splitRootRef = useRef<HTMLDivElement>(null);
  /** True while splitter drag is active — skip ResizeObserver clamp so RO does not fight pointermove (breaks drag after resize/zoom). */
  const splitDraggingRef = useRef(false);
  const splitDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const editorPaneWidthRef = useRef(defaultEditorPaneWidth());
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);

  const [editorPaneWidth, setEditorPaneWidth] = useState(defaultEditorPaneWidth);
  const [splitDragging, setSplitDragging] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [copyPathFlash, setCopyPathFlash] = useState(false);
  const [uploadPanelOpen, setUploadPanelOpen] = useState(false);
  const [uploadMode, setUploadMode] = useState<"zip" | "folder" | "file">(
    "zip"
  );
  const [uploadTarget, setUploadTarget] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const zipFileInputRef = useRef<HTMLInputElement>(null);
  const folderFileInputRef = useRef<HTMLInputElement>(null);
  const singleFileInputRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<EditorTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const [autoRefreshCfg, setAutoRefreshCfg] = useState<AutoRefreshCfg>(
    loadAutoRefreshCfg
  );
  const [autoDialogOpen, setAutoDialogOpen] = useState(false);
  const [autoDraftEnabled, setAutoDraftEnabled] = useState(false);
  const [autoDraftIntervalMs, setAutoDraftIntervalMs] = useState(60_000);
  const [reuseShellSession, setReuseShellSession] = useState(true);
  const [editorRefreshBusy, setEditorRefreshBusy] = useState(false);

  const onListSortHeaderClick = useCallback((col: ListSortColumn) => {
    setListSort((prev) => {
      const next: ListSortState =
        prev.column === col
          ? { column: col, dir: prev.dir === "asc" ? "desc" : "asc" }
          : { column: col, dir: col === "mtime" ? "desc" : "asc" };
      saveListSortState(next);
      return next;
    });
  }, []);

  const entries = useMemo(() => {
    const list = [...rawEntries];
    list.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (listSort.column === "name") {
        const c = a.name.localeCompare(b.name);
        return listSort.dir === "asc" ? c : -c;
      }
      const ta = mtimeMs(a.mtime);
      const tb = mtimeMs(b.mtime);
      const primary = ta - tb;
      const tie = primary !== 0 ? primary : a.name.localeCompare(b.name);
      return listSort.dir === "asc" ? tie : -tie;
    });
    return list;
  }, [rawEntries, listSort]);

  useEffect(() => {
    editorPaneWidthRef.current = editorPaneWidth;
  }, [editorPaneWidth]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    return () => {
      if (saveDoneTimerRef.current) clearTimeout(saveDoneTimerRef.current);
    };
  }, []);

  /** Clamp editor width to the real split row width (not window.innerWidth — avoids “stuck” splitter). */
  useLayoutEffect(() => {
    const el = splitRootRef.current;
    if (!el) return;
    const clampToRoot = () => {
      if (splitDraggingRef.current) return;
      const rw = splitRootLayoutWidthPx(el);
      if (!(rw > 0)) return;
      setEditorPaneWidth((w) => clampEditorPaneWidth(w, rw));
    };
    clampToRoot();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => clampToRoot());
      ro.observe(el);
    }
    const onWin = () => clampToRoot();
    window.addEventListener("resize", onWin);
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", clampToRoot);
    }
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", onWin);
      if (vv) {
        vv.removeEventListener("resize", clampToRoot);
      }
    };
  }, []);

  useEffect(() => {
    if (!splitDragging) return;
    document.documentElement.classList.add("dexp-split--drag");
    const onMove = (e: PointerEvent) => {
      const drag = splitDragRef.current;
      const rootEl = splitRootRef.current;
      if (!drag || !rootEl) return;
      const rw = splitRootLayoutWidthPx(rootEl);
      if (!(rw > 0)) return;
      const delta = e.clientX - drag.startX;
      const next = clampEditorPaneWidth(drag.startW - delta, rw);
      editorPaneWidthRef.current = next;
      setEditorPaneWidth(next);
    };
    const onUp = () => {
      splitDraggingRef.current = false;
      splitDragRef.current = null;
      setSplitDragging(false);
      document.documentElement.classList.remove("dexp-split--drag");
      try {
        localStorage.setItem(
          ED_SPLIT_KEY,
          String(editorPaneWidthRef.current)
        );
      } catch {
        /* noop */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      splitDraggingRef.current = false;
      document.documentElement.classList.remove("dexp-split--drag");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [splitDragging]);

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
      setRawEntries(data.entries);
    } catch (e) {
      setErr(apiErrorMessage(e));
      setRawEntries([]);
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
      if (ext) {
        if (BUILTIN_SCRIPT_VIEW_ONLY.has(ext)) return false;
        if (BUILTIN_BLOCKED.has(ext)) return false;
        if (settings.extraBlocked.includes(ext)) return false;
        if (settings.editableExtensions.includes("*")) return true;
        return settings.editableExtensions.includes(ext);
      }
      return settings.editableNoExtension;
    },
    [settings]
  );

  useEffect(() => {
    if (!autoRefreshCfg.enabled || !containerId) return;
    const tick = async () => {
      const tid = activeTabIdRef.current;
      if (!tid) return;
      const tab = tabsRef.current.find((x) => x.id === tid);
      if (!tab || tab.binary || tab.dirty) return;
      try {
        const meta = await fetchFileMeta(containerId, tab.path);
        const sig = `${meta.size}:${meta.mtime}`;
        if (tab.remoteSig && sig === tab.remoteSig) return;
        const data = await readFileText(
          containerId,
          tab.path,
          settings.extraBlocked
        );
        const readOnly = !isEditable(basename(tab.path)) || data.binary;
        setTabs((prev) =>
          prev.map((x) =>
            x.id === tab.id
              ? {
                  ...x,
                  content: data.binary ? "" : data.content ?? "",
                  binary: data.binary,
                  readOnly,
                  dirty: false,
                  remoteSig: sig,
                }
              : x
          )
        );
      } catch {
        /* ignore */
      }
    };
    const iv = window.setInterval(tick, autoRefreshCfg.intervalMs);
    void tick();
    return () => clearInterval(iv);
  }, [
    autoRefreshCfg.enabled,
    autoRefreshCfg.intervalMs,
    containerId,
    settings.extraBlocked,
    isEditable,
  ]);

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
      let remoteSig = "";
      try {
        const meta = await fetchFileMeta(containerId, full);
        remoteSig = `${meta.size}:${meta.mtime}`;
      } catch {
        remoteSig = `${data.size}:`;
      }
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
          remoteSig,
        },
      ]);
      setActiveTabId(id);
    } catch (e) {
      setErr(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const downloadListFile = useCallback(
    (entry: FsEntry) => {
      if (!containerId || entry.isDirectory) return;
      const full = joinContainerPath(platform, currentPath, entry.name);
      const url = downloadUrl(containerId, full);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    [containerId, platform, currentPath]
  );

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
      let remoteSig = "";
      try {
        const meta = await fetchFileMeta(containerId, activeTab.path);
        remoteSig = `${meta.size}:${meta.mtime}`;
      } catch {
        /* noop */
      }
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? { ...t, dirty: false, remoteSig: remoteSig || t.remoteSig }
            : t
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

  const saveButtonTitle = useMemo(() => {
    if (!activeTab) return t.save;
    if (activeTab.binary) return t.saveDisabledBinary;
    if (activeTab.readOnly) return t.saveDisabledReadOnly;
    if (!activeTab.dirty) return t.saveDisabledNoChanges;
    return t.save;
  }, [activeTab, t]);

  const reloadEditorFromDisk = async () => {
    if (!activeTab || !containerId || activeTab.binary) return;
    if (activeTab.dirty) {
      const ok = window.confirm(t.refreshDirtyWarn);
      if (!ok) return;
    }
    setEditorRefreshBusy(true);
    setErr(null);
    try {
      const data = await readFileText(
        containerId,
        activeTab.path,
        settings.extraBlocked
      );
      let remoteSig = "";
      try {
        const meta = await fetchFileMeta(containerId, activeTab.path);
        remoteSig = `${meta.size}:${meta.mtime}`;
      } catch {
        remoteSig = `${data.size}:`;
      }
      const readOnly =
        !isEditable(basename(activeTab.path)) || data.binary;
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? {
                ...t,
                content: data.binary ? "" : data.content ?? "",
                binary: data.binary,
                readOnly,
                dirty: false,
                remoteSig,
              }
            : t
        )
      );
    } catch (e) {
      setErr(apiErrorMessage(e));
    } finally {
      setEditorRefreshBusy(false);
    }
  };

  const deleteEditorFile = async () => {
    if (!activeTab || !containerId) return;
    const ok = window.confirm(t.confirmDeleteEditorFile(activeTab.path));
    if (!ok) return;
    setLoading(true);
    setErr(null);
    try {
      await deletePath(containerId, activeTab.path);
      const id = activeTab.id;
      setTabs((prev) => {
        const next = prev.filter((x) => x.id !== id);
        setActiveTabId((cur) => {
          if (cur !== id) return cur;
          return next.length ? next[next.length - 1].id : null;
        });
        return next;
      });
      await loadDir();
    } catch (e) {
      setErr(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const openAutoRefreshDialog = () => {
    setAutoDraftEnabled(autoRefreshCfg.enabled);
    setAutoDraftIntervalMs(autoRefreshCfg.intervalMs);
    setAutoDialogOpen(true);
  };

  const applyAutoRefreshDialog = () => {
    const next: AutoRefreshCfg = {
      enabled: autoDraftEnabled,
      intervalMs: autoDraftIntervalMs,
    };
    setAutoRefreshCfg(next);
    saveAutoRefreshCfg(next);
    setAutoDialogOpen(false);
  };

  const onSplitterPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    splitDraggingRef.current = true;
    splitDragRef.current = {
      startX: e.clientX,
      startW: editorPaneWidthRef.current,
    };
    setSplitDragging(true);
  };

  const copyEditorPath = async () => {
    if (!activeTab?.path) return;
    try {
      await navigator.clipboard.writeText(activeTab.path);
      setCopyPathFlash(true);
      window.setTimeout(() => setCopyPathFlash(false), 1600);
    } catch {
      setErr(
        language === "en" ? "Could not copy path." : "无法复制路径。"
      );
    }
  };

  const findNextClick = () => {
    const ta = editorTextareaRef.current;
    if (!ta || !findQuery) return;
    const range = findNextRange(ta.value, findQuery, ta.selectionEnd);
    if (!range) return;
    ta.focus();
    ta.setSelectionRange(range[0], range[1]);
  };

  const findPrevClick = () => {
    const ta = editorTextareaRef.current;
    if (!ta || !findQuery) return;
    const range = findPrevRange(ta.value, findQuery, ta.selectionStart);
    if (!range) return;
    ta.focus();
    ta.setSelectionRange(range[0], range[1]);
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
        reuseSession:
          platform === "linux" && reuseShellSession && shell === "sh",
      });
      const extra: { kind: "out" | "err" | "exit"; text: string }[] = [];
      if (r.stdout) extra.push({ kind: "out", text: r.stdout });
      if (r.stderr) extra.push({ kind: "err", text: r.stderr });
      if (r.reusedSession) {
        extra.push({
          kind: "out",
          text:
            language === "en"
              ? "(reused Linux exec session)"
              : "（已复用 Linux exec 会话）",
        });
      }
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

  const toggleUploadPanel = () => {
    setUploadPanelOpen((open) => {
      const next = !open;
      if (next) setUploadTarget(currentPath);
      return next;
    });
  };

  const runUpload = async () => {
    if (!containerId) {
      setErr(
        language === "en" ? "Select a container first." : "请先选择容器。"
      );
      return;
    }
    const dest = uploadTarget.trim();
    if (!dest) {
      setErr(
        language === "en" ? "Target path is required." : "请填写目标目录。"
      );
      return;
    }
    setIsUploading(true);
    setErr(null);
    try {
      if (uploadMode === "zip") {
        const f = zipFileInputRef.current?.files?.[0];
        if (!f) {
          setErr(t.uploadNoZip);
        } else {
          await uploadZipToContainer(containerId, dest, f);
          setCurrentPath(dest);
          await loadDir();
        }
      } else if (uploadMode === "folder") {
        const fl = folderFileInputRef.current?.files;
        if (!fl?.length) {
          setErr(t.uploadNoFolder);
        } else {
          await uploadFolderToContainer(containerId, dest, fl);
          setCurrentPath(dest);
          await loadDir();
        }
      } else {
        const f = singleFileInputRef.current?.files?.[0];
        if (!f) {
          setErr(t.uploadNoFile);
        } else {
          await uploadFileToContainer(containerId, dest, f);
          setCurrentPath(dest);
          await loadDir();
        }
      }
    } catch (e) {
      setErr(apiErrorMessage(e));
    } finally {
      setIsUploading(false);
    }
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
    setEditableNoExt(settings.editableNoExtension);
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
    const next: Settings = {
      editableExtensions: editable,
      extraBlocked: blocked,
      editableNoExtension: editableNoExt,
    };
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
        <button
          type="button"
          className={`dexp-btn${uploadPanelOpen ? " dexp-btn--on" : ""}`}
          disabled={!containerId}
          onClick={toggleUploadPanel}
          aria-expanded={uploadPanelOpen}
          aria-pressed={uploadPanelOpen}
          title={`${t.uploadToggle} (${uploadPanelOpen ? t.uploadToggleOpen : t.uploadToggleClosed})`}
        >
          {t.uploadToggle} {uploadPanelOpen ? "▲" : "▼"}
        </button>
        <button type="button" className="dexp-btn" onClick={openSettings}>
          {t.settings}
        </button>
        {loading && (
          <span style={{ color: "var(--muted)", fontSize: 11 }}>{t.loading}</span>
        )}
      </div>

      {uploadPanelOpen && (
        <div className="dexp-upload-strip">
          <div className="dexp-upload-title">{t.uploadTitle}</div>
          <div className="dexp-upload-row">
            <label className="dexp-upload-label">
              <input
                type="radio"
                name="uploadMode"
                checked={uploadMode === "zip"}
                onChange={() => setUploadMode("zip")}
              />{" "}
              {t.uploadModeZip}
            </label>
            <label className="dexp-upload-label">
              <input
                type="radio"
                name="uploadMode"
                checked={uploadMode === "folder"}
                onChange={() => setUploadMode("folder")}
              />{" "}
              {t.uploadModeFolder}
            </label>
            <label className="dexp-upload-label">
              <input
                type="radio"
                name="uploadMode"
                checked={uploadMode === "file"}
                onChange={() => setUploadMode("file")}
              />{" "}
              {t.uploadModeFile}
            </label>
          </div>
          <div className="dexp-upload-row dexp-upload-row--grow">
            <span className="dexp-upload-k">{t.uploadTarget}</span>
            <input
              className="dexp-upload-target"
              value={uploadTarget}
              onChange={(e) => setUploadTarget(e.target.value)}
              spellCheck={false}
              disabled={isUploading}
            />
          </div>
          <div className="dexp-upload-row">
            <input
              ref={zipFileInputRef}
              type="file"
              accept=".zip,application/zip"
              className="dexp-upload-file"
              style={{ display: "none" }}
              disabled={isUploading || uploadMode !== "zip"}
            />
            <input
              ref={folderFileInputRef}
              type="file"
              className="dexp-upload-file"
              style={{ display: "none" }}
              disabled={isUploading || uploadMode !== "folder"}
              multiple
              {...({ webkitdirectory: "" } as Record<string, string>)}
            />
            <input
              ref={singleFileInputRef}
              type="file"
              className="dexp-upload-file"
              style={{ display: "none" }}
              disabled={isUploading || uploadMode !== "file"}
            />
            <button
              type="button"
              className="dexp-btn"
              disabled={isUploading || uploadMode !== "zip"}
              onClick={() => zipFileInputRef.current?.click()}
            >
              {t.uploadPickZip}
            </button>
            <button
              type="button"
              className="dexp-btn"
              disabled={isUploading || uploadMode !== "folder"}
              onClick={() => folderFileInputRef.current?.click()}
            >
              {t.uploadPickFolder}
            </button>
            <button
              type="button"
              className="dexp-btn"
              disabled={isUploading || uploadMode !== "file"}
              onClick={() => singleFileInputRef.current?.click()}
            >
              {t.uploadPickFile}
            </button>
            <button
              type="button"
              className="dexp-btn dexp-btn-primary"
              disabled={!containerId || isUploading}
              onClick={() => void runUpload()}
            >
              {isUploading ? t.uploadBusy : t.uploadSubmit}
            </button>
            <button
              type="button"
              className="dexp-btn"
              disabled={isUploading}
              onClick={() => setUploadPanelOpen(false)}
            >
              {t.cancel}
            </button>
          </div>
          <p className="dexp-upload-hint">{t.uploadHint}</p>
        </div>
      )}

      {err && (
        <div className="dexp-banner" style={{ background: "rgba(248,81,73,0.08)" }}>
          {err}
        </div>
      )}

      <div className="dexp-body">
        <div className="dexp-split" ref={splitRootRef}>
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
                  <th
                    className="dexp-th--sortable"
                    style={{ width: "44%" }}
                    aria-sort={
                      listSort.column === "name"
                        ? listSort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      className="dexp-th-sort-btn"
                      disabled={!containerId}
                      onClick={() => onListSortHeaderClick("name")}
                    >
                      <span className="dexp-th-sort-label">{t.colName}</span>
                      {listSort.column === "name" && (
                        <span className="dexp-sort-caret" aria-hidden>
                          {listSort.dir === "asc" ? "▲" : "▼"}
                        </span>
                      )}
                    </button>
                  </th>
                  <th style={{ width: "14%" }}>{t.colSize}</th>
                  <th
                    className="dexp-th--sortable"
                    style={{ width: "22%" }}
                    aria-sort={
                      listSort.column === "mtime"
                        ? listSort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      className="dexp-th-sort-btn"
                      disabled={!containerId}
                      onClick={() => onListSortHeaderClick("mtime")}
                    >
                      <span className="dexp-th-sort-label">{t.colModified}</span>
                      {listSort.column === "mtime" && (
                        <span className="dexp-sort-caret" aria-hidden>
                          {listSort.dir === "asc" ? "▲" : "▼"}
                        </span>
                      )}
                    </button>
                  </th>
                  <th className="dexp-col-download">{t.colDownload}</th>
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
                    <td className="dexp-col-download">
                      {en.isDirectory ? (
                        "—"
                      ) : (
                        <button
                          type="button"
                          className="dexp-download-btn"
                          title={t.downloadFileTitle}
                          aria-label={t.downloadFileTitle}
                          disabled={!containerId}
                          onClick={(e) => {
                            e.stopPropagation();
                            downloadListFile(en);
                          }}
                        >
                          ↓
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div
          className={`dexp-splitter${splitDragging ? " dexp-splitter--active" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panes"
          onPointerDown={onSplitterPointerDown}
        />

        <div
          className="dexp-editor-pane"
          style={{
            width: editorPaneWidth,
            flex: "0 0 auto",
            minWidth: 0,
            maxWidth: "100%",
          }}
        >
          <div className="dexp-tabs" role="tablist">
            {tabs.map((tab) => {
              const active = activeTabId === tab.id;
              return (
                <div
                  key={tab.id}
                  className={`dexp-tab-wrap${active ? " dexp-tab-wrap--active" : ""}`}
                  role="none"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className="dexp-tab-label"
                    onClick={() => setActiveTabId(tab.id)}
                    title={tab.path}
                  >
                    <span className="dexp-tab-text">
                      {basename(tab.path)}
                      {tab.dirty ? " *" : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="dexp-tab-close"
                    onClick={(e) => closeTab(tab.id, e)}
                    title={t.closeTab}
                    aria-label={`${t.closeTab}: ${basename(tab.path)}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div className="dexp-editor-body">
            {activeTab ? (
              <>
                <div className="dexp-editor-meta-row">
                  <div className="dexp-editor-meta dexp-editor-meta-path">
                    {activeTab.path}
                    {activeTab.readOnly && ` · ${t.readOnly}`}
                    {activeTab.binary && ` · ${t.binaryNotEditable}`}
                  </div>
                  <button
                    type="button"
                    className="dexp-icon-btn"
                    onClick={() => void copyEditorPath()}
                    title={t.copyPath}
                    aria-label={t.copyPath}
                    disabled={!activeTab.path}
                  >
                    <IconCopy />
                  </button>
                  {copyPathFlash && (
                    <span className="dexp-copy-toast" role="status">
                      {t.copyPathDone}
                    </span>
                  )}
                </div>
                <textarea
                  ref={editorTextareaRef}
                  className="dexp-editor-textarea"
                  value={activeTab.binary ? t.binaryPlaceholder : activeTab.content}
                  onChange={(e) => updateActiveContent(e.target.value)}
                  disabled={activeTab.readOnly || activeTab.binary}
                  spellCheck={false}
                />
                <div className="dexp-editor-toolbar">
                  <div className="dexp-editor-filetools">
                    <button
                      type="button"
                      className="dexp-icon-btn"
                      title={t.editorRefresh}
                      aria-label={t.editorRefresh}
                      disabled={
                        activeTab.binary ||
                        editorRefreshBusy ||
                        !containerId
                      }
                      onClick={() => void reloadEditorFromDisk()}
                    >
                      <IconRefresh />
                    </button>
                    <button
                      type="button"
                      className={`dexp-icon-btn${autoRefreshCfg.enabled ? " dexp-icon-btn--on" : ""}`}
                      title={t.editorAutoRefresh}
                      aria-label={t.editorAutoRefresh}
                      disabled={activeTab.binary || !containerId}
                      onClick={openAutoRefreshDialog}
                    >
                      <IconClock />
                    </button>
                    <button
                      type="button"
                      className="dexp-icon-btn dexp-icon-btn--danger"
                      title={t.editorDeleteFile}
                      aria-label={t.editorDeleteFile}
                      disabled={!containerId}
                      onClick={() => void deleteEditorFile()}
                    >
                      <IconTrash />
                    </button>
                    {autoRefreshCfg.enabled && (
                      <span className="dexp-filetools-badge" title={t.autoRefreshHint}>
                        {Math.round(autoRefreshCfg.intervalMs / 1000)}s
                      </span>
                    )}
                  </div>
                  {saveDoneFlash && (
                    <span className="dexp-save-feedback" role="status">
                      {t.saveDone}
                    </span>
                  )}
                  <div className="dexp-find-bar">
                    <input
                      type="search"
                      className="dexp-find-input"
                      placeholder={t.findInFile}
                      value={findQuery}
                      onChange={(e) => setFindQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          findNextClick();
                        }
                      }}
                      disabled={activeTab.binary}
                      aria-label={t.findInFile}
                    />
                    <button
                      type="button"
                      className="dexp-icon-btn"
                      onClick={findPrevClick}
                      disabled={!findQuery || activeTab.binary}
                      title={t.findPrev}
                      aria-label={t.findPrev}
                    >
                      <IconFindPrev />
                    </button>
                    <button
                      type="button"
                      className="dexp-icon-btn"
                      onClick={findNextClick}
                      disabled={!findQuery || activeTab.binary}
                      title={t.findNext}
                      aria-label={t.findNext}
                    >
                      <IconFindNext />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="dexp-btn dexp-btn-primary dexp-editor-save-btn"
                    disabled={
                      activeTab.readOnly ||
                      activeTab.binary ||
                      !activeTab.dirty ||
                      saveBusy
                    }
                    title={saveButtonTitle}
                    aria-label={saveBusy ? t.saving : saveButtonTitle}
                    onClick={() => void saveActive()}
                  >
                    {saveBusy ? t.saving : t.save}
                  </button>
                  <button
                    type="button"
                    className="dexp-icon-btn dexp-editor-close-tab-btn"
                    title={t.closeEditorTab}
                    aria-label={t.closeEditorTab}
                    onClick={() => activeTabId && closeTab(activeTabId)}
                  >
                    <IconClose />
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
                  {platform !== "windows" && (
                    <label className="dexp-console-reuse">
                      <input
                        type="checkbox"
                        checked={reuseShellSession}
                        onChange={(e) =>
                          setReuseShellSession(e.target.checked)
                        }
                      />
                      <span>{t.consoleReuseShell}</span>
                    </label>
                  )}
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

      {autoDialogOpen && (
        <div
          className="dexp-modal-overlay"
          role="presentation"
          onClick={() => setAutoDialogOpen(false)}
        >
          <div
            className="dexp-modal dexp-modal--wide"
            role="dialog"
            aria-labelledby="auto-refresh-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="auto-refresh-title">{t.autoRefreshTitle}</h3>
            <label className="dexp-auto-row">
              <input
                type="checkbox"
                checked={autoDraftEnabled}
                onChange={(e) => setAutoDraftEnabled(e.target.checked)}
              />
              <span>{t.autoRefreshEnable}</span>
            </label>
            <label className="dexp-auto-row">
              <span>{t.autoRefreshInterval}</span>
              <select
                value={autoDraftIntervalMs}
                onChange={(e) =>
                  setAutoDraftIntervalMs(parseInt(e.target.value, 10))
                }
              >
                <option value={30_000}>30 s</option>
                <option value={60_000}>1 min</option>
                <option value={120_000}>2 min</option>
                <option value={300_000}>5 min</option>
                <option value={600_000}>10 min</option>
              </select>
            </label>
            <p className="dexp-hint">{t.autoRefreshHint}</p>
            <p className="dexp-hint">{t.autoRefreshFsEvents}</p>
            <div className="dexp-modal-actions">
              <button
                type="button"
                className="dexp-btn"
                onClick={() => setAutoDialogOpen(false)}
              >
                {t.cancel}
              </button>
              <button
                type="button"
                className="dexp-btn dexp-btn-primary"
                onClick={applyAutoRefreshDialog}
              >
                {t.save}
              </button>
            </div>
          </div>
        </div>
      )}

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
            <label
              className="dexp-upload-label"
              style={{ display: "block", marginBottom: 8 }}
            >
              <input
                type="checkbox"
                checked={editableNoExt}
                onChange={(e) => setEditableNoExt(e.target.checked)}
              />{" "}
              {t.settingsEditableNoExt}
            </label>
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

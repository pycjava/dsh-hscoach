/**
 * 炉石日志杂务：hscoach/log_config.py 的 TS 移植。
 *
 * - 找安装目录：常见候选 → 注册表 InstallLocation 兜底（reg query 子进程，
 *   零 npm 依赖；对应 Python 的 winreg 兜底，提交 d8faf32）
 * - 写 log.config（HDT 标准内容，备份后覆盖，支持一键回滚）
 * - 解析 Power.log 路径：国服安装目录 Logs/时间戳子目录/ 取最新，
 *   全球版 LocalAppData
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LOG_CONFIG_CONTENT = `[Power]
LogLevel=1
FilePrinting=true
ConsolePrinting=false
ScreenPrinting=false

[Zone]
LogLevel=1
FilePrinting=true
ConsolePrinting=false
ScreenPrinting=false

[GameState]
LogLevel=1
FilePrinting=true
ConsolePrinting=false
ScreenPrinting=false

[LoadingScreen]
LogLevel=1
FilePrinting=true
ConsolePrinting=false
ScreenPrinting=false
`;

export const BACKUP_SUFFIX = ".bak.ntetoolbox";

export interface LogConfigStatus {
  action: "created" | "updated" | "already_ok" | "restored";
  path: string;
  backupPath: string | null;
  message: string;
}

/** reg query 读注册表 InstallLocation（任何失败静默跳过）。 */
async function registryInstallDirs(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const roots = ["HKLM", "HKCU"];
  const subs = [
    "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hearthstone",
    "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hearthstone",
  ];
  const results: string[] = [];
  for (const root of roots) {
    for (const sub of subs) {
      try {
        const { stdout } = await execFileAsync("reg", ["query", `${root}\\${sub}`, "/v", "InstallLocation"]);
        const m = /InstallLocation\s+REG_(?:_SZ|EXPAND_SZ)\s+(.+)/.exec(stdout.trim());
        if (m && m[1].trim()) results.push(m[1].trim());
      } catch {
        // 键不存在或 reg 不可用：跳过
      }
    }
  }
  return results;
}

/** 炉石安装目录：常见候选 → 注册表兜底（校验 Hearthstone.exe 存在）。 */
export async function hearthstoneInstallDir(): Promise<string | null> {
  const candidates = [
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Hearthstone"),
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Hearthstone"),
    ...(await registryInstallDirs()),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "Hearthstone.exe"))) return candidate;
  }
  return null;
}

/** 炉石 LocalAppData 目录（log.config 所在）。 */
export function hearthstoneDataDir(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(local, "Blizzard", "Hearthstone");
}

export function logConfigPath(): string {
  return join(hearthstoneDataDir(), "log.config");
}

/** 最新 Power.log 路径：国服时间戳子目录 → 全球版 LocalAppData。 */
export async function powerLogPath(): Promise<string> {
  const install = await hearthstoneInstallDir();
  if (install) {
    const logsRoot = join(install, "Logs");
    if (existsSync(logsRoot)) {
      try {
        const entries = await readdir(logsRoot, { withFileTypes: true });
        const candidates = entries
          .filter((e) => e.isDirectory() && existsSync(join(logsRoot, e.name, "Power.log")))
          .map((e) => e.name)
          .sort()
          .reverse();
        if (candidates.length > 0) {
          return join(logsRoot, candidates[0], "Power.log");
        }
      } catch {
        // 读取失败回退 LocalAppData
      }
    }
  }
  return join(hearthstoneDataDir(), "Logs", "Power.log");
}

/** 确保 log.config 存在且开启 Power 日志（覆盖前备份）。 */
export async function ensureLogConfig(backup = true): Promise<LogConfigStatus> {
  const target = logConfigPath();
  await mkdir(join(target, ".."), { recursive: true });

  if (existsSync(target)) {
    const existing = await readFile(target, "utf-8").catch(() => "");
    if (existing.includes("[Power]") && existing.includes("FilePrinting=true")) {
      return {
        action: "already_ok",
        path: target,
        backupPath: null,
        message: "log.config 已开启 Power 日志（FilePrinting=true），无需修改。",
      };
    }
    let backupPath: string | null = null;
    if (backup) {
      backupPath = target + BACKUP_SUFFIX;
      await copyFile(target, backupPath);
    }
    await writeFile(target, LOG_CONFIG_CONTENT, "utf-8");
    return {
      action: "updated",
      path: target,
      backupPath,
      message: "log.config 已更新（原文件已备份）。",
    };
  }

  await writeFile(target, LOG_CONFIG_CONTENT, "utf-8");
  return {
    action: "created",
    path: target,
    backupPath: null,
    message: "log.config 已创建（首次启用炉石日志）。",
  };
}

/** 一键回滚：恢复备份，或删除工具创建的 log.config。 */
export async function restoreLogConfig(): Promise<LogConfigStatus> {
  const target = logConfigPath();
  const backupPath = target + BACKUP_SUFFIX;
  if (!existsSync(backupPath)) {
    if (existsSync(target)) {
      await unlink(target);
      return {
        action: "restored",
        path: target,
        backupPath: null,
        message: "已删除工具创建的 log.config（炉石将停止写日志）。",
      };
    }
    return {
      action: "restored",
      path: target,
      backupPath: null,
      message: "无需回滚（log.config 不存在且无备份）。",
    };
  }
  await rename(backupPath, target);
  return {
    action: "restored",
    path: target,
    backupPath: null,
    message: "已恢复原始 log.config。",
  };
}

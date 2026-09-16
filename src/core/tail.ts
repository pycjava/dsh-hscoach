/**
 * Power.log tail。
 *
 * 健壮性要点：
 * - 每次轮询重解析路径：国服每次启动新建 Logs/<时间戳>/ 目录
 * - 文件轮换检测：创建时间变化或大小倒退 → 从头读
 * - 启动时文件已存在 → 从末尾 tail（不重放历史对局）；
 *   文件"首次出现"或轮换 → 从头读（含 CREATE_GAME，跨局状态才能重置）
 */
import { open, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export interface TailOptions {
  pollIntervalMs?: number;
  /** 路径解析器（默认由 logConfig.powerLogPath 注入；测试可替换）。 */
  resolvePath: () => Promise<string>;
  /** 收到一批新行；返回 false 停止 tail。 */
  onLines: (lines: string[]) => false | void | Promise<false | void>;
  shouldStop?: () => boolean;
  /** 测试注入的时钟。 */
  sleep?: (ms: number) => Promise<void>;
}

const CHUNK = 1 << 16;
const decoder = new TextDecoder("utf-8", { fatal: false });

/** 显式 offset 的顺序读取器（附未完结行的 carry 缓冲）。 */
class LineReader {
  private handle: FileHandle | null = null;
  private path: string | null = null;
  private offset = 0;
  private carry = "";

  get currentPath(): string | null {
    return this.path;
  }

  /** 打开（或切换到）路径；fromHead=true 从头读，否则从末尾 tail。 */
  async openAt(path: string, fromHead: boolean): Promise<void> {
    await this.close();
    this.handle = await open(path, "r");
    this.path = path;
    const s = await this.handle.stat();
    this.offset = fromHead ? 0 : s.size;
    this.carry = "";
  }

  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    this.path = null;
  }

  /** 读新增内容并按行切；文件无新增返回空数组。 */
  async readLines(): Promise<string[]> {
    if (!this.handle) return [];
    const chunks: string[] = [];
    for (;;) {
      const buf = new Uint8Array(CHUNK);
      const { bytesRead } = await this.handle.read(buf, 0, CHUNK, this.offset);
      if (bytesRead === 0) break;
      this.offset += bytesRead;
      chunks.push(decoder.decode(buf.subarray(0, bytesRead)));
    }
    if (chunks.length === 0) return [];
    const parts = (this.carry + chunks.join("")).split(/\r?\n/);
    this.carry = parts.pop() ?? "";
    return parts.filter((line) => line.length > 0);
  }
}

export class PowerLogTail {
  private stopped = false;
  private readonly pollIntervalMs: number;
  private readonly resolvePath: () => Promise<string>;
  private readonly onLines: TailOptions["onLines"];
  private readonly shouldStop: () => boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TailOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 300;
    this.resolvePath = options.resolvePath;
    this.onLines = options.onLines;
    this.shouldStop = options.shouldStop ?? (() => false);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  stop(): void {
    this.stopped = true;
  }

  /** 主循环；由 stop()/shouldStop 或 onLines 返回 false 退出。 */
  async run(): Promise<void> {
    const reader = new LineReader();
    let justAppeared = false;
    let lastCtime = 0;
    let lastSize = 0;

    try {
      while (!this.stopped && !this.shouldStop()) {
        const path = await this.resolvePath();
        if (reader.currentPath !== null && reader.currentPath !== path) {
          // 国服重启后新时间戳目录 → 切换并从头读
          justAppeared = true;
        }

        if (!existsSync(path)) {
          await reader.close();
          justAppeared = true;
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        let fileStat: { ctimeMs: number; size: number };
        try {
          const s = await stat(path);
          fileStat = { ctimeMs: s.birthtimeMs || s.ctimeMs, size: s.size };
        } catch {
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        if (reader.currentPath === null) {
          await reader.openAt(path, justAppeared);
          justAppeared = false;
          lastCtime = fileStat.ctimeMs;
          lastSize = fileStat.size;
        } else {
          const rotated =
            process.platform === "win32"
              ? fileStat.ctimeMs !== lastCtime || fileStat.size < lastSize
              : fileStat.size < lastSize;
          if (rotated) {
            await reader.openAt(path, true);
          }
          lastCtime = fileStat.ctimeMs;
          lastSize = fileStat.size;
        }

        const lines = await reader.readLines();
        if (lines.length > 0) {
          const keepGoing = await this.onLines(lines);
          if (keepGoing === false) return;
        }

        await this.sleep(this.pollIntervalMs);
      }
    } finally {
      await reader.close();
    }
  }
}

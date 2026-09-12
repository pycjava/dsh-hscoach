/**
 * 对局结果与战绩统计：hscoach/history.py 的 TS 移植。
 *
 * PLAYSTATE 终局值写在玩家实体上（PlayerOne/PlayerTwo/数字 id/国服昵称），
 * 按友方实体取值；每局只记一次；history.jsonl 追加 + stats.json 原子重写。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCreateGameLine } from "./parser.js";

export const HISTORY_FILENAME = "history.jsonl";
export const STATS_FILENAME = "stats.json";

type Result = "win" | "loss" | "tie";

const RESULT_MAP: Record<string, Result> = { WON: "win", LOST: "loss", TIED: "tie" };

const PLAYSTATE_RE = /Entity=(\S+)\s+tag=PLAYSTATE\s+value=(\w+)/;
const PLAYER_ENTITY_RE = /Player EntityID=(\d+)\s+PlayerID=(\d+)/;
const PLAYER_NAME_RE = /PlayerID=(\d+),\s*PlayerName=(\S+)/;
const NAME_TO_ENTITY_ID: Record<string, number> = { PlayerOne: 2, PlayerTwo: 3 };

export interface HistoryStats {
  total: number;
  wins: number;
  losses: number;
  ties: number;
  winrate_pct: number;
}

/** 从原始日志行检测友方终局结果（正则，极快）。 */
export class GameResultDetector {
  friendlyPlayerId: number;
  private fired = false;
  private entityToPlayer = new Map<number, number>();
  private nameToPlayer = new Map<string, number>();

  constructor(friendlyPlayerId = 1) {
    this.friendlyPlayerId = friendlyPlayerId;
  }

  /** 喂入原始行，返回本次检测到的友方终局结果列表。 */
  feed(lines: string[]): Result[] {
    const results: Result[] = [];
    for (const line of lines) {
      if (isCreateGameLine(line)) {
        // 只认 GameState.DebugPrintPower 的 CREATE_GAME（国服 PowerTaskList
        // 重复行不是边界，否则刚建的映射被误清）
        this.fired = false;
        this.entityToPlayer.clear();
        this.nameToPlayer.clear();
        continue;
      }
      if (line.includes("Player EntityID=")) {
        const m = PLAYER_ENTITY_RE.exec(line);
        if (m) this.entityToPlayer.set(Number(m[1]), Number(m[2]));
        continue;
      }
      if (line.includes("PlayerName=")) {
        const m = PLAYER_NAME_RE.exec(line);
        if (m) this.nameToPlayer.set(m[2], Number(m[1]));
        continue;
      }
      if (this.fired || !line.includes("tag=PLAYSTATE")) continue;
      const m = PLAYSTATE_RE.exec(line);
      if (!m) continue;
      const [token, value] = [m[1], m[2]];
      const mapped = RESULT_MAP[value];
      if (!mapped) continue; // PLAYING/WINNING/LOSING 非终局
      const pid = this.resolvePlayerId(token);
      if (pid === null || pid !== this.friendlyPlayerId) continue;
      this.fired = true;
      results.push(mapped);
    }
    return results;
  }

  private resolvePlayerId(token: string): number | null {
    const byName = this.nameToPlayer.get(token);
    if (byName !== undefined) return byName;
    let eid: number;
    if (/^\d+$/.test(token)) {
      eid = Number(token);
    } else {
      const mapped = NAME_TO_ENTITY_ID[token];
      if (mapped === undefined) return null;
      eid = mapped;
    }
    return this.entityToPlayer.get(eid) ?? eid - 1;
  }

  reset(): void {
    this.fired = false;
    this.entityToPlayer.clear();
    this.nameToPlayer.clear();
  }
}

export interface HistoryEntry {
  timestamp: string;
  result: Result;
  friendly_class: string;
  opponent_class: string;
  turns: number;
}

/** 本地时间 ISO（秒精度，无时区后缀）——与 Python datetime.now().isoformat(timespec="seconds") 一致。 */
export function localIsoSeconds(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 记录一局：追加 history.jsonl + 原子重写 stats.json，返回聚合战绩。 */
export async function recordResult(
  publishDir: string,
  result: Result,
  friendlyClass: string,
  opponentClass: string,
  turns: number,
): Promise<HistoryStats> {
  await mkdir(publishDir, { recursive: true });
  const entry: HistoryEntry = {
    timestamp: localIsoSeconds(),
    result,
    friendly_class: friendlyClass || "未知",
    opponent_class: opponentClass || "未知",
    turns,
  };
  const historyPath = join(publishDir, HISTORY_FILENAME);
  await appendFile(historyPath, JSON.stringify(entry) + "\n", "utf-8");
  const stats = await aggregate(historyPath);
  await atomicWriteJson(join(publishDir, STATS_FILENAME), stats);
  return stats;
}

/** 从 history.jsonl 聚合战绩；缺失/损坏返回空战绩。 */
export async function aggregate(historyPath: string): Promise<HistoryStats> {
  const stats: HistoryStats = { total: 0, wins: 0, losses: 0, ties: 0, winrate_pct: 0 };
  if (!existsSync(historyPath)) return stats;
  let text: string;
  try {
    text = await readFile(historyPath, "utf-8");
  } catch {
    return stats;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { result?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 容忍损坏行
    }
    stats.total += 1;
    if (entry.result === "win") stats.wins += 1;
    else if (entry.result === "loss") stats.losses += 1;
    else stats.ties += 1;
  }
  if (stats.total) {
    stats.winrate_pct = Math.round((stats.wins / stats.total) * 1000) / 10;
  }
  return stats;
}

/** 原子写 JSON（tmp + rename，读者永不看到半写状态）。 */
export async function atomicWriteJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

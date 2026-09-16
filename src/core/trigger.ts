/**
 * 回合触发器 + 建议发布。
 *
 * 增量检测（正则扫原始行）+ 触发窗口截取（同批后续回合的行不污染快照）
 * + advice.json/game_state.json 原子发布（契约与 Tauri 侧轮询一致）。
 * latest-wins（"新请求覆盖未启动的旧请求"）由引擎层代数计数实现。
 */
import { join } from "node:path";
import { atomicWriteJson, localIsoSeconds } from "./history.js";
import { isCreateGameLine } from "./parser.js";
import { snapshotToContract, type GameSnapshot } from "./state.js";
import { drawOddsTable } from "./probability.js";

export const ADVICE_FILENAME = "advice.json";
export const GAME_STATE_FILENAME = "game_state.json";
/** Tauri"再想想"按钮写入的触发文件名（插件 watch 该文件的出现）。 */
export const THINK_AGAIN_FILENAME = "think-again.trigger";

const TURN_RE = /tag=TURN\s+value=(\d+)/;
const CURRENT_PLAYER_RE = /Entity=(PlayerOne|PlayerTwo|\d+)\s+tag=CURRENT_PLAYER\s+value=(\d+)/;
const PLAYER_ENTITY_RE = /Player EntityID=(\d+) PlayerID=(\d+)/;
const NAME_TO_ENTITY_ID: Record<string, number> = { PlayerOne: 2, PlayerTwo: 3 };

/** 回合规则单实现：轮到友方的新回合（turn 递增 + 当前玩家是友方）。 */
export function isNewFriendlyTurn(
  turn: number,
  currentPlayerId: number | null,
  friendlyPlayerId: number,
  lastTurn: number,
): boolean {
  return currentPlayerId === friendlyPlayerId && turn > lastTurn;
}

/**
 * 增量回合检测器：扫描原始行检测 TURN/CURRENT_PLAYER 变化。
 * prefilterFriendly=false 时返回全部新回合（国服中文昵称无法正则预过滤，
 * 由全量解析 + isNewFriendlyTurn 精确过滤）。
 */
export class IncrementalTurnDetector {
  friendlyPlayerId: number;
  prefilterFriendly: boolean;
  private allLines: string[] = [];
  private lastTurn = 0;
  private currentPlayer: number | null = null;
  private entityToPlayer = new Map<number, number>();
  private triggerUpto = new Map<number, number>();

  constructor(friendlyPlayerId: number, prefilterFriendly = true) {
    this.friendlyPlayerId = friendlyPlayerId;
    this.prefilterFriendly = prefilterFriendly;
  }

  private resolvePlayerId(token: string): number | null {
    const eid = /^\d+$/.test(token) ? Number(token) : NAME_TO_ENTITY_ID[token];
    if (eid === undefined) return null;
    return this.entityToPlayer.get(eid) ?? eid - 1;
  }

  /** 喂入新行，返回本次触发的回合号列表。 */
  feed(lines: string[]): number[] {
    const triggered: number[] = [];
    for (const line of lines) {
      this.allLines.push(line);
      if (isCreateGameLine(line)) {
        this.entityToPlayer.clear();
      } else if (line.includes("Player EntityID=")) {
        const m = PLAYER_ENTITY_RE.exec(line);
        if (m) this.entityToPlayer.set(Number(m[1]), Number(m[2]));
      } else if (line.includes("tag=TURN")) {
        const m = TURN_RE.exec(line);
        if (m) {
          const turn = Number(m[1]);
          const previousTurn = this.lastTurn;
          if (turn > previousTurn) {
            this.lastTurn = turn;
            const friendlyTurn = isNewFriendlyTurn(
              turn,
              this.currentPlayer,
              this.friendlyPlayerId,
              previousTurn,
            );
            if (!this.prefilterFriendly || friendlyTurn) {
              this.triggerUpto.set(turn, this.allLines.length);
              triggered.push(turn);
            }
          }
        }
      } else if (line.includes("tag=CURRENT_PLAYER")) {
        const m = CURRENT_PLAYER_RE.exec(line);
        if (m) {
          const [token, flag] = [m[1], m[2]];
          if (flag === "1") {
            const pid = this.resolvePlayerId(token);
            if (pid !== null) this.currentPlayer = pid;
          }
        }
      }
    }
    return triggered;
  }

  /** 截至指定触发回合（含其 TURN 行）的行流，用于全量解析。 */
  getTriggerWindow(turn: number): string[] {
    const upto = this.triggerUpto.get(turn) ?? this.allLines.length;
    return this.allLines.slice(0, upto);
  }

  getAllLines(): string[] {
    return this.allLines;
  }

  reset(): void {
    this.allLines = [];
    this.lastTurn = 0;
    this.currentPlayer = null;
    this.entityToPlayer.clear();
    this.triggerUpto.clear();
  }
}

/** 建议数据契约（advice.json 的 advice 字段）。 */
export interface Advice {
  kind: "play" | "trade" | "pass" | "uncertain";
  headline: string;
  why: string;
  steps: string[];
  warning: string;
  alternatives: Array<{ headline: string; why: string }>;
  latency_ms: number;
  degraded: boolean;
  lethal: boolean;
}

export function emptyAdvice(): Advice {
  return {
    kind: "uncertain",
    headline: "",
    why: "",
    steps: [],
    warning: "",
    alternatives: [],
    latency_ms: 0,
    degraded: false,
    lethal: false,
  };
}

/** 原子写 advice.json（契约：{turn, timestamp, advice}）。 */
export async function publishAdvice(
  publishDir: string,
  advice: Advice,
  turn: number,
): Promise<string> {
  const target = join(publishDir, ADVICE_FILENAME);
  await atomicWriteJson(target, {
    turn,
    timestamp: localIsoSeconds(),
    advice,
  });
  return target;
}

/** 原子写 game_state.json（实时快照，友方注入抽牌概率参考）。 */
export async function publishGameState(
  publishDir: string,
  snapshot: GameSnapshot,
  friendlyPlayerId: number,
): Promise<string> {
  const target = join(publishDir, GAME_STATE_FILENAME);
  const contract = snapshotToContract(snapshot);
  const friendly = contract.players[String(friendlyPlayerId)];
  if (friendly && friendly.deck_count > 0) {
    friendly.draw_odds = drawOddsTable(friendly.deck_count);
  }
  await atomicWriteJson(target, {
    turn: contract.turn,
    current_player_id: contract.current_player_id,
    friendly_player_id: friendlyPlayerId,
    timestamp: localIsoSeconds(),
    players: contract.players,
  });
  return target;
}

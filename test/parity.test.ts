/**
 * 对拍验收（Q16 硬门槛）：TS 确定性核心 vs Python 黄金快照逐字段比对。
 *
 * 黄金快照为迁移期由 Python 实现（已删除）生成的冻结基准：
 * TS 核心自此成为唯一事实源，本测试作为行为回归钉。
 * 两份 fixture：外服标准日志（15 触发回合）+ 国服格式双局日志
 * （含 PowerTaskList 重复 CREATE_GAME、中文战网昵称映射等坑）。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CardDatabase } from "../src/core/cards.js";
import { GameResultDetector } from "../src/core/history.js";
import { computeLethal } from "../src/core/lethal.js";
import { parsePowerLog } from "../src/core/parser.js";
import { calibrateFriendlyPlayer, serializeGame, snapshotToContract } from "../src/core/state.js";
import { IncrementalTurnDetector } from "../src/core/trigger.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const GOLDEN = join(HERE, "golden");

interface GoldenFile {
  fixture: string;
  friendly_player_id: number;
  triggered_turns: number[];
  turns: Array<{
    turn: number;
    friendly_player_id: number;
    snapshot: Record<string, unknown>;
    lethal: Record<string, unknown>;
  }>;
  game_results: string[];
}

const db = new CardDatabase([join(HERE, "..", "data")]);

/** 与黄金生成器完全一致的管线（批处理边界逐行对齐）。 */
function runPipeline(lines: string[]) {
  const detector = new IncrementalTurnDetector(1, false);
  let friendlyPlayerId = 1;
  const turns: Array<{
    turn: number;
    friendlyPlayerId: number;
    snapshot: unknown;
    lethal: ReturnType<typeof computeLethal>;
  }> = [];
  let batch: string[] = [];
  for (const line of lines) {
    batch.push(line);
    if (batch.length >= 50 || line.includes("TAG_CHANGE")) {
      const triggered = detector.feed(batch);
      batch = [];
      for (const turn of triggered) {
        const result = parsePowerLog(detector.getTriggerWindow(turn));
        if (result.games.length === 0) continue;
        const game = result.games[result.games.length - 1];
        const calibrated = calibrateFriendlyPlayer(game);
        if (calibrated !== null) friendlyPlayerId = calibrated;
        const snapshot = serializeGame(game, friendlyPlayerId, db);
        const lethal = computeLethal(snapshot, friendlyPlayerId);
        turns.push({
          turn,
          friendlyPlayerId,
          snapshot: snapshotToContract(snapshot),
          lethal,
        });
      }
    }
  }
  return { detector, friendlyPlayerId, turns };
}

describe.each([
  ["friendly_player_id_is_1.power", "外服标准日志"],
  ["cn_server_two_games.power", "国服格式日志"],
])("对拍：%s（%s）", (stem) => {
  it("快照/斩杀/触发回合/终局与 Python 黄金逐字段一致", async () => {
    await db.build();
    const golden = JSON.parse(
      readFileSync(join(GOLDEN, `${stem}.golden.json`), "utf-8"),
    ) as GoldenFile;
    const lines = readFileSync(join(FIXTURES, `${stem}.log`), "utf-8").split(/\r?\n/);

    const { turns, friendlyPlayerId } = runPipeline(lines);

    // 触发回合序列一致（含国服 prefilter=false 的全部新回合）
    expect(turns.map((t) => t.turn)).toEqual(golden.triggered_turns);
    expect(turns.length).toBe(golden.turns.length);

    for (let i = 0; i < golden.turns.length; i++) {
      const gold = golden.turns[i];
      const mine = turns[i];
      expect(mine.turn, `turns[${i}].turn`).toBe(gold.turn);
      expect(mine.friendlyPlayerId, `turns[${i}].friendly`).toBe(gold.friendly_player_id);
      // 快照逐字段（JSON 序列化后比对，避免键序干扰）
      expect(JSON.parse(JSON.stringify(mine.snapshot)), `turns[${i}].snapshot`).toEqual(
        gold.snapshot,
      );
      // 斩杀结果逐字段
      expect(
        {
          available_damage: mine.lethal.availableDamage,
          lethal: mine.lethal.lethal,
          detail: mine.lethal.detail,
          deficit: mine.lethal.deficit,
          taunt_blocked: mine.lethal.tauntBlocked,
          taunt_cost: mine.lethal.tauntCost,
          opponent_fatigue_damage: mine.lethal.opponentFatigueDamage,
          summary: mine.lethal.summary(),
        },
        `turns[${i}].lethal`,
      ).toEqual(gold.lethal);
    }

    // 终局结果（以最终校准的友方 id 全量重放）
    const detector = new GameResultDetector(friendlyPlayerId);
    const results = detector.feed(lines);
    expect(results).toEqual(golden.game_results);
    expect(friendlyPlayerId).toBe(golden.friendly_player_id);
  });
});

/**
 * 工具层功能测试：D9 不变量（工具从构造上不可能泄露对手手牌）+
 * 三个工具的行为正确性。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCoachTools,
  cardLookupTool,
  drawOddsTool,
  historyStatsTool,
} from "../src/advice/tools.js";
import type { CardDatabase, Card } from "../src/core/cards.js";
import type { GameSnapshot } from "../src/core/state.js";

function fakeDb(cards: Card[]): CardDatabase {
  const map = new Map(cards.map((c) => [c.id, c]));
  return {
    get: (id: string) => map.get(id),
    iterCards: () => [...map.values()],
    has: (id: string) => map.has(id),
    size: map.size,
  } as unknown as CardDatabase;
}

const FIREBALL: Card = {
  id: "CS2_029",
  name: "火球术",
  text: "造成 6 点伤害。",
  cost: 4,
  attack: null,
  health: null,
  type: "SPELL",
  cardClass: "MAGE",
  cardSet: "CORE",
};

function fakeSnapshot(): GameSnapshot {
  return {
    turn: 5,
    currentPlayerId: 1,
    players: {
      "1": {
        name: "玩家1",
        hero: null,
        health: 25,
        armor: 0,
        mana: 6,
        maxMana: 6,
        hand: [],
        board: [],
        deckCount: 20,
        fatigue: 0,
        playedCards: [],
        secrets: 0,
        possibleSecrets: [],
      },
      "2": {
        name: "玩家2",
        hero: null,
        health: 18,
        armor: 2,
        mana: 5,
        maxMana: 5,
        hand: { count: 7 }, // D9：对手手牌只有数量
        board: [],
        deckCount: 22,
        fatigue: 0,
        playedCards: [],
        secrets: 0,
        possibleSecrets: [],
      },
    },
  };
}

const deps = { db: fakeDb([FIREBALL]), snapshot: fakeSnapshot(), friendlyPlayerId: 1, publishDir: "/tmp/x" };

describe("工具层", () => {
  it("D9 不变量：全部工具的输出序列化后不含任何对手手牌卡牌对象", async () => {
    for (const tool of buildCoachTools(deps)) {
      const args = tool.name === "hs_card_lookup" ? { query: "火球" } : tool.name === "hs_draw_odds" ? { copies: 2 } : {};
      const result = await tool.execute(args, {
        concludeTurn: () => {},
        signal: new AbortController().signal,
        name: tool.name,
      });
      const json = JSON.stringify(result);
      expect(json.includes("card_id"), `${tool.name} 不应暴露卡牌 id 列表`).toBe(
        tool.name === "hs_card_lookup", // 卡牌查询工具本身就是查公开卡牌信息
      );
    }
  });

  it("卡牌查询：按名称命中并返回公开信息", async () => {
    const result = await cardLookupTool(deps).execute({ query: "火球" }, {
      concludeTurn: () => {},
      signal: new AbortController().signal,
      name: "hs_card_lookup",
    });
    expect(result).toMatchObject({
      cards: [expect.objectContaining({ card_id: "CS2_029", name: "火球术", cost: 4 })],
    });
  });

  it("抽牌概率：20 张牌库 2 张目标下回合概率 = 2/20", async () => {
    const result = (await drawOddsTool(deps).execute({ copies: 2 }, {
      concludeTurn: () => {},
      signal: new AbortController().signal,
      name: "hs_draw_odds",
    })) as { probability_at_least_one: number };
    expect(result.probability_at_least_one).toBeCloseTo(0.1, 10);
  });

  it("战绩查询：读取 history.jsonl 聚合", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hscoach-tools-"));
    await writeFile(
      join(dir, "history.jsonl"),
      [
        JSON.stringify({ result: "win" }),
        JSON.stringify({ result: "win" }),
        JSON.stringify({ result: "loss" }),
        "",
      ].join("\n"),
      "utf-8",
    );
    const stats = (await historyStatsTool({ ...deps, publishDir: dir }).execute({}, {
      concludeTurn: () => {},
      signal: new AbortController().signal,
      name: "hs_history_stats",
    })) as { total: number; wins: number; winrate_pct: number };
    expect(stats).toMatchObject({ total: 3, wins: 2, winrate_pct: 66.7 });
  });
});

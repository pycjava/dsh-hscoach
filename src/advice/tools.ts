/**
 * agentic 工具层（隐藏信息不变量）。
 *
 * 三个工具全部闭包住【已过滤隐藏信息的冻结快照】——对手手牌在快照里只有
 * 数量，工具层从构造上就不可能泄露隐藏信息；再叠加 agent 作用域白名单
 * （restrict），教练 agent 摸不到 bash/web 等全局工具。
 */
import type { CardDatabase } from "../core/cards.js";
import { drawAtLeastOne, drawProbabilitySummary } from "../core/probability.js";
import { aggregate, HISTORY_FILENAME } from "../core/history.js";
import { join } from "node:path";
import type { GameSnapshot } from "../core/state.js";
import type { ToolDefinition } from "@deepseek-ai/cordis";

export interface CoachToolsDeps {
  db: CardDatabase;
  snapshot: GameSnapshot;
  friendlyPlayerId: number;
  publishDir: string;
}

/** 工具名常量（restrict 白名单与 structured_output 对齐）。 */
export const TOOL_NAMES = [
  "hs_card_lookup",
  "hs_draw_odds",
  "hs_history_stats",
  "structured_output",
] as const;

/** 卡牌查询：按卡名或 CardID 查公开卡牌信息（最多 8 条，防 token 爆炸）。 */
export function cardLookupTool(deps: CoachToolsDeps): ToolDefinition {
  return {
    name: "hs_card_lookup",
    description:
      "按卡牌名称（或 CardID）查询卡牌公开信息：费用/攻血/类型/职业/效果文本。" +
      "局面里出现的卡想核对效果时用这个工具，不要凭记忆。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "卡牌名称或 CardID，如 火球术 或 CS2_029" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      render: (_args, value) => [
        { type: "text", text: JSON.stringify(value, null, 1) },
      ],
    },
    async execute(args) {
      const query = String(args["query"] ?? "").trim();
      if (!query) return { cards: [] };
      const lower = query.toLowerCase();
      const matches = deps.db
        .iterCards()
        .filter(
          (c) =>
            c.id.toLowerCase() === lower ||
            c.name === query ||
            c.name.includes(query),
        )
        .slice(0, 8);
      return {
        cards: matches.map((c) => ({
          card_id: c.id,
          name: c.name,
          cost: c.cost,
          attack: c.attack,
          health: c.health,
          type: c.type,
          card_class: c.cardClass,
          text: c.text,
        })),
      };
    },
  };
}

/** 抽牌概率：友方牌库剩余下抽中 1/2 张目标牌的概率（超几何精确计算）。 */
export function drawOddsTool(deps: CoachToolsDeps): ToolDefinition {
  return {
    name: "hs_draw_odds",
    description:
      "计算友方下回合（或未来 n 回合）抽到关键牌的概率（超几何分布，代码精确）。" +
      "评估抽牌找解的期望时使用，不要自己心算概率。",
    parameters: {
      type: "object",
      properties: {
        copies: {
          type: "number",
          description: "牌库里目标牌的剩余张数（1 或 2）",
        },
        draws: { type: "number", description: "抽牌次数（默认 1=下回合）" },
      },
      required: ["copies"],
      additionalProperties: false,
    },
    output: {
      render: (_args, value) => [
        { type: "text", text: JSON.stringify(value, null, 1) },
      ],
    },
    async execute(args) {
      const friendly = deps.snapshot.players[String(deps.friendlyPlayerId)];
      const deckCount = friendly?.deckCount ?? 0;
      const copies = Number(args["copies"] ?? 1);
      const draws = Number(args["draws"] ?? 1);
      return {
        deck_count: deckCount,
        copies,
        draws,
        probability_at_least_one: drawAtLeastOne(deckCount, copies, draws),
        summary: drawProbabilitySummary(deckCount, copies, draws),
      };
    },
  };
}

/** 战绩查询：历史胜负统计（公开信息）。 */
export function historyStatsTool(deps: CoachToolsDeps): ToolDefinition {
  return {
    name: "hs_history_stats",
    description:
      "查询本机炉石战绩统计（总场数/胜负/胜率）。评估对局节奏时可用。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      render: (_args, value) => [
        { type: "text", text: JSON.stringify(value, null, 1) },
      ],
    },
    async execute() {
      const stats = await aggregate(join(deps.publishDir, HISTORY_FILENAME));
      return { ...stats };
    },
  };
}

/** 组装一次运行的全部工具（不含 structured_output，由 provider 注入）。 */
export function buildCoachTools(deps: CoachToolsDeps): ToolDefinition[] {
  return [cardLookupTool(deps), drawOddsTool(deps), historyStatsTool(deps)];
}

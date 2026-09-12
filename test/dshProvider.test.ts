/**
 * agentic provider 功能测试：structured_output 收尾、工具白名单、
 * watchdog 取消、模型路由覆盖。
 */
import { describe, expect, it } from "vitest";
import { DshAgentAdviceProvider, ProviderError } from "../src/advice/dshProvider.js";
import { buildUserPrompt, getSystemPrompt } from "../src/advice/prompts.js";
import { computeLethal } from "../src/core/lethal.js";
import { parsePowerLog } from "../src/core/parser.js";
import { serializeGame, snapshotToContract, type GameSnapshot } from "../src/core/state.js";
import type { CardDatabase } from "../src/core/cards.js";
import { FakeAgent, FakeAgents, StubContext } from "./stubs/cordis.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentsService, ToolDefinition } from "@deepseek-ai/cordis";

const emptyDb = {
  get: () => undefined,
  iterCards: () => [],
  has: () => false,
  size: 0,
} as unknown as CardDatabase;

/** 从 fixture 抓一个真实快照。 */
function fixtureSnapshot(): { snapshot: GameSnapshot; friendly: number } {
  const lines = readFileSync(
    join(import.meta.dirname, "fixtures", "friendly_player_id_is_1.power.log"),
    "utf-8",
  ).split(/\r?\n/);
  const result = parsePowerLog(lines);
  const game = result.games[result.games.length - 1];
  const friendly = game.friendlyPlayerByShow ?? 1;
  return { snapshot: serializeGame(game, friendly, emptyDb), friendly };
}

function makeProvider(
  agents: FakeAgents,
  overrides: Partial<ConstructorParameters<typeof DshAgentAdviceProvider>[0]> = {},
) {
  return new DshAgentAdviceProvider({
    agents: agents as unknown as Pick<AgentsService, "create">,
    defaultModel: { currentSelection: () => ({ provider: "host", model: "host-model" }) },
    db: emptyDb,
    publishDir: "/tmp/hscoach-test",
    providerOverride: "",
    modelOverride: "",
    reasoningEffort: "off",
    timeoutMs: 15_000,
    ...overrides,
  });
}

/** 模拟模型调 structured_output。 */
async function callTool(agentCtx: StubContext, name: string, args: Record<string, unknown>) {
  const tool = agentCtx.tools.registered.find((t) => t["name"] === name) as unknown as ToolDefinition;
  if (!tool) throw new Error(`tool ${name} not registered`);
  let concluded = false;
  const result = await tool.execute(args, {
    concludeTurn: () => (concluded = true),
    signal: new AbortController().signal,
    name,
  });
  return { result, concluded };
}

describe("DshAgentAdviceProvider", () => {
  it("模型经 structured_output 提交建议 → Advice 契约 + 白名单 + prompt 注入", async () => {
    const agents = new FakeAgents();
    const { snapshot, friendly } = fixtureSnapshot();
    agents.onCreate = (agent, agentCtx) => {
      void (async () => {
        // 模拟模型先查一张卡再提交建议
        await callTool(agentCtx, "hs_card_lookup", { query: "火球术" });
        await callTool(agentCtx, "structured_output", {
          kind: "play",
          headline: "火球术打脸",
          why: "斩杀评估已确认",
          steps: ["火球术 → 对方英雄"],
          warning: "",
        });
        agent.finish();
      })();
    };
    const advice = await makeProvider(agents).generate({
      snapshot,
      friendlyPlayerId: friendly,
      lethal: computeLethal(snapshot, friendly),
      coachMode: "teach",
      generation: 1,
    });

    expect(advice.kind).toBe("play");
    expect(advice.headline).toBe("火球术打脸");
    expect(advice.steps).toEqual(["火球术 → 对方英雄"]);
    expect(advice.degraded).toBe(false);

    const creation = agents.creations[0]!;
    // 模型路由：空覆盖 → 跟随宿主默认
    expect(creation.agentOptions).toMatchObject({ provider: "host", model: "host-model" });
  });

  it("白名单只放行教练四件套（bash/web 等全局工具不可见）", async () => {
    const agents = new FakeAgents();
    const { snapshot, friendly } = fixtureSnapshot();
    let seenRestrict: { allow?: string[] } | undefined;
    agents.onCreate = (_agent, agentCtx) => {
      seenRestrict = agentCtx.tools.restrictCalls[0];
      void (async () => {
        await callTool(agentCtx, "structured_output", {
          kind: "pass",
          headline: "过",
          why: "无事可做",
        });
        _agent.finish();
      })();
    };
    await makeProvider(agents).generate({
      snapshot,
      friendlyPlayerId: friendly,
      lethal: null,
      coachMode: "teach",
      generation: 1,
    });
    expect(seenRestrict?.allow).toEqual([
      "hs_card_lookup",
      "hs_draw_odds",
      "hs_history_stats",
      "structured_output",
    ]);
  });

  it("模型路由覆盖与 system prompt 注入", async () => {
    const agents = new FakeAgents();
    const { snapshot, friendly } = fixtureSnapshot();
    let promptText = "";
    agents.onCreate = (agent, agentCtx) => {
      promptText = agentCtx.systemPrompt.sections[0]?.text ?? "";
      void (async () => {
        await callTool(agentCtx, "structured_output", {
          kind: "pass",
          headline: "x",
          why: "y",
        });
        agent.finish();
      })();
    };
    await makeProvider(agents, { providerOverride: "pi", modelOverride: "deepseek-v4-flash" }).generate(
      { snapshot, friendlyPlayerId: friendly, lethal: null, coachMode: "compete", generation: 1 },
    );
    expect(agents.creations[0]!.agentOptions).toMatchObject({
      provider: "pi",
      model: "deepseek-v4-flash",
    });
    expect(promptText).toContain("【竞赛模式】");
    expect(promptText).toContain("斩杀判定");
  });

  it("watchdog 超时 → cancel 被调用 → ProviderError（引擎负责降级）", async () => {
    const agents = new FakeAgents();
    const { snapshot, friendly } = fixtureSnapshot();
    let cancelledAgent: FakeAgent | null = null;
    agents.onCreate = (agent) => {
      cancelledAgent = agent;
      // 模型永不收敛：不调 structured_output、不 finish
    };
    const provider = makeProvider(agents, {
      setTimeout: (fn) => {
        fn(); // 立即触发 watchdog
        return { clear: () => {} };
      },
    });
    await expect(
      provider.generate({
        snapshot,
        friendlyPlayerId: friendly,
        lethal: null,
        coachMode: "teach",
        generation: 1,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(cancelledAgent!.cancelled).toBe("hscoach watchdog");
  });

  it("user prompt 含局面与斩杀评估，且不含对手手牌明细（D9）", () => {
    const { snapshot, friendly } = fixtureSnapshot();
    const user = buildUserPrompt(snapshotToContract(snapshot), friendly, computeLethal(snapshot, friendly));
    expect(user).toContain("=== 当前回合");
    expect(user).toContain("【伤害评估】");
    expect(user).toContain("张（隐藏，不知具体）");
    // 快照本体也不应有对手手牌卡牌对象
    const opponent = snapshot.players[String(friendly === 1 ? 2 : 1)];
    expect(Array.isArray(opponent.hand)).toBe(false);
    expect(getSystemPrompt("teach")).toContain("只输出最终 JSON");
  });
});

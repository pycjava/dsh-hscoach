/**
 * dsh agentic 建议生成器：ctx.agents.create + agent 作用域工具 +
 * structured_output 结构化收尾 + watchdog（dsh 无内置步数/超时上限，
 * 插件自管）。失败抛 ProviderError，由引擎降级（上回合建议回显）。
 */
import { randomUUID } from "node:crypto";
import type { AgentsService, AgentDefaultModelService, Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { computeLethal, type LethalCheck } from "../core/lethal.js";
import { snapshotToContract, type GameSnapshot } from "../core/state.js";
import type { CardDatabase } from "../core/cards.js";
import { emptyAdvice, type Advice } from "../core/trigger.js";
import { ADVICE_JSON_SCHEMA, buildUserPrompt, getSystemPrompt } from "./prompts.js";
import { buildCoachTools, TOOL_NAMES } from "./tools.js";

export class ProviderError extends Error {}

export interface DshProviderDeps {
  agents: Pick<AgentsService, "create">;
  defaultModel: Pick<AgentDefaultModelService, "currentSelection">;
  db: CardDatabase;
  publishDir: string;
  /** 模型路由覆盖（空串=跟随宿主默认）。 */
  providerOverride: string;
  modelOverride: string;
  /** 推理力度（"off"/"low"/...；空串=不动）。 */
  reasoningEffort: string;
  /** watchdog 上限（毫秒）。 */
  timeoutMs: number;
  /** 测试注入的定时器。 */
  setTimeout?: (fn: () => void, ms: number) => { clear(): void };
}

interface StructuredAdvice {
  kind: string;
  headline: string;
  why: string;
  steps?: string[];
  warning?: string;
  alternatives?: Array<{ headline: string; why: string }>;
}

export class DshAgentAdviceProvider {
  constructor(private readonly deps: DshProviderDeps) {}

  async generate(input: {
    snapshot: GameSnapshot;
    friendlyPlayerId: number;
    lethal: LethalCheck | null;
    coachMode: string;
    generation: number;
  }): Promise<Advice> {
    const { snapshot, friendlyPlayerId, lethal } = input;
    const lethalCheck = lethal ?? computeLethal(snapshot, friendlyPlayerId);
    const system = getSystemPrompt(input.coachMode);
    const user = buildUserPrompt(snapshotToContract(snapshot), friendlyPlayerId, lethalCheck);

    let captured: StructuredAdvice | undefined;

    const selection = this.deps.defaultModel.currentSelection();
    const { agent, dispose } = await this.deps.agents.create({
      sessionId: `hscoach-${randomUUID()}`,
      agentOptions: {
        provider: this.deps.providerOverride || selection.provider,
        model: this.deps.modelOverride || selection.model,
        maxTokens: 4096,
      },
      setup: (agentCtx: Context) => {
        for (const tool of buildCoachTools({
          db: this.deps.db,
          snapshot,
          friendlyPlayerId,
          publishDir: this.deps.publishDir,
        })) {
          agentCtx.tools!.register(tool);
        }
        agentCtx.tools!.register(structuredOutputTool((value) => (captured = value)));
        // 白名单：教练 agent 只见教练工具，摸不到 bash/web 等全局工具
        agentCtx.tools!.restrict({ allow: [...TOOL_NAMES] });
        agentCtx.systemPrompt!.section({ name: "hscoach:rules", order: 100, text: system });
        // 低延迟：压推理链（宿主全局默认可能是 max）
        if (this.deps.reasoningEffort) {
          agentCtx.on("agent/request", ((request: { reasoningEffort?: string }) => {
            request.reasoningEffort = this.deps.reasoningEffort;
          }) as never);
        }
      },
    });

    try {
      const timer = (this.deps.setTimeout ?? realTimeout)(
        () => agent.cancel("hscoach watchdog"),
        this.deps.timeoutMs,
      );
      try {
        agent.followup(
          createUserMessage({
            content: [{ type: "text", text: user }],
            source: { kind: "user" },
          }),
        );
        await agent.whenIdle();
      } finally {
        timer.clear();
      }
    } finally {
      dispose();
    }

    if (!captured) {
      throw new ProviderError("agent 未通过 structured_output 提交建议");
    }
    return toAdvice(captured);
  }
}

function structuredOutputTool(capture: (value: StructuredAdvice) => void) {
  return {
    name: "structured_output",
    description: "提交最终出牌建议。答案完整时调用且仅调用一次，参数必须严格符合 schema。",
    parameters: ADVICE_JSON_SCHEMA as unknown as Record<string, unknown>,
    output: {
      render: () => [{ type: "text" as const, text: "建议已记录。" }],
    },
    execute(args: Record<string, unknown>, exec: { concludeTurn(): void }) {
      capture(args as unknown as StructuredAdvice);
      exec.concludeTurn();
      return Promise.resolve({ recorded: true });
    },
  };
}

function realTimeout(fn: () => void, ms: number): { clear(): void } {
  const handle = setTimeout(fn, ms);
  return { clear: () => clearTimeout(handle) };
}

/** structured_output 的产物 → Advice 契约（schema 校验由 dsh 工具层保证）。 */
export function toAdvice(payload: StructuredAdvice): Advice {
  const advice = emptyAdvice();
  const kind = String(payload.kind);
  advice.kind =
    kind === "play" || kind === "trade" || kind === "pass" || kind === "uncertain"
      ? kind
      : "uncertain";
  advice.headline = String(payload.headline ?? "");
  advice.why = String(payload.why ?? "");
  const steps = payload.steps;
  advice.steps = Array.isArray(steps) ? steps.map(String) : [];
  advice.warning = String(payload.warning ?? "");
  advice.alternatives = Array.isArray(payload.alternatives)
    ? payload.alternatives
        .filter((a) => a && typeof a === "object")
        .map((a) => ({ headline: String(a.headline ?? ""), why: String(a.why ?? "") }))
    : [];
  return advice;
}

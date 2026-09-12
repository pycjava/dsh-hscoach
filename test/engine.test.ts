/**
 * 引擎功能测试：端到端（fixture → 建议发布）、latest-wins、
 * 降级回显、再想想、战绩记录。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CoachEngine, type AdviceProvider } from "../src/runtime/engine.js";
import { CardDatabase } from "../src/core/cards.js";
import type { GameSnapshot } from "../src/core/state.js";
import type { Advice } from "../src/core/trigger.js";
import { THINK_AGAIN_FILENAME } from "../src/core/trigger.js";

const db = new CardDatabase([join(import.meta.dirname, "..", "..", "hscoach", "data")]);
const fixture = () =>
  readFileSync(join(import.meta.dirname, "fixtures", "friendly_player_id_is_1.power.log"), "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);

function okAdvice(headline: string): Advice {
  return {
    kind: "play",
    headline,
    why: "测试理由",
    steps: [],
    warning: "",
    alternatives: [],
    latency_ms: 1,
    degraded: false,
    lethal: false,
  };
}

/** 受控 provider：可编排延迟/失败。 */
class ScriptedProvider implements AdviceProvider {
  calls: number = 0;
  script: (input: {
    snapshot: GameSnapshot;
    generation: number;
  }) => Promise<Advice> = async ({ snapshot }) => okAdvice(`T${snapshot.turn} 建议`);

  async generate(input: Parameters<AdviceProvider["generate"]>[0]): Promise<Advice> {
    this.calls += 1;
    return this.script({ snapshot: input.snapshot, generation: input.generation });
  }
}

let dir: string;

describe("CoachEngine", () => {
  beforeEach(async () => {
    await db.build();
    dir = await mkdtemp(join(tmpdir(), "hscoach-engine-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("端到端：fixture 全量喂入 → 发布 game_state/advice、触发回合数正确", async () => {
    const provider = new ScriptedProvider();
    const publishedTurns: number[] = [];
    provider.script = async ({ snapshot }) => okAdvice(`T${snapshot.turn} 建议`);
    const engine = new CoachEngine({
      publishDir: dir,
      db,
      adviceProvider: provider,
      onEvent: (e) => {
        if (e.type === "advice-published") publishedTurns.push(e.turn);
      },
    });
    await engine.processLines(fixture());
    await engine.idle();

    // 友方（玩家1，后手）回合为偶数：T2/T4/…。发布段已串行化：事件顺序
    // = 提交代数顺序，advice.json 最终内容 = 最后提交的建议。
    expect(provider.calls).toBe(7);
    expect(publishedTurns.length).toBeLessThanOrEqual(provider.calls);
    expect(publishedTurns.every((t) => t % 2 === 0)).toBe(true);
    expect(publishedTurns).toEqual([...publishedTurns].sort((a, b) => a - b));
    expect(publishedTurns[publishedTurns.length - 1]).toBe(14);

    // 发布契约
    const advice = JSON.parse(await readFile(join(dir, "advice.json"), "utf-8"));
    expect(advice).toHaveProperty("turn");
    expect(advice.advice).toMatchObject({ kind: "play" });
    const state = JSON.parse(await readFile(join(dir, "game_state.json"), "utf-8"));
    expect(state).toMatchObject({ friendly_player_id: 1 });
    expect(state.players["2"].hand).toEqual({ count: expect.any(Number) }); // D9
    // 战绩（fixture 是败局）
    const stats = JSON.parse(await readFile(join(dir, "stats.json"), "utf-8"));
    expect(stats).toMatchObject({ total: 1, losses: 1 });
  });

  it("latest-wins：新回合到达时未发布的旧建议作废", async () => {
    const provider = new ScriptedProvider();
    const published: number[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let first = true;
    provider.script = async ({ snapshot }) => {
      if (first) {
        first = false;
        await gate; // T2 挂起，直到 T4 的提交同步完成代数递增
      } else {
        releaseFirst(); // T4 提交时同步放行 T2（此时 gen 已被 T4 占位）
      }
      return okAdvice(`T${snapshot.turn}`);
    };
    const engine = new CoachEngine({
      publishDir: dir,
      db,
      adviceProvider: provider,
      onEvent: (e) => {
        if (e.type === "advice-published") published.push(e.turn);
      },
    });
    const lines = fixture();
    // T2@~3559、T4@~3916：第一段覆盖 T2（挂起），第二段覆盖 T4
    const p1 = engine.processLines(lines.slice(0, 3600));
    await p1;
    const p2 = engine.processLines(lines.slice(3600, 4000));
    await Promise.all([p2, engine.idle()]);

    expect(provider.calls).toBe(2);
    expect(published).toEqual([4]); // T2 被 latest-wins 作废
  });

  it("降级：provider 失败 → 回显上一回合建议并标 degraded；无历史则占位", async () => {
    const provider = new ScriptedProvider();
    let fail = false;
    provider.script = async () => {
      if (fail) throw new Error("模拟超时");
      return okAdvice("正常建议");
    };
    const engine = new CoachEngine({ publishDir: dir, db, adviceProvider: provider });
    const lines = fixture();
    await engine.processLines(lines.slice(0, 3600)); // T2 正常发布
    await engine.idle();
    const before = JSON.parse(await readFile(join(dir, "advice.json"), "utf-8"));
    expect(before.advice.degraded).toBe(false);

    fail = true;
    await engine.thinkAgain(); // 手动触发再生成 → 失败 → 回显
    const after = JSON.parse(await readFile(join(dir, "advice.json"), "utf-8"));
    expect(after.advice.degraded).toBe(true);
    expect(after.advice.headline).toBe("正常建议");
  });

  it("再想想：think-again 流程走 provider 并发布", async () => {
    const provider = new ScriptedProvider();
    const engine = new CoachEngine({ publishDir: dir, db, adviceProvider: provider });
    await engine.processLines(fixture().slice(0, 3600));
    await engine.idle();
    const callsBefore = provider.calls;
    await engine.thinkAgain();
    expect(provider.calls).toBe(callsBefore + 1);
    expect(JSON.parse(await readFile(join(dir, "advice.json"), "utf-8")).advice.headline).toBe(
      "T2 建议",
    );
  });
});

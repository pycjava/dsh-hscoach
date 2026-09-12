/**
 * 插件服务级功能测试（真实编排 + 桩宿主）：
 * Service.init 装配 → /hscoach 命令 → 日志喂入 → agentic 建议（stub agents
 * 驱动 structured_output）→ 发布文件；再想想触发文件；mode 切换；stop。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Service } from "@deepseek-ai/cordis";
import { HsCoachService, resolvePublishDir, type RuntimeDeps } from "../src/index.js";
import type { HsCoachPluginConfig } from "../src/index.js";
import { CardDatabase } from "../src/core/cards.js";
import type { Advice } from "../src/core/trigger.js";
import { StubContext } from "./stubs/cordis.js";

const db = new CardDatabase([join(import.meta.dirname, "..", "..", "hscoach", "data")]);
const fixtureLines = () =>
  readFileSync(join(import.meta.dirname, "fixtures", "friendly_player_id_is_1.power.log"), "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);

/** 可控 FakeTail：测试手动喂行。 */
class FakeTail {
  static instances: FakeTail[] = [];
  options: ConstructorParameters<typeof import("../src/core/tail.js").PowerLogTail>[0];
  stopped = false;
  constructor(options: ConstructorParameters<typeof import("../src/core/tail.js").PowerLogTail>[0]) {
    this.options = options;
    FakeTail.instances.push(this);
  }
  async run(): Promise<void> {
    // 常驻直到 stop（与真实 tail 语义一致）
    while (!this.stopped && !this.options.shouldStop?.()) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  stop(): void {
    this.stopped = true;
  }
  feed(lines: string[]): void {
    void this.options.onLines(lines);
  }
}

let dir: string;
let ctx: StubContext;
let providerCalls: import("./stubs/cordis.js").FakeAgent[];
let releaseAdvice: (() => void) | null = null;
let adviceGate: Promise<void>;

function makeConfig(overrides: Partial<HsCoachPluginConfig> = {}): HsCoachPluginConfig {
  return {
    publishDir: dir,
    coachMode: "teach",
    provider: "",
    model: "",
    reasoningEffort: "off",
    adviceTimeoutMs: 15000,
    cardDataDir: "",
    autoStart: true,
    ...overrides,
  };
}

function makeDeps(): RuntimeDeps {
  return {
    resolveLogPath: async () => join(dir, "Power.log"),
    tail: FakeTail as unknown as RuntimeDeps["tail"],
    ensureLogConfig: async () => ({
      action: "already_ok",
      path: "",
      backupPath: null,
      message: "stub",
    }),
    now: () => Date.now(),
  };
}

async function makeService(configOverrides: Partial<HsCoachPluginConfig> = {}) {
  // ctx 由 beforeEach 创建并挂好桩钩子；这里只装配服务
  const service = new HsCoachService(
    ctx as unknown as import("@deepseek-ai/cordis").Context,
    makeConfig(configOverrides),
    makeDeps(),
  );
  const init = (service as unknown as { [k: symbol]: () => Promise<void> })[Service.init];
  await init.call(service);
  return service;
}

async function command(_service: HsCoachService, raw: string) {
  const cmd = ctx.commands.registrations.find((r) => r.name === "hscoach");
  if (!cmd) throw new Error("/hscoach 未注册");
  return cmd.handler({ rawInput: raw });
}

beforeEach(async () => {
  await db.build();
  dir = await mkdtemp(join(tmpdir(), "hscoach-plugin-"));
  FakeTail.instances = [];
  providerCalls = [];
  releaseAdvice = null;
  adviceGate = new Promise<void>((r) => (releaseAdvice = r));
  ctx = new StubContext();
  // 桩 agents：每次 create 模拟模型提交一条建议（工具注册在 agent 作用域上下文）
  ctx.agents.onCreate = (agent, agentCtx) => {
    const call = providerCalls.push(agent);
    void (async () => {
      await adviceGate;
      const tool = agentCtx.tools.registered.find((t) => t["name"] === "structured_output");
      await (tool!["execute"] as (args: Record<string, unknown>, exec: unknown) => Promise<unknown>)(
        { kind: "pass", headline: `建议${call}`, why: "测试" },
        { concludeTurn: () => {} },
      );
      agent.finish();
    })();
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("HsCoachService", () => {
  it("init 装配：卡牌库就绪、/hscoach 注册、tail 启动；喂入 fixture → 发布 advice", async () => {
    const service = await makeService();
    expect(ctx.commands.registrations.map((r) => r.name)).toContain("hscoach");
    expect(FakeTail.instances.length).toBe(1);

    FakeTail.instances[0]!.feed(fixtureLines());
    // 等待 fire-and-forget 的建议链落定
    for (let i = 0; i < 100 && !providerCalls.length; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    releaseAdvice!();
    await new Promise((r) => setTimeout(r, 50));

    expect(providerCalls.length).toBeGreaterThan(0);
    const advice = JSON.parse(await readFile(join(dir, "advice.json"), "utf-8")) as {
      advice: Advice;
    };
    expect(advice.advice.headline).toMatch(/^建议\d+$/);
    const status = await command(service, "status");
    expect(status.kind).toBe("success");
    expect(status.text).toContain("最近建议");

    await command(service, "stop");
  }, 30000);

  it("/hscoach think 与 think-again.trigger 都会触发重新推理", async () => {
    const service = await makeService();
    FakeTail.instances[0]!.feed(fixtureLines());
    for (let i = 0; i < 100 && !providerCalls.length; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // 放行第一次建议
    releaseAdvice!();
    await new Promise((r) => setTimeout(r, 50));
    const callsAfterFirst = providerCalls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 触发文件 → 轮询 → thinkAgain
    const trigger = join(resolvePublishDir(dir), "think-again.trigger");
    await writeFile(trigger, "think", "utf-8");
    ctx.intervals.forEach((poll) => poll());
    for (let i = 0; i < 100 && providerCalls.length === callsAfterFirst; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(providerCalls.length).toBe(callsAfterFirst + 1);
    // 放行第二次
    releaseAdvice?.();
    await new Promise((r) => setTimeout(r, 50));
    await command(service, "stop");
  }, 30000);

  it("/hscoach mode 切换教练模式（非法值报错）", async () => {
    const service = await makeService({ autoStart: false });
    const bad = await command(service, "mode ultra");
    expect(bad.kind).toBe("error");
    const ok = await command(service, "mode compete");
    expect(ok).toMatchObject({ kind: "success" });
    expect((service as unknown as { engine: { coachMode: string } }).engine.coachMode).toBe(
      "compete",
    );
  });

  it("start 前缀日志与 stop 后 tail 停止；重启新建 tail", async () => {
    const service = await makeService({ autoStart: false });
    expect(FakeTail.instances.length).toBe(0);
    await command(service, "start");
    expect(FakeTail.instances.length).toBe(1);
    const stopReply = await command(service, "stop");
    expect(stopReply.kind).toBe("success");
    expect(FakeTail.instances[0]!.stopped).toBe(true);
    // 重启 → 新建 tail 实例（旧的已停止）
    await command(service, "start");
    expect(FakeTail.instances.length).toBe(2);
    expect(FakeTail.instances[1]!.stopped).toBe(false);
  });
});

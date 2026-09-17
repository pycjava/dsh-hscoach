/**
 * 插件级功能测试（真实编排 + 桩宿主/HTTP）：
 * init 装配 → /hscoach 命令 → 日志喂入 → 直连 API 建议（fetch 桩）→
 * 发布文件；再想想触发文件；mode 切换；start/stop。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import pluginDefault, {
  HsCoachPlugin,
  resolveConfig,
  resolvePublishDir,
  type RuntimeDeps,
} from "../src/index.js";
import type { Advice } from "../src/core/trigger.js";
import type { ResponseLike } from "../src/advice/directProvider.js";
import { StubContext } from "./stubs/host.js";

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
let polls: Array<() => void>;
let fetchCalls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }>;
let releaseAdvice: (() => void) | null = null;
let adviceGate: Promise<void>;

function jsonResponse(headline: string): ResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ kind: "pass", headline, why: "测试" }) } }],
    }),
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
    setInterval: (callback: () => void) => {
      polls.push(callback);
      return () => {
        const idx = polls.indexOf(callback);
        if (idx >= 0) polls.splice(idx, 1);
      };
    },
    fetch: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      fetchCalls.push({ url, init });
      await adviceGate;
      return jsonResponse(`建议${fetchCalls.length}`);
    }) as unknown as RuntimeDeps["fetch"],
  };
}

function makeRawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publishDir: dir,
    apiKey: "test-key",
    baseURL: "http://llm.test",
    model: "test-model",
    autoStart: true,
    ...overrides,
  };
}

async function makePlugin(rawConfig: Record<string, unknown> = {}) {
  const plugin = new HsCoachPlugin(
    ctx as unknown as Context,
    resolveConfig(makeRawConfig(rawConfig)),
    makeDeps(),
  );
  await plugin.init();
  return plugin;
}

async function command(_plugin: HsCoachPlugin, raw: string) {
  const cmd = ctx.commands.registrations.find((r) => r.name === "hscoach");
  if (!cmd) throw new Error("/hscoach 未注册");
  return cmd.handler({ rawInput: raw });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  for (let i = 0; i < timeoutMs / 10 && !predicate(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 固定等待（给 fire-and-forget 的建议链落定时间）。 */
async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hscoach-plugin-"));
  FakeTail.instances = [];
  polls = [];
  fetchCalls = [];
  releaseAdvice = null;
  adviceGate = new Promise<void>((r) => (releaseAdvice = r));
  ctx = new StubContext();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("dsh-hscoach 插件", () => {
  it("default 导出是名为 dsh-hscoach 的函数（cordis 函数插件装载形态）", () => {
    expect(typeof pluginDefault).toBe("function");
    expect((pluginDefault as { name?: string }).name).toBe("dsh-hscoach");
  });

  it("init 装配：卡牌库就绪、/hscoach 注册、tail 启动；喂入 fixture → 发布 advice", async () => {
    const plugin = await makePlugin();
    expect(ctx.commands.registrations.map((r) => r.name)).toContain("hscoach");
    expect(FakeTail.instances.length).toBe(1);
    // 请求直连 API：URL/鉴权/模型
    FakeTail.instances[0]!.feed(fixtureLines());
    await waitUntil(() => fetchCalls.length > 0);
    releaseAdvice!();
    await settle();

    expect(fetchCalls.length).toBeGreaterThan(0);
    const first = fetchCalls[0]!;
    expect(first.url).toBe("http://llm.test/chat/completions");
    expect(first.init.headers.authorization).toBe("Bearer test-key");
    expect(JSON.parse(first.init.body).model).toBe("test-model");
    const advice = JSON.parse(await readFile(join(dir, "advice.json"), "utf-8")) as {
      advice: Advice;
    };
    expect(advice.advice.headline).toMatch(/^建议\d+$/);
    const status = await command(plugin, "status");
    expect(status.kind).toBe("success");
    expect(status.text).toContain("最近建议");
    expect(status.text).toContain("模型：test-model（http://llm.test）");

    await command(plugin, "stop");
  }, 30000);

  it("/hscoach think 与 think-again.trigger 都会触发重新推理", async () => {
    const plugin = await makePlugin();
    FakeTail.instances[0]!.feed(fixtureLines());
    await waitUntil(() => fetchCalls.length > 0);
    // 放行第一次建议
    releaseAdvice!();
    await settle();
    const callsAfterFirst = fetchCalls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 触发文件 → 轮询 → thinkAgain
    const trigger = join(resolvePublishDir(dir), "think-again.trigger");
    await writeFile(trigger, "think", "utf-8");
    polls.forEach((poll) => poll());
    await waitUntil(() => fetchCalls.length > callsAfterFirst);
    // 放行第二次
    releaseAdvice?.();
    await settle();
    await command(plugin, "stop");
  }, 30000);

  it("/hscoach mode 切换教练模式（非法值报错）", async () => {
    const plugin = await makePlugin({ autoStart: false });
    const bad = await command(plugin, "mode ultra");
    expect(bad.kind).toBe("error");
    const ok = await command(plugin, "mode compete");
    expect(ok).toMatchObject({ kind: "success" });
    expect((plugin as unknown as { engine: { coachMode: string } }).engine.coachMode).toBe(
      "compete",
    );
  });

  it("start 前缀日志与 stop 后 tail 停止；重启新建 tail", async () => {
    const plugin = await makePlugin({ autoStart: false });
    expect(FakeTail.instances.length).toBe(0);
    await command(plugin, "start");
    expect(FakeTail.instances.length).toBe(1);
    const stopReply = await command(plugin, "stop");
    expect(stopReply.kind).toBe("success");
    expect(FakeTail.instances[0]!.stopped).toBe(true);
    // 重启 → 新建 tail 实例（旧的已停止）
    await command(plugin, "start");
    expect(FakeTail.instances.length).toBe(2);
    expect(FakeTail.instances[1]!.stopped).toBe(false);
  });

  it("未配置 API key：启动告警，建议链降级发布占位", async () => {
    let gateReleased = false;
    adviceGate.then(() => (gateReleased = true));
    const plugin = new HsCoachPlugin(
      ctx as unknown as Context,
      resolveConfig(makeRawConfig({ apiKey: "", autoStart: true })),
      makeDeps(),
    );
    await plugin.init();
    expect(ctx.logs.some((l) => l.message.includes("未配置 API key"))).toBe(true);
    FakeTail.instances[0]!.feed(fixtureLines());
    await settle(100);
    // 无 key：provider 立即失败，不发起 HTTP；引擎降级发布占位建议
    expect(gateReleased).toBe(false);
    expect(fetchCalls.length).toBe(0);
    const advice = JSON.parse(await readFile(join(dir, "advice.json"), "utf-8")) as {
      advice: Advice;
    };
    expect(advice.advice.degraded).toBe(true);
    await command(plugin, "stop");
  }, 30000);

  it("resolveConfig：config > 环境变量 > 默认值", () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    const previousUrl = process.env.DEEPSEEK_BASE_URL;
    try {
      process.env.DEEPSEEK_API_KEY = "env-key";
      process.env.DEEPSEEK_BASE_URL = "http://env.llm";
      const envOnly = resolveConfig({});
      expect(envOnly.apiKey).toBe("env-key");
      expect(envOnly.baseURL).toBe("http://env.llm");
      expect(envOnly.model).toBe("deepseek-chat");
      expect(envOnly.autoStart).toBe(true);
      const explicit = resolveConfig({ apiKey: "cfg-key", baseURL: "http://cfg.llm/" });
      expect(explicit.apiKey).toBe("cfg-key");
      expect(explicit.baseURL).toBe("http://cfg.llm/");
      const coachMode = resolveConfig({ coachMode: "compete" });
      expect(coachMode.coachMode).toBe("compete");
      expect(resolveConfig({ coachMode: "ultra" }).coachMode).toBe("teach");
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
      if (previousUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
      else process.env.DEEPSEEK_BASE_URL = previousUrl;
    }
  });
});

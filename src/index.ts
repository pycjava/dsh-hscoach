/**
 * dsh-hscoach 插件入口（自包含 cordis 函数插件，运行期零 @deepseek-ai/*
 * 依赖——宿主 import 全部为 `import type`，编译后擦除）。
 *
 * 职责组合（插件掌管生命周期，NTEToolbox 只读发布文件）：
 * - 启动时：构建卡牌库 → 尽力开启炉石日志 → 启动 Power.log tail 引擎
 * - 建议生成：直连 DeepSeek 兼容 API（不经宿主 agents 服务，任何 profile 可跑）
 * - /hscoach 命令：status/start/stop/think/mode/restore-log
 * - "再想想"反通道：watch 发布目录的 think-again.trigger 文件
 * - 配置：静态项走 cordis.patch.yml；运行时开关走命令
 */
import { join } from "node:path";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { CardDatabase, defaultDataDirs } from "./core/cards.js";
import { ensureLogConfig, powerLogPath, restoreLogConfig } from "./core/logConfig.js";
import type { LogConfigStatus } from "./core/logConfig.js";
import { PowerLogTail } from "./core/tail.js";
import { ADVICE_FILENAME, THINK_AGAIN_FILENAME } from "./core/trigger.js";
import { CoachEngine, type AdviceProvider, type EngineEvent } from "./runtime/engine.js";
import { DirectApiAdviceProvider } from "./advice/directProvider.js";
import { COACH_MODES, DEFAULT_COACH_MODE } from "./advice/prompts.js";
import { aggregate } from "./core/history.js";

/** API 根地址默认值（DeepSeek 官方；/v1 等兼容端点经 config.baseURL 配置）。 */
export const DEFAULT_BASE_URL = "https://api.deepseek.com";
/** 模型默认值（低延迟对话模型；教练对推理深度不敏感）。 */
export const DEFAULT_MODEL = "deepseek-chat";
/** 建议生成 watchdog 默认上限（毫秒）。 */
export const DEFAULT_ADVICE_TIMEOUT_MS = 15_000;

export interface HsCoachPluginConfig {
  publishDir: string;
  friendlyPlayerId?: number;
  coachMode: string;
  /** DeepSeek 兼容 API key；空串 = 环境变量 DEEPSEEK_API_KEY。 */
  apiKey: string;
  /** API 根地址；空串 = 环境变量 DEEPSEEK_BASE_URL 或官方默认。 */
  baseURL: string;
  /** 模型；空串 = deepseek-chat。 */
  model: string;
  /** 建议生成 watchdog（毫秒）。 */
  adviceTimeoutMs: number;
  /** 卡牌库数据目录；空串 = 自动探测（包 data/）。 */
  cardDataDir: string;
  /** dsh 启动后自动开始监听。 */
  autoStart: boolean;
}

/**
 * 显式配置解析（cordis.patch.yml 的 config 键 > 环境变量 > 默认值）。
 * config 是原始 JSON 对象，默认值与类型粗化集中在此。
 */
export function resolveConfig(raw: Record<string, unknown> = {}): HsCoachPluginConfig {
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const coachMode = str(raw.coachMode) || DEFAULT_COACH_MODE;
  return {
    publishDir: str(raw.publishDir),
    friendlyPlayerId: num(raw.friendlyPlayerId),
    coachMode: coachMode in COACH_MODES ? coachMode : DEFAULT_COACH_MODE,
    apiKey: str(raw.apiKey) || process.env.DEEPSEEK_API_KEY || "",
    baseURL: str(raw.baseURL) || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
    model: str(raw.model) || DEFAULT_MODEL,
    adviceTimeoutMs: num(raw.adviceTimeoutMs) ?? DEFAULT_ADVICE_TIMEOUT_MS,
    cardDataDir: str(raw.cardDataDir),
    autoStart: raw.autoStart === undefined ? true : raw.autoStart === true,
  };
}

/**
 * 解析发布目录默认值。必须与 Tauri hscoach_bridge 的 `app_local_data_dir()/
 * hscoach`（identifier = com.ntetoolbox.client）一致，否则客户端轮询不到
 * 插件写的 advice.json。优先级：显式配置 > 环境变量 > Tauri 目录。
 */
export function resolvePublishDir(configured: string): string {
  if (configured) return configured;
  const env = process.env.DSH_HSCOACH_PUBLISH_DIR;
  if (env) return env;
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(local, "com.ntetoolbox.client", "hscoach");
}

/**
 * 可注入的运行时编排（测试与真实宿主共用）。
 * realRuntimeDeps 用真实文件系统与全局定时器；测试构造 fake。
 */
export interface RuntimeDeps {
  resolveLogPath(): Promise<string>;
  tail: new (options: import("./core/tail.js").TailOptions) => PowerLogTail;
  /** log.config 开启（测试注入桩，避免碰真实炉石配置）。 */
  ensureLogConfig(): Promise<LogConfigStatus>;
  /** 建议生成的 HTTP 实现；缺省 = 全局 fetch。 */
  fetch?: typeof fetch;
  /** 轮询定时器（返回清理函数）。 */
  setInterval(callback: () => void, ms: number): () => void;
}

export const realRuntimeDeps: RuntimeDeps = {
  resolveLogPath: () => powerLogPath(),
  tail: PowerLogTail,
  ensureLogConfig,
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    return () => clearInterval(handle);
  },
};

/**
 * 教练编排主体（普通类，不提供 cordis 服务——无外部消费者）。
 * 由默认导出的插件函数装配，生命周期经 ctx.effect 挂钩。
 */
export class HsCoachPlugin {
  private engine: CoachEngine | null = null;
  private db: CardDatabase | null = null;
  private tail: PowerLogTail | null = null;
  private stopped = false;
  private running = false;
  private thinkAgainMtime = 0;
  private stopThinkAgainPoll?: () => void;
  private readonly events: string[] = [];

  constructor(
    private readonly ctx: Context,
    private readonly cfg: HsCoachPluginConfig,
    private readonly deps: RuntimeDeps = realRuntimeDeps,
  ) {}

  async init(): Promise<void> {
    const publishDir = resolvePublishDir(this.cfg.publishDir);

    // 卡牌库（离线，内置数据）
    this.db = new CardDatabase(
      this.cfg.cardDataDir ? [this.cfg.cardDataDir, ...defaultDataDirs()] : defaultDataDirs(),
    );
    await this.db.build();
    this.ctx.logger.info(`dsh-hscoach: 卡牌库就绪（${this.db.size} 张）→ ${publishDir}`);

    if (!this.cfg.apiKey) {
      this.ctx.logger.warn(
        "dsh-hscoach: 未配置 API key（config.apiKey 或环境变量 DEEPSEEK_API_KEY）——建议生成将降级",
      );
    }

    const provider: AdviceProvider = new DirectApiAdviceProvider({
      baseURL: this.cfg.baseURL,
      apiKey: this.cfg.apiKey,
      model: this.cfg.model,
      timeoutMs: this.cfg.adviceTimeoutMs,
      fetchImpl: this.deps.fetch,
    });

    this.engine = new CoachEngine({
      publishDir,
      db: this.db,
      adviceProvider: provider,
      friendlyPlayerId: this.cfg.friendlyPlayerId ?? null,
      coachMode: this.cfg.coachMode,
      onEvent: (event) => this.handleEvent(event),
    });

    // /hscoach 命令（服务缺席时仍安全跳过）
    this.ctx.inject(["commands"], (cmdCtx) => {
      cmdCtx.effect(
        () => cmdCtx.commands!.register({
          name: "hscoach",
          description: "Hearthstone 教练：日志监听与出牌建议",
          input: { hint: "<status | start | stop | think | mode <teach|compete|silent> | restore-log>" },
          handler: (invocation) => this.handleCommand(invocation),
        }),
        "dsh-hscoach: /hscoach command",
      );
    });

    // "再想想"反通道：轮询触发文件（Tauri 按钮写入）
    this.stopThinkAgainPoll = this.deps.setInterval(() => this.pollThinkAgain(), 1000);

    this.ctx.effect(() => () => this.shutdown(), "dsh-hscoach: shutdown");

    if (this.cfg.autoStart) await this.start();
  }

  private handleEvent(event: EngineEvent): void {
    switch (event.type) {
      case "game-start":
        this.log("新对局开始");
        break;
      case "calibrated":
        this.log(`自动校准：友方玩家 id = ${event.friendlyPlayerId}`);
        break;
      case "advice-published":
        this.log(`T${event.turn} 建议已发布（${event.latencyMs}ms${event.degraded ? "，降级" : ""}）：${event.headline}`);
        break;
      case "advice-degraded":
        this.ctx.logger.warn(`dsh-hscoach: ${event.reason}`);
        break;
      case "game-result":
        this.log(`对局结束：${event.result}（T${event.turns}）→ ${event.stats.wins}胜${event.stats.losses}负（${event.stats.winrate_pct}%）`);
        break;
      default:
        break;
    }
  }

  private log(message: string): void {
    this.events.push(message);
    if (this.events.length > 200) this.events.shift();
    this.ctx.logger.info(`dsh-hscoach: ${message}`);
  }

  private async handleCommand(invocation: {
    rawInput?: string;
  }): Promise<{ kind: "success" | "error"; text: string }> {
    const raw = String(invocation?.rawInput ?? "").trim();
    const [verb, ...rest] = raw === "" ? ["status"] : raw.split(/\s+/);
    try {
      switch (verb) {
        case "status":
          return { kind: "success", text: await this.statusText() };
        case "start":
          await this.start();
          return { kind: "success", text: "教练已开始监听 Power.log。" };
        case "stop":
          await this.shutdownTail();
          return { kind: "success", text: "教练已停止监听（战绩与建议文件保留）。" };
        case "think":
          await this.engine!.thinkAgain();
          return { kind: "success", text: "已基于当前局面重新推理（再想想）。" };
        case "mode": {
          const mode = rest[0];
          if (mode !== "teach" && mode !== "compete" && mode !== "silent") {
            return { kind: "error", text: "用法：/hscoach mode <teach|compete|silent>" };
          }
          if (this.engine) this.engine.coachMode = mode;
          return { kind: "success", text: `教练模式已切换为 ${mode}。` };
        }
        case "restore-log": {
          const status = await restoreLogConfig();
          return { kind: "success", text: status.message };
        }
        default:
          return {
            kind: "error",
            text: "未知子命令。可用：status / start / stop / think / mode <teach|compete|silent> / restore-log",
          };
      }
    } catch (error) {
      return { kind: "error", text: error instanceof Error ? error.message : String(error) };
    }
  }

  private async statusText(): Promise<string> {
    const publishDir = resolvePublishDir(this.cfg.publishDir);
    const lines = [
      `监听：${this.running ? "运行中" : "已停止"}`,
      `发布目录：${publishDir}`,
      `卡牌库：${this.db?.size ?? 0} 张`,
      `模型：${this.cfg.model}（${this.cfg.baseURL}）`,
      `教练模式：${this.cfg.coachMode}`,
      `友方 id：${this.engine?.getFriendlyPlayerId() ?? "自动校准"}`,
    ];
    const stats = await aggregate(join(publishDir, "history.jsonl"));
    if (stats.total > 0) {
      lines.push(`战绩：${stats.wins}胜 ${stats.losses}负 ${stats.ties}平（${stats.winrate_pct}%）`);
    }
    const advicePath = join(publishDir, ADVICE_FILENAME);
    if (existsSync(advicePath)) {
      try {
        const advice = JSON.parse(await readFile(advicePath, "utf-8")) as {
          turn?: number;
          advice?: { headline?: string; degraded?: boolean };
        };
        lines.push(
          `最近建议（T${advice.turn ?? "?"}）：${advice.advice?.headline ?? ""}${advice.advice?.degraded ? "（降级）" : ""}`,
        );
      } catch {
        // 建议文件读取失败不致命
      }
    }
    return lines.join("\n");
  }

  private async start(): Promise<void> {
    if (this.running || this.stopped || !this.engine) return;
    // 尽力开启炉石日志（失败不阻断——用户可能没装炉石）
    try {
      const status = await this.deps.ensureLogConfig();
      this.log(`log.config: ${status.action}`);
    } catch (error) {
      this.ctx.logger.warn(`dsh-hscoach: log.config 配置失败（${String(error)}）`);
    }
    const tail = new this.deps.tail({
      resolvePath: this.deps.resolveLogPath,
      pollIntervalMs: 300,
      shouldStop: () => this.stopped || !this.running,
      onLines: (lines) => this.engine!.processLines(lines),
    });
    this.tail = tail;
    this.running = true;
    void tail.run().catch((error) => {
      this.ctx.logger.error(`dsh-hscoach: tail 异常退出：${String(error)}`);
      this.running = false;
    });
    this.log("开始监听 Power.log（打开炉石打一局即开始）");
  }

  private async shutdownTail(): Promise<void> {
    this.running = false;
    this.tail?.stop();
    this.tail = null;
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    await this.shutdownTail();
    this.stopThinkAgainPoll?.();
    // 清理可能残留的触发文件
    const trigger = join(resolvePublishDir(this.cfg.publishDir), THINK_AGAIN_FILENAME);
    try {
      if (existsSync(trigger)) unlinkSync(trigger);
    } catch {
      // ignore
    }
  }

  /** watch 发布目录的 think-again.trigger（mtime 变化即触发）。 */
  private pollThinkAgain(): void {
    if (this.stopped || !this.engine || !this.running) return;
    const trigger = join(resolvePublishDir(this.cfg.publishDir), THINK_AGAIN_FILENAME);
    if (!existsSync(trigger)) return;
    let mtime: number;
    try {
      mtime = statSync(trigger).mtimeMs;
    } catch {
      return;
    }
    if (mtime === this.thinkAgainMtime) return;
    this.thinkAgainMtime = mtime;
    try {
      unlinkSync(trigger);
      this.thinkAgainMtime = 0;
    } catch {
      // 删除失败下次还会触发；先继续
    }
    this.log("收到再想想触发（think-again.trigger）");
    void this.engine.thinkAgain();
  }
}

/**
 * cordis 函数插件：loader 取 default 导出直接交给 registry（函数插件是
 * cordis 的一等形态）。宿主类型仅 `import type`，运行期零宿主包依赖。
 */
const hscoach: (ctx: Context, config: Record<string, unknown>) => Promise<void> = async (
  ctx,
  config,
) => {
  const plugin = new HsCoachPlugin(ctx, resolveConfig(config));
  await plugin.init();
};
// Plugin.Base.name 元数据（fiber 诊断显示名）；函数 name 只读，经 defineProperty 赋值
Object.defineProperty(hscoach, "name", { value: "dsh-hscoach" });

export default hscoach;

/**
 * dsh-hscoach 插件入口（cordis Service）。
 *
 * 职责组合（插件掌管生命周期，NTEToolbox 只读发布文件）：
 * - 启动时：构建卡牌库 → 尽力开启炉石日志 → 启动 Power.log tail 引擎
 * - /hscoach 命令：status/start/stop/think/mode/restore-log
 * - "再想想"反通道：watch 发布目录的 think-again.trigger 文件
 * - 配置：静态项走 cordis.patch.yml；运行时开关走命令
 */
import { join } from "node:path";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { Service, type Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { CardDatabase, defaultDataDirs } from "./core/cards.js";
import { ensureLogConfig, powerLogPath, restoreLogConfig } from "./core/logConfig.js";
import { PowerLogTail } from "./core/tail.js";
import { ADVICE_FILENAME, THINK_AGAIN_FILENAME } from "./core/trigger.js";
import { CoachEngine, type AdviceProvider, type EngineEvent } from "./runtime/engine.js";
import { DshAgentAdviceProvider } from "./advice/dshProvider.js";
import { DEFAULT_COACH_MODE } from "./advice/prompts.js";
import { aggregate } from "./core/history.js";

export const name = "dsh-hscoach";

/** 插件配置（cordis.patch.yml 的 config 键编辑）。 */
export const Config = z.object({
  /** 发布目录；空串 = %LOCALAPPDATA%\com.ntetoolbox.client\hscoach（与 Tauri 契约一致）。 */
  publishDir: z.string().default(""),
  /** 友方玩家 id；不填 = 日志自动校准（推荐）。 */
  friendlyPlayerId: z.number().step(1).min(1).max(2),
  coachMode: z.string().default(DEFAULT_COACH_MODE),
  /** 模型路由覆盖；空串 = 跟随宿主 agent-default-model。 */
  provider: z.string().default(""),
  model: z.string().default(""),
  /** 推理力度；教练要低延迟，默认 off（宿主全局可能是 max）。 */
  reasoningEffort: z.string().default("off"),
  /** 建议生成 watchdog。 */
  adviceTimeoutMs: z.number().step(1).min(1000).default(15000),
  /** 卡牌库数据目录；空串 = 自动探测（包 data/）。 */
  cardDataDir: z.string().default(""),
  /** dsh 启动后自动开始监听。 */
  autoStart: z.boolean().default(true),
});

export interface HsCoachPluginConfig {
  publishDir: string;
  friendlyPlayerId?: number;
  coachMode: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  adviceTimeoutMs: number;
  cardDataDir: string;
  autoStart: boolean;
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
 * realRuntimeDeps 用真实文件系统；测试构造 fake。
 */
export interface RuntimeDeps {
  resolveLogPath(): Promise<string>;
  tail: new (options: import("./core/tail.js").TailOptions) => PowerLogTail;
  /** log.config 开启（测试注入桩，避免碰真实炉石配置）。 */
  ensureLogConfig(): Promise<import("./core/logConfig.js").LogConfigStatus>;
  now(): number;
}

export const realRuntimeDeps: RuntimeDeps = {
  resolveLogPath: () => powerLogPath(),
  tail: PowerLogTail,
  ensureLogConfig,
  now: () => Date.now(),
};

export class HsCoachService extends Service {
  /** timer：ctx.setInterval（cordis-plugin-timer）需显式声明注入。 */
  static inject = ["agents", "agentDefaultModel", "timer"];
  static Config = Config;

  private readonly cfg: HsCoachPluginConfig;
  private engine: CoachEngine | null = null;
  private db: CardDatabase | null = null;
  private tail: PowerLogTail | null = null;
  private stopped = false;
  private running = false;
  private thinkAgainMtime = 0;
  private thinkAgainPoll?: () => void;
  private readonly events: string[] = [];

  constructor(ctx: Context, config: HsCoachPluginConfig, private readonly deps: RuntimeDeps = realRuntimeDeps) {
    super(ctx, "hsCoach");
    this.cfg = config;
  }

  async [Service.init](): Promise<void> {
    const publishDir = resolvePublishDir(this.cfg.publishDir);

    // 卡牌库（离线，内置数据）
    this.db = new CardDatabase(
      this.cfg.cardDataDir ? [this.cfg.cardDataDir, ...defaultDataDirs()] : defaultDataDirs(),
    );
    await this.db.build();
    this.ctx.logger.info(`dsh-hscoach: 卡牌库就绪（${this.db.size} 张）→ ${publishDir}`);

    const provider: AdviceProvider = new DshAgentAdviceProvider({
      agents: this.ctx.agents!,
      defaultModel: this.ctx.agentDefaultModel!,
      db: this.db,
      publishDir,
      providerOverride: this.cfg.provider,
      modelOverride: this.cfg.model,
      reasoningEffort: this.cfg.reasoningEffort,
      timeoutMs: this.cfg.adviceTimeoutMs,
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
    this.thinkAgainPoll = this.ctx.setInterval(() => this.pollThinkAgain(), 1000);

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
    this.thinkAgainPoll?.();
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

/** cordis 插件导出形态与 dsh-git-tree 参考插件一致：
 * loader 取 default 导出（Service 类是函数，cordis registry 直接接受）。 */
export default HsCoachService;

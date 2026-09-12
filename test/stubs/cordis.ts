/**
 * @deepseek-ai/cordis 测试桩：与宿主 Context/Service 形态一致的最小实现。
 * 通过 vitest 别名替换（测试里经 `as unknown as Context` 传入服务）。
 */
export class Service {
  static readonly init: unique symbol = Symbol("init") as never;
  static inject?: string[];
  static Config?: unknown;
  constructor(public ctx: unknown, public name?: string) {}
}

export class StubContext {
  readonly logs: Array<{ level: string; message: string }> = [];
  readonly effects: Array<() => void> = [];
  readonly intervals: Array<() => void> = [];
  readonly handlers = new Map<string, (...args: never[]) => unknown>();

  readonly logger = {
    info: (message: string) => this.logs.push({ level: "info", message }),
    warn: (message: string) => this.logs.push({ level: "warn", message }),
    error: (message: string) => this.logs.push({ level: "error", message }),
    debug: (message: string) => this.logs.push({ level: "debug", message }),
  };

  readonly commands = new FakeCommands();
  readonly agents = new FakeAgents();
  readonly agentDefaultModel = {
    currentSelection: () => ({ provider: "test", model: "test-model" }),
  };
  readonly tools = new FakeTools();
  readonly systemPrompt = new FakeSystemPrompt();

  /** cordis 语义：立即调用 fn，其返回值（函数）作为 disposer。 */
  effect(fn: () => unknown): void {
    const result = fn();
    if (typeof result === "function") this.effects.push(result as () => void);
  }
  setInterval(cb: () => void): () => void {
    this.intervals.push(cb);
    return () => {
      const idx = this.intervals.indexOf(cb);
      if (idx >= 0) this.intervals.splice(idx, 1);
    };
  }
  inject(_deps: string[], cb: (ctx: StubContext) => void): void {
    cb(this);
  }
  on(event: string, handler: (...args: never[]) => unknown): () => void {
    this.handlers.set(event, handler);
    return () => this.handlers.delete(event);
  }
  plugin(_plugin: unknown, _config?: unknown): void {
    // 测试由构造方直接实例化 Service；plugin 调用不做事
  }
}

export class FakeCommands {
  readonly registrations: Array<{
    name: string;
    handler: (invocation: { rawInput?: string }) => Promise<{ kind: string; text: string }>;
  }> = [];
  register(definition: {
    name: string;
    handler: (invocation: { rawInput?: string }) => Promise<{ kind: string; text: string }>;
  }): () => void {
    this.registrations.push(definition);
    return () => {
      const idx = this.registrations.indexOf(definition);
      if (idx >= 0) this.registrations.splice(idx, 1);
    };
  }
}

export class FakeAgents {
  readonly creations: Array<{ sessionId: string; agentOptions?: Record<string, unknown> }> = [];
  /** 测试注入：拿到 agent 及其作用域上下文，模拟模型行为（调工具/超时）。 */
  onCreate: (agent: FakeAgent, agentCtx: StubContext) => void = () => {};

  async create(options: {
    sessionId: string;
    agentOptions?: Record<string, unknown>;
    setup?: (ctx: unknown) => unknown;
  }): Promise<{ agent: FakeAgent; dispose(): void }> {
    this.creations.push({ sessionId: options.sessionId, agentOptions: options.agentOptions });
    const agent = new FakeAgent();
    const agentCtx = new StubContext();
    (agentCtx.tools as FakeTools).ownerAgent = agent;
    options.setup?.(agentCtx);
    this.onCreate(agent, agentCtx);
    return {
      agent,
      dispose: () => {
        agent.disposed = true;
      },
    };
  }
}

export class FakeAgent {
  readonly followups: unknown[] = [];
  cancelled: string | null = null;
  disposed = false;
  private resolveIdle!: () => void;
  readonly idlePromise: Promise<void>;

  constructor() {
    this.idlePromise = new Promise((resolve) => {
      this.resolveIdle = resolve;
    });
  }
  followup(message: unknown): void {
    this.followups.push(message);
  }
  whenIdle(): Promise<void> {
    return this.idlePromise;
  }
  cancel(cause?: string): void {
    this.cancelled = cause ?? "cancelled";
    this.resolveIdle();
  }
  finish(): void {
    this.resolveIdle();
  }
  get status(): "idle" | "running" {
    return "running";
  }
  readonly session = { id: "test", seq: 0, events: [] };
}

export class FakeTools {
  readonly registered: Array<Record<string, unknown>> = [];
  readonly restrictCalls: Array<{ allow?: string[]; deny?: string[] }> = [];
  ownerAgent: FakeAgent | null = null;

  register(definition: Record<string, unknown>): () => void {
    this.registered.push(definition);
    return () => {
      const idx = this.registered.indexOf(definition);
      if (idx >= 0) this.registered.splice(idx, 1);
    };
  }
  restrict(options: { allow?: string[]; deny?: string[] }): void {
    this.restrictCalls.push(options);
  }
  guard(_fn: unknown): void {}
}

export class FakeSystemPrompt {
  readonly sections: Array<{ name: string; order: number; text: string }> = [];
  section(section: { name: string; order: number; text: string }): void {
    this.sections.push(section);
  }
}

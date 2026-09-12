/**
 * dsh 宿主包的环境类型声明（rc 未发布 .d.ts，按已核验的 rc.6 接口手写）。
 * 运行时这些模块由 dsh profile 的 node_modules 解析；测试用
 * test/stubs/*.ts 替换。接口升级时同步更新此文件与 DSH_CAPS 文档。
 */

declare module "@deepseek-ai/cordis" {
  export class Service {
    static readonly init: unique symbol;
    constructor(ctx: Context, name?: string);
    protected ctx: Context;
  }

  export interface Context {
    logger: {
      info(message: string, ...args: unknown[]): void;
      warn(message: string, ...args: unknown[]): void;
      error(message: string, ...args: unknown[]): void;
      debug(message: string, ...args: unknown[]): void;
    };
    /** 注册清理回调（HMR/卸载安全），返回值可为卸载函数。 */
    effect(disposer: () => void, label?: string): void;
    /** effect 作用域的定时器（自动清理）。 */
    setInterval(callback: () => void, ms: number): () => void;
    /** 依赖注入：所需服务就绪后回调（子作用域）。 */
    inject(deps: string[], callback: (ctx: Context) => void): void;
    on(event: string, handler: (...args: never[]) => unknown): () => void;
    /** 声明的插件配置对象。 */
    config?: Record<string, unknown>;
    /** 装载子插件（apply 入口的标准形态）。 */
    plugin(plugin: unknown, config?: unknown): void;
    commands?: CommandsService;
    agents?: AgentsService;
    agentDefaultModel?: AgentDefaultModelService;
    tools?: ToolsService;
    systemPrompt?: SystemPromptService;
  }

  export interface CommandsService {
    register(definition: {
      name: string;
      description: string;
      input?: { hint?: string };
      recordInput?: boolean;
      handler: (invocation: {
        rawInput?: string;
        agent?: { session?: { id: string } };
      }) => Promise<{ kind: "success" | "error"; text: string }>;
    }): () => void;
  }

  export interface AgentDefaultModelService {
    currentSelection(): { provider: string; model: string };
  }

  export interface AgentSessionEvent {
    seq: number;
    type: string;
    data?: unknown;
  }

  export interface Agent {
    followup(message: unknown): void;
    whenIdle(): Promise<void>;
    cancel(cause?: string): void;
    status: "idle" | "running";
    session: { id: string; seq: number; events: AgentSessionEvent[] };
  }

  export interface AgentsService {
    create(options: {
      sessionId: string;
      meta?: Record<string, unknown>;
      agentOptions?: { provider?: string; model?: string; maxTokens?: number };
      setup?: (agentCtx: Context) => { commit?(): void } | void;
      signal?: AbortSignal;
    }): Promise<{ agent: Agent; dispose(): void }>;
  }

  export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output?: {
      schema?: Record<string, unknown>;
      render?: (
        args: Record<string, unknown>,
        value: unknown,
      ) => Array<{ type: "text"; text: string }>;
    };
    timeoutMs?: number;
    execute(
      args: Record<string, unknown>,
      exec: { concludeTurn(): void; signal: AbortSignal; name: string },
    ): Promise<Record<string, unknown>>;
  }

  export interface ToolsService {
    register(definition: ToolDefinition): () => void;
    /** agent 作用域限定：白名单/黑名单屏蔽继承的全局工具。 */
    restrict(options: { allow?: string[]; deny?: string[] }): void;
    guard(fn: (exec: { name: string }) => string | undefined): void;
  }

  export interface SystemPromptService {
    section(section: { name: string; order: number; text: string }): void;
  }
}

declare module "@deepseek-ai/schemastery" {
  const z: {
    string: (options?: { min?: number; max?: number }) => StringSchema;
    number: (options?: { step?: number; min?: number; max?: number }) => NumberSchema;
    boolean: () => BooleanSchema;
    object: (shape: Record<string, unknown>) => ObjectSchema;
  };
  interface StringSchema {
    default(value: string): StringSchema;
    required(): StringSchema;
    description(text: string): StringSchema;
  }
  interface NumberSchema {
    default(value: number): NumberSchema;
    required(): NumberSchema;
    optional(): NumberSchema;
    step(value: number): NumberSchema;
    min(value: number): NumberSchema;
    max(value: number): NumberSchema;
    description(text: string): NumberSchema;
  }
  interface BooleanSchema {
    default(value: boolean): BooleanSchema;
    description(text: string): BooleanSchema;
  }
  interface ObjectSchema {
    default(value: Record<string, unknown>): ObjectSchema;
  }
  export default z;
}

declare module "@deepseek-ai/dsh-llm" {
  export function createUserMessage(message: {
    content: Array<{ type: "text"; text: string }>;
    source: { kind: "user" };
  }): unknown;
}

declare module "@deepseek-ai/dsh-tools" {
  export class ToolArgsError extends Error {}
  export function validateJsonSchemaValue(
    schema: Record<string, unknown>,
    value: unknown,
  ): string[];
}

/**
 * dsh 宿主的环境类型声明（纯类型，编译后全部擦除）。
 *
 * 插件运行期零 @deepseek-ai/* 依赖——`import type` 不产出任何运行时导入，
 * 因此插件可直接装进任何 dsh profile，无需宿主包链接。dsh 接口升级时
 * 对照宿主更新此文件。
 */

declare module "@deepseek-ai/cordis" {
  export interface Context {
    logger: {
      info(message: string, ...args: unknown[]): void;
      warn(message: string, ...args: unknown[]): void;
      error(message: string, ...args: unknown[]): void;
      debug(message: string, ...args: unknown[]): void;
    };
    /** 注册清理（HMR/卸载安全）；setup 返回函数时作为卸载器。 */
    effect(setup: () => (() => void) | void, label?: string): void;
    /** 依赖注入：所需服务就绪后回调（子作用域）；服务缺席时等待。 */
    inject(deps: string[], callback: (ctx: Context) => void): void;
    commands?: CommandsService;
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
}

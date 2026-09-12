import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // 宿主包（@deepseek-ai/*）只在 dsh profile 的 node_modules 里存在。
      // 类型来自 src/types/host.d.ts 的环境声明；测试运行时用桩模块替换，
      // 让插件入口（index.ts）的装配逻辑也能被单测覆盖。
      "@deepseek-ai/cordis": fileURLToPath(
        new URL("./test/stubs/cordis.ts", import.meta.url),
      ),
      "@deepseek-ai/schemastery": fileURLToPath(
        new URL("./test/stubs/schemastery.ts", import.meta.url),
      ),
      "@deepseek-ai/dsh-llm": fileURLToPath(
        new URL("./test/stubs/dsh-llm.ts", import.meta.url),
      ),
      "@deepseek-ai/dsh-tools": fileURLToPath(
        new URL("./test/stubs/dsh-tools.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  // 插件运行期零 @deepseek-ai/* 依赖（宿主 import 全为 `import type`，
  // 编译后擦除），无需模块别名；宿主桩见 test/stubs/host.ts。
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});

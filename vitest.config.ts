// ============================================================
// vitest.config.ts — 单元/集成测试配置
// 职责边界：Vitest 负责函数级正确性；端到端决策质量评估由 eval/ Harness 负责。
// ============================================================

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "spec/**/*.test.ts", "web/test/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/**", "spec/**"],
      reporter: ["text", "html"],
    },
  },
});

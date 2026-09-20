// ============================================================
// scripts/start.mjs — 一键启动脚本（跨平台）
//
// 自动完成：Node 版本检查 → 依赖安装 → 环境提示 → 并行启动前后端
// 用法：npm start  或  node scripts/start.mjs
// ============================================================

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const webDir = join(root, "web");

console.log("🧭 AI出行决策 Agent — 一键启动");
console.log("================================");

// 1. 检查 Node.js 版本（与当前构建、页面测试依赖要求一致）
const nodeVer = process.versions.node;
const [major, minor] = nodeVer.split(".").map(Number);
if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 13) || major >= 24)) {
  console.error(`❌ 需要 Node.js 20.19+（20.x）、22.13+（22.x）或 24+，当前：v${nodeVer}`);
  process.exit(1);
}
console.log(`✅ Node.js v${nodeVer}`);

// 2. 安装主项目依赖
if (!existsSync(join(root, "node_modules"))) {
  console.log("📦 安装主项目依赖...");
  execSync("npm install", { stdio: "inherit", cwd: root });
}

// 3. 安装前端依赖
if (!existsSync(join(webDir, "node_modules"))) {
  console.log("📦 安装前端依赖...");
  execSync("npm install", { stdio: "inherit", cwd: webDir });
}

// 4. 检查 .env（可选，缺失则用 Mock 数据）
if (!existsSync(join(root, ".env"))) {
  console.log("ℹ️  未找到 .env，将使用 Mock 数据（无需 LLM Key 也能运行）");
} else {
  console.log("✅ 检测到 .env 配置");
}

// 5. 启动前后端
console.log("");
console.log("🚀 启动中...");
console.log("   后端 API:  http://localhost:3000");
console.log("   前端看板:  http://localhost:5173");
console.log("   API 文档:  http://localhost:3000/docs");
console.log("   健康检查:  http://localhost:3000/health");
console.log("");
console.log("按 Ctrl+C 停止所有服务");
console.log("================================");

const child = spawn("npm", ["run", "dev:web"], {
  stdio: "inherit",
  shell: true,
  cwd: root,
});

child.on("close", (code) => process.exit(code ?? 0));

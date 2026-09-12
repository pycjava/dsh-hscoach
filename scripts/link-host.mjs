/**
 * 为 dsh-hscoach 建立宿主包的目录链接（Windows junction / POSIX symlink）。
 *
 * dsh 插件跑在宿主后端进程里，@deepseek-ai/* 由宿主提供（peer），但 ESM
 * 解析从插件自身目录向上查找——需要本地链接指向宿主 node_modules（与
 * dsh-git-tree 参考插件同款做法，版本与宿主严格一致）。测试不受影响
 * （vitest 别名优先于 node 解析）。
 *
 * 用法：node scripts/link-host.mjs
 */
import { existsSync, symlinkSync, unlinkSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_PACKAGES = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-tools",
];

function hostNodeModules() {
  const candidates = [
    process.env.DSH_BACKEND_NODE_MODULES,
    join(process.env.LOCALAPPDATA ?? "", "Programs", "dsh", "resources", "backend", "node_modules"),
    "D:\\dsh\\DeepSeek Harness\\resources\\backend\\node_modules",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "@deepseek-ai", "cordis"))) return candidate;
  }
  throw new Error(
    `未找到 dsh 宿主 node_modules（设 DSH_BACKEND_NODE_MODULES 或检查默认路径）：${candidates.join(", ")}`,
  );
}

function link(target, linkPath) {
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) unlinkSync(linkPath);
  }
  if (process.platform === "win32") {
    // junction 免管理员权限；目标必须是目录
    symlinkSync(target, linkPath, "junction");
  } else {
    symlinkSync(target, linkPath, "dir");
  }
}

const host = hostNodeModules();
const scopedRoot = join(PKG_ROOT, "node_modules", "@deepseek-ai");
if (!existsSync(scopedRoot)) mkdirSync(scopedRoot, { recursive: true });
for (const pkg of HOST_PACKAGES) {
  const target = join(host, pkg);
  if (!existsSync(target)) throw new Error(`宿主缺少 ${pkg}：${target}`);
  const linkPath = join(PKG_ROOT, "node_modules", pkg);
  link(target, linkPath);
  console.log(`linked ${pkg} -> ${target}`);
}
console.log("done.");

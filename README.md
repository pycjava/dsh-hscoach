# dsh-hscoach — 炉石教练 dsh 插件

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件：监听炉石传说 Power.log，
本地计算合法可见对局快照（隐藏信息过滤）与斩杀判定，出牌建议经**直连 DeepSeek 兼容 API**
（单次 chat + JSON 输出，不经宿主 agents 服务）生成，原子写 `advice.json` / `game_state.json` / `stats.json`
到发布目录，供 NTEToolbox 悬浮窗消费。

**自包含**：运行期零 `@deepseek-ai/*` 依赖（宿主 import 全为 `import type`，编译后擦除）——
装进任何 dsh profile 即可运行，无需宿主包链接，也不要求 profile 提供 agents/timer 等服务。

## 设计决策（定稿）

| 决策 | 结论 |
|------|------|
| 确定性核心 | 解析器/斩杀 DP/触发器/历史/Windows 杂务全部 TS 本地计算，无 Python 依赖 |
| 回归钉 | `test/parity.test.ts` 对照冻结黄金快照逐字段一致（两份真实日志 fixture） |
| LLM 形态 | 直连 API 单发：`chat/completions` + `response_format: json_object`，prompt 内嵌抽牌概率与伤害评估 |
| 宿主依赖 | 运行期零 `@deepseek-ai/*`（类型经 `src/types/host.d.ts` 环境声明）；无服务 inject，全局 `setInterval` 自管清理 |
| 隐藏信息 | 序列化层强制（对手手牌只有数量），prompt 只见合法可见快照 |
| 延迟 | 15s watchdog（AbortController），超时/失败降级回显上回合建议 |
| 生命周期 | 插件掌管（dsh 没开就没教练）；NTEToolbox 面板纯展示 + 再想想按钮 |
| 配置 | 静态项走 cordis.patch.yml（显式 `resolveConfig`：config > 环境变量 > 默认值）；运行时开关走 `/hscoach` 斜杠命令 |

## 使用

```bash
# 构建（产物 lib/ + 内置 data/；无需宿主包链接）
pnpm build

# 装载到 profile（smoke 为验证用独立 profile，示例）
dsh plugin --profile smoke add D:\dsh-hscoach

# 测试（vitest，宿主桩 + fetch 桩，不依赖链接与网络）
pnpm test
```

### 插件导出契约

- default 导出是**普通函数插件**（cordis `Plugin.Function`：`(ctx, config) => Promise<void>`），
  loader 取 default 导出直接交给 registry——与 vendored cordis 的 `Plugin` 联合类型一致
- 无 `inject` 服务声明：`/hscoach` 命令经 `ctx.inject(['commands'], ...)` 惰性注入，
  轮询定时器用全局 `setInterval` + `ctx.effect` 清理，不依赖 cordis-plugin-timer

### 配置（cordis.patch.yml 或 profile 的 cordis.patch.yml 覆盖）

```yaml
- insert:
    - id: dsh-hscoach
      name: dsh-hscoach
      config:
        publishDir: ""            # 空 = %LOCALAPPDATA%\com.ntetoolbox.client\hscoach（Tauri identifier 目录，与客户端契约一致；可用 DSH_HSCOACH_PUBLISH_DIR 覆盖）
        friendlyPlayerId: 1       # 不填 = 日志自动校准（推荐）
        coachMode: teach          # teach / compete / silent
        apiKey: ""                # 空 = 环境变量 DEEPSEEK_API_KEY（缺失时启动告警、建议降级）
        baseURL: ""               # 空 = 环境变量 DEEPSEEK_BASE_URL 或 https://api.deepseek.com
        model: ""                 # 空 = deepseek-chat
        adviceTimeoutMs: 15000    # watchdog
        autoStart: true
```

### 斜杠命令

```
/hscoach status                     运行状态/战绩/最近建议
/hscoach start | stop               启停 Power.log 监听
/hscoach think                      基于当前局面重新推理（再想想）
/hscoach mode teach|compete|silent  运行时切换教练模式
/hscoach restore-log                回滚本插件对 log.config 的修改
```

## 发布契约（advice.json）

```json
{
  "turn": 5,
  "timestamp": "2026-09-12T20:00:00",
  "advice": {
    "kind": "play|trade|pass|uncertain",
    "headline": "一句话主推荐",
    "why": "1-2 句理由",
    "steps": ["步骤"],
    "warning": "风险",
    "alternatives": [{ "headline": "另一打法", "why": "为何可行" }],
    "latency_ms": 3200,
    "degraded": false,
    "lethal": true
  }
}
```

`game_state.json` 为过滤隐藏信息后的实时快照（对手手牌只有 `{"count": N}`）；`think-again.trigger`
为 NTEToolbox"再想想"按钮的反通道文件（出现即消费）。

## 维护

- **枚举表**：`src/core/enums.generated.ts` 由 NTEToolbox 仓库的
  `tools/gen_hs_enums.py`（依赖 `hearthstone` 包）生成，升级游戏版本后在
  NTEToolbox 仓库运行并拷贝过来
- **黄金快照**：为冻结回归基准（无再生成工具）；修改确定性核心后 `pnpm test`
  必须保持逐字段一致，行为有意变更时手工更新快照
- **dsh 版本**：宿主接口声明在 `src/types/host.d.ts`（纯类型，仅 `Context`/`CommandsService`
  两个面）；dsh 升级时对照更新

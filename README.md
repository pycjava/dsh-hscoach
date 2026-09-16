# dsh-hscoach — 炉石教练 dsh 插件

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件：监听炉石传说 Power.log，
本地计算合法可见对局快照（D9 过滤）与斩杀判定，出牌建议经宿主 agent（`ctx.agents` +
`structured_output` 结构化收尾）生成，原子写 `advice.json` / `game_state.json` / `stats.json`
到发布目录，供 NTEToolbox 悬浮窗消费。

## 设计决策（定稿）

| 决策 | 结论 |
|------|------|
| 确定性核心 | 全量 TS 重写（解析器/斩杀 DP/触发器/历史/Windows 杂务），不捆绑 Python |
| 对拍验收 | `test/parity.test.ts` 对照 Python 黄金快照逐字段一致（两份真实日志 fixture） |
| LLM 形态 | agentic 多步（Q9b）：三工具（卡库/概率/战绩）+ structured_output |
| 隐藏信息 | D9 在序列化层强制（对手手牌只有数量），工具层闭包冻结快照，agent 白名单 |
| 延迟 | 15s watchdog（dsh 无内置上限），超时降级回显上回合建议 |
| 生命周期 | 插件掌管（dsh 没开就没教练）；NTEToolbox 面板纯展示 + 再想想按钮 |
| 配置 | 静态项走 cordis.patch.yml；运行时开关走 `/hscoach` 斜杠命令 |

## 使用

```bash
# 构建 + 建立 @deepseek-ai/* 宿主包链接（junction 指向 dsh 后端 node_modules，
# 版本与宿主严格一致；ESM 解析需要从插件目录可解析宿主包）
pnpm build
pnpm run link-host

# 装载到 profile（smoke 为验证用独立 profile，示例）
dsh plugin --profile smoke add D:\dsh-hscoach

# 测试（vitest 别名替换宿主包，不依赖链接）
pnpm test
```

### 插件导出契约（rc.6 实测）

- loader 取模块的 **default 导出**传给 cordis registry——必须
  `export default HsCoachService`（Service 类是函数，registry 直接接受）
- Service 访问 `ctx.setInterval` 需在 `static inject` 声明 `timer`
  （cordis-plugin-timer）；`ctx.inject(['commands'], ...)` 惰性注入命令服务

### 配置（cordis.patch.yml 或 profile 的 cordis.patch.yml 覆盖）

```yaml
- insert:
    - id: dsh-hscoach
      name: dsh-hscoach
      config:
        publishDir: ""            # 空 = %LOCALAPPDATA%\com.ntetoolbox.client\hscoach（Tauri identifier 目录，与客户端契约一致；可用 DSH_HSCOACH_PUBLISH_DIR 覆盖）
        friendlyPlayerId: 1       # 不填 = 日志自动校准（推荐）
        coachMode: teach          # teach / compete / silent
        provider: ""              # 空 = 跟随宿主 agent-default-model
        model: ""
        reasoningEffort: "off"    # 教练要低延迟；宿主全局默认可能是 max
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

`game_state.json` 为 D9 过滤后的实时快照（对手手牌只有 `{"count": N}`）；`think-again.trigger`
为 NTEToolbox"再想想"按钮的反通道文件（出现即消费）。

## 维护

- **枚举表**：升级 `hearthstone` 包后运行 `python tools/gen_hs_enums.py` 重新生成
  `src/core/enums.generated.ts`
- **对拍基准**：修改确定性核心后运行 `python tools/gen_hscoach_golden.py` 刷新黄金
  快照（须与 Python 实现行为一致），`pnpm test` 校验
- **dsh 版本**：宿主接口声明在 `src/types/host.d.ts`（按 rc.6 手写），dsh 升级时对照
  更新

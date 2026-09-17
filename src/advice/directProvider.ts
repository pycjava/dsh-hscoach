/**
 * 直连 LLM API 建议生成器：单次 chat/completions 调用 + JSON 输出 +
 * watchdog 超时（AbortController）。不经宿主 agents 服务——插件自包含，
 * 任何 dsh profile 均可运行。失败抛 ProviderError，由引擎降级
 * （上回合建议回显）。
 */
import { computeLethal, type LethalCheck } from "../core/lethal.js";
import { snapshotToContract, type GameSnapshot } from "../core/state.js";
import { emptyAdvice, type Advice } from "../core/trigger.js";
import { buildUserPrompt, getSystemPrompt } from "./prompts.js";
import type { AdviceProvider } from "../runtime/engine.js";

export class ProviderError extends Error {}

export interface DirectProviderDeps {
  /** DeepSeek 兼容 API 根地址（如 https://api.deepseek.com，不带尾斜杠）。 */
  baseURL: string;
  apiKey: string;
  model: string;
  /** watchdog 上限（毫秒）。 */
  timeoutMs: number;
  /** HTTP 实现（测试注入桩；需响应 signal 中止）。 */
  fetchImpl?: FetchLike;
}

/** fetch 的最小结构类型（避免依赖 DOM lib；全局 fetch 结构兼容）。 */
export interface FetchLike {
  (url: string, init?: RequestInitLike): Promise<ResponseLike>;
}

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

interface StructuredAdvice {
  kind: string;
  headline: string;
  why: string;
  steps?: string[];
  warning?: string;
  alternatives?: Array<{ headline: string; why: string }>;
}

export class DirectApiAdviceProvider implements AdviceProvider {
  constructor(private readonly deps: DirectProviderDeps) {}

  async generate(input: {
    snapshot: GameSnapshot;
    friendlyPlayerId: number;
    lethal: LethalCheck | null;
    coachMode: string;
    generation: number;
  }): Promise<Advice> {
    const { snapshot, friendlyPlayerId } = input;
    if (!this.deps.apiKey) {
      throw new ProviderError("未配置 LLM API key（config.apiKey 或环境变量 DEEPSEEK_API_KEY）");
    }
    const lethalCheck = input.lethal ?? computeLethal(snapshot, friendlyPlayerId);
    const system = getSystemPrompt(input.coachMode);
    const user = buildUserPrompt(snapshotToContract(snapshot), friendlyPlayerId, lethalCheck);
    const start = Date.now();

    const content = await this.chatJson(system, user);
    const payload = parseJsonContent(content);
    if (payload === null) {
      throw new ProviderError("模型响应不是合法 JSON");
    }
    const advice = toAdvice(payload as StructuredAdvice);
    advice.latency_ms = Date.now() - start;
    return advice;
  }

  /** 单次 chat 调用，返回 message.content；超时/非 200/空响应抛 ProviderError。 */
  private async chatJson(system: string, user: string): Promise<string> {
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    let response: ResponseLike;
    try {
      response = await (this.deps.fetchImpl ?? fetch)(
        `${this.deps.baseURL.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.deps.apiKey}`,
          },
          body: JSON.stringify({
            model: this.deps.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            response_format: { type: "json_object" },
            max_tokens: 4096,
            stream: false,
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderError(`建议生成超时（${this.deps.timeoutMs}ms）`);
      }
      throw new ProviderError(`LLM API 请求失败：${String(error)}`);
    } finally {
      clearTimeout(watchdog);
    }
    if (!response.ok) {
      throw new ProviderError(`LLM API 返回 ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    }
    const body = (await response.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new ProviderError("LLM API 响应缺少 choices[0].message.content");
    }
    return content;
  }
}

/** 从模型输出中提取 JSON：直接解析，失败则截取首尾花括号之间再试。 */
export function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (fenced) candidates.push(fenced[1]!);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

/** 模型 JSON 输出 → Advice 契约（字段宽容粗化，坏值降级不抛）。 */
export function toAdvice(payload: StructuredAdvice): Advice {
  const advice = emptyAdvice();
  const kind = String(payload.kind);
  advice.kind =
    kind === "play" || kind === "trade" || kind === "pass" || kind === "uncertain"
      ? kind
      : "uncertain";
  advice.headline = String(payload.headline ?? "");
  advice.why = String(payload.why ?? "");
  const steps = payload.steps;
  advice.steps = Array.isArray(steps) ? steps.map(String) : [];
  advice.warning = String(payload.warning ?? "");
  advice.alternatives = Array.isArray(payload.alternatives)
    ? payload.alternatives
        .filter((a) => a && typeof a === "object")
        .map((a) => ({ headline: String(a.headline ?? ""), why: String(a.why ?? "") }))
    : [];
  return advice;
}

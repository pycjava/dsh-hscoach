/** @deepseek-ai/dsh-llm 测试桩。 */
export function createUserMessage(message: unknown): unknown {
  return { kind: "user-message", message };
}

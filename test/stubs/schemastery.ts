/** @deepseek-ai/schemastery 测试桩：全方法链式返回自身，default 记录初值。 */
function chainable(initial?: unknown): Record<string, unknown> {
  const schema: Record<string, unknown> = { __default: initial };
  const methods = [
    "default",
    "required",
    "optional",
    "step",
    "min",
    "max",
    "description",
  ];
  for (const method of methods) {
    Object.defineProperty(schema, method, {
      value: (arg?: unknown) => {
        if (method === "default" || method === "optional") schema.__default = arg;
        return schema;
      },
      enumerable: false,
    });
  }
  return schema;
}

const z = {
  string: () => chainable(),
  number: () => chainable(),
  boolean: () => chainable(),
  object: (shape: Record<string, unknown>) => chainable(shape),
};
export default z;

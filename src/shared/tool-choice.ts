/** Anthropic `tool_choice.disable_parallel_tool_use` → whether to send OpenAI `parallel_tool_calls: false`. */
export function disablesParallelToolUse(choice: unknown): boolean {
  return (
    !!choice &&
    typeof choice === "object" &&
    (choice as { disable_parallel_tool_use?: unknown }).disable_parallel_tool_use === true
  );
}

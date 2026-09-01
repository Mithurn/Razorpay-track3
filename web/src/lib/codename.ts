// Deterministic codename from the agent id — same agent always reads as the same suspect.
// Modeled as model-backed shoppers: each name reads like a plausible agent stack.
const FIRST = ["CLAUDE", "GPT", "GEMINI", "GROK", "LLAMA", "MISTRAL", "QWEN", "DEEPSEEK", "COHERE", "PHI"];
const SECOND = ["SHOPPER", "BUYER", "SAVER", "SCOUT", "RUNNER", "PROXY", "SWARM"];

export function codename(agentId: string): string {
  let hash = 0;
  for (const char of agentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${FIRST[hash % FIRST.length]}-${SECOND[(hash >> 8) % SECOND.length]}-${(hash % 90) + 10}`;
}

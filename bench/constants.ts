// Per-case turn cap for the simulated pipeline loop: enough for the full retry / reschedule /
// settlement-recheck cycle up to the attempt cap, and a hard stop so a misbehaving case can
// never spin forever. Shared by the batch runner and the room seeder.
export const MAX_AGENT_TURNS_PER_CASE = 12;

// Cases advanced in parallel per batch. Matches the ~10-concurrent figure in CLAUDE.md — keeps a
// full real-model run in the ~5-8 min budget without flooding the model provider.
export const BENCH_CONCURRENCY = 10;

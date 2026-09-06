import type { Redis } from "ioredis";
import type { StopRequest, StopStore } from "./stop-registry.js";

const GLOBAL_KEY = "recovery:stop:global";
const casePrefix = "recovery:stop:case:";

// Persists the brake in Redis instead of process memory, so a stop issued against one node is
// visible to every worker node sharing the same Redis instance. Case-level stop keys never
// expire on their own — they're cleared only by resumeAll or by the case reaching a terminal
// lane, matching InMemoryStopStore's behaviour of holding a per-case stop indefinitely.
export class RedisStopStore implements StopStore {
  constructor(private readonly redis: Redis) {}

  async stopCase(caseId: string, request: StopRequest): Promise<void> {
    await this.redis.set(casePrefix + caseId, JSON.stringify(request));
  }

  async stopAll(request: StopRequest): Promise<void> {
    await this.redis.set(GLOBAL_KEY, JSON.stringify(request));
  }

  async resumeAll(): Promise<void> {
    await this.redis.del(GLOBAL_KEY);
  }

  async check(caseId: string): Promise<StopRequest | null> {
    const [global, perCase] = await this.redis.mget(GLOBAL_KEY, casePrefix + caseId);
    const raw = global ?? perCase;
    return raw ? (JSON.parse(raw) as StopRequest) : null;
  }

  async isBraked(): Promise<boolean> {
    return (await this.redis.exists(GLOBAL_KEY)) === 1;
  }
}

// Shared backoff loop behind useLiveRun and useRoomStream: open an SSE generator, hand every
// event to the caller, and on a dropped connection reconnect with exponential backoff — reset to
// no-delay the moment an event actually arrives, since a live drop right after a good connection
// shouldn't be penalized like a cold start. Stops when the signal aborts, `onEvent` returns
// `true` (the caller's own "this run is over" signal), or (if given) `maxAttempts` is exceeded
// without a single event landing.

export type ReconnectOptions = {
  baseMs?: number;
  maxMs?: number;
  /** Consecutive connect attempts allowed with no event landing between them. Unbounded if omitted. */
  maxAttempts?: number;
  onConnected?: () => void;
  onDisconnected?: () => void;
};

const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 8000;

export async function runReconnectingStream<T>(
  signal: AbortSignal,
  open: (signal: AbortSignal) => AsyncIterable<T>,
  onEvent: (ev: T) => boolean | void,
  opts: ReconnectOptions = {},
): Promise<void> {
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  let done = false;

  for (let attempt = 0; !signal.aborted && !done && (opts.maxAttempts === undefined || attempt <= opts.maxAttempts); attempt++) {
    if (attempt > 0) {
      const delay = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal.aborted) return;
    }
    try {
      for await (const ev of open(signal)) {
        if (signal.aborted) return;
        attempt = 0;
        opts.onConnected?.();
        if (onEvent(ev) === true) {
          done = true;
          break;
        }
      }
    } catch {
      /* dropped connection or abort; loop reconnects unless cancelled or done */
    }
    if (signal.aborted) return;
    opts.onDisconnected?.();
  }
}

// Shared exponential-backoff SSE reconnect loop behind useLiveRun and useRoomStream.

export type ReconnectOptions = {
  baseMs?: number;
  maxMs?: number;
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

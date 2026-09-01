// Scaffold. Day 2/3 fills this in against the real API surface (see context/PROJECT.md).
// The SSE reader below is the async-generator pattern from superkalam-chat's useChat.ts.

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  health: () => get<{ status: string }>("/health"),
};

// Reads a `data: {json}\n\n` SSE stream as an async iterable of parsed frames.
export async function* streamFrames<T>(path: string, signal?: AbortSignal): AsyncGenerator<T> {
  const res = await fetch(`/api${path}`, { headers: { Accept: "text/event-stream" }, signal });
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        yield JSON.parse(line.slice(6)) as T;
      } catch {
        // partial or keepalive frame; skip
      }
    }
  }
}

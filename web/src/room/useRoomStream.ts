import { useEffect, useRef, useState } from "react";
import { metrics as fetchMetrics, streamRoom } from "../api.js";
import type { RoomMetrics } from "../types.js";
import { runReconnectingStream } from "../loop/reconnectingStream.js";

// Drives the top bar and the case lanes from the canonical room-wide event stream, the same
// PublishingEventLog fan-out every durable backend event already passes through — never a
// frontend-invented signal. The stream itself only carries a metrics snapshot once, on open;
// every event after that is a durable fact ("this happened"), not a recomputed number, so a
// fresh total is fetched from GET /metrics — the real aggregate query — each time something
// lands, debounced so a burst of tool-call events doesn't hammer it.

export type RoomLiveState = {
  metrics: RoomMetrics | null;
  connected: boolean;
  // Bumps on every durable event across every case — callers refetch case lists off this rather
  // than waiting on a poll interval.
  version: number;
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 8000;
const METRICS_DEBOUNCE_MS = 250;

export function useRoomStream(): RoomLiveState {
  const [metrics, setMetrics] = useState<RoomMetrics | null>(null);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const refreshMetrics = () => {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        fetchMetrics()
          .then((m) => !cancelled && setMetrics(m))
          .catch(() => undefined);
      }, METRICS_DEBOUNCE_MS);
    };

    void runReconnectingStream(
      controller.signal,
      (signal) => streamRoom(signal),
      (ev) => {
        if (ev.type === "metrics") {
          const { type: _type, ...snapshot } = ev;
          void _type;
          setMetrics(snapshot);
        } else if (ev.type === "audit") {
          setVersion((n) => n + 1);
          refreshMetrics();
        }
      },
      {
        baseMs: RECONNECT_BASE_MS,
        maxMs: RECONNECT_MAX_MS,
        onConnected: () => setConnected(true),
        onDisconnected: () => setConnected(false),
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(debounceRef.current);
    };
  }, []);

  return { metrics, connected, version };
}

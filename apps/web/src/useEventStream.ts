import { useEffect, useRef, useState } from "react";
import type { BusEvent } from "./api.js";

/**
 * Subscribes to the server's WebSocket bus and replays events to a handler.
 * Auto-reconnects; exposes a live `connected` flag for the kernel status rail.
 */
export function useEventStream(onEvent: (event: BusEvent) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/events`);
      ws.addEventListener("open", () => setConnected(true));
      ws.addEventListener("message", (e) => {
        try {
          handlerRef.current(JSON.parse(e.data) as BusEvent);
        } catch {
          /* ignore malformed */
        }
      });
      ws.addEventListener("close", () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      });
      ws.addEventListener("error", () => ws?.close());
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { connected };
}

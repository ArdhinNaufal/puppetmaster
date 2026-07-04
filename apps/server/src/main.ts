import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { InMemoryEventBus } from "@puppetmaster/kernel";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({ logger: true });
const bus = new InMemoryEventBus();

await app.register(websocket);

app.get("/api/health", async () => ({
  ok: true,
  service: "puppetmaster-server",
  version: "0.0.1",
}));

// Live event stream for the web shell's mission feed.
app.get("/api/events", { websocket: true }, (socket) => {
  const unsubscribe = bus.subscribe((event) => {
    socket.send(JSON.stringify(event));
  });
  socket.on("close", unsubscribe);
});

await app.listen({ port: PORT, host: HOST });

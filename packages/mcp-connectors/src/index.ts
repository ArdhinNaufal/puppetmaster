import { fileURLToPath } from "node:url";

/** Absolute path of the bundled utils MCP server, for spawning over stdio. */
export const utilsServerPath = fileURLToPath(new URL("./utils-server.js", import.meta.url));

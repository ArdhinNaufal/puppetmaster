import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

// Load the repository .env before importing main or any kernel module whose
// defaults are captured at module initialization. Explicit process variables
// retain precedence. Tests may continue importing/spawning main directly with
// a fully controlled environment.
const configured = process.env.PUPPETMASTER_ENV_FILE?.trim();
const rootDefault = fileURLToPath(new URL("../../../.env", import.meta.url));
const envFile = configured
  ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured))
  : rootDefault;
if (existsSync(envFile)) loadEnvFile(envFile);

await import("./main.js");

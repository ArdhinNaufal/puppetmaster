import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const apiTarget = process.env.PUPPETMASTER_API_TARGET?.trim() || "http://localhost:4000";
  return {
    plugins: [react()],
    server: {
      port: 3000,
      proxy: {
        "/api": {
          target: apiTarget,
          ws: true,
        },
      },
    },
  };
});

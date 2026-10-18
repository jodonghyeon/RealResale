import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const httpsKey = process.env.REALRESALE_HTTPS_KEY;
const httpsCert = process.env.REALRESALE_HTTPS_CERT;
if (Boolean(httpsKey) !== Boolean(httpsCert)) {
  throw new Error("Set both REALRESALE_HTTPS_KEY and REALRESALE_HTTPS_CERT to enable HTTPS.");
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    https: httpsKey && httpsCert
      ? { key: readFileSync(httpsKey), cert: readFileSync(httpsCert) }
      : undefined,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest) => {
            proxyRequest.setHeader("origin", "http://127.0.0.1:5173");
          });
        },
      },
      "/media": "http://127.0.0.1:3001",
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) {
            return /\/three\/(examples|addons)\//.test(id) ? "three-addons" : "three-core";
          }
        },
      },
    },
  },
});

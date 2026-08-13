import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/landing/",
  plugins: [react()],
  root: resolve(import.meta.dirname, "frontend/landing"),
  publicDir: false,
  build: {
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, "public/landing"),
    target: "es2022",
  },
});

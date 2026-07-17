#!/usr/bin/env node
// Local dev stack: wrangler dev (worker + Durable Object + MCP on 8787)
// alongside vite (frontend on 8080, proxying /agents /mcp /health).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

// wrangler's assets binding requires the directory to exist even in dev.
mkdirSync(new URL("../dist", import.meta.url), { recursive: true });

const children = [];

function run(name, command, args) {
  const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code) => {
    console.log(`[dev] ${name} exited (${code ?? "signal"}) — shutting down`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("[dev] starting wrangler dev (:8787) + vite (:8080)…");
console.log("[dev] open http://localhost:8080 — MCP endpoint at http://localhost:8787/mcp");
run("wrangler", "npx", ["wrangler", "dev", "--port", "8787"]);
run("vite", "npx", ["vite"]);

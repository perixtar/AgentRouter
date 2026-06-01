#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const children = new Set();
let shuttingDown = false;

console.log("[dev] starting AgentRouter API and worker");

start("api", ["api:dev"]);
start("worker", ["worker:dev"]);

process.on("SIGINT", () => shutdown("received SIGINT"));
process.on("SIGTERM", () => shutdown("received SIGTERM"));

function start(label, args) {
  const child = spawn(pnpmBin, args, {
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"]
  });

  children.add(child);
  pipeLines(label, child.stdout);
  pipeLines(label, child.stderr);

  child.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`[dev] ${label} failed to start: ${error.message}`);
    shutdown("child failed to start");
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[dev] ${label} exited with ${reason}; stopping remaining processes`);
    process.exitCode = code ?? 1;
    shutdown(`${label} exited with ${reason}`);
  });
}

function pipeLines(label, stream) {
  const reader = createInterface({ input: stream });
  reader.on("line", (line) => {
    console.log(`[${label}] ${line}`);
  });
}

function shutdown(reason = "shutdown requested") {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[dev] shutting down: ${reason}`);

  for (const child of children) {
    child.kill("SIGTERM");
  }

  const forceKill = setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
  }, 5000);
  forceKill.unref();
}

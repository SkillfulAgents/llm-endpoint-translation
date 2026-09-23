// Idle footprint of the library in a fresh Node process: RSS/heap after GC, with and without importing it.
// Run as: node --expose-gc bench/idle.mjs [bare|http|http+library]

import { createServer } from "node:http";

const variant = process.argv[2] ?? "bare";
const started = process.hrtime.bigint();
if (variant !== "bare") createServer().listen(0);
if (variant === "http+library") await import("../dist/index.js");
const loadMs = Number(process.hrtime.bigint() - started) / 1e6;

const cpuBefore = process.cpuUsage();
await new Promise((resolve) => setTimeout(resolve, Number(process.env.IDLE_S ?? 10) * 1000));
globalThis.gc?.();
const cpu = process.cpuUsage(cpuBefore);
const { rss, heapUsed } = process.memoryUsage();
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
console.log(
  JSON.stringify({ variant, rssMb: mb(rss), heapUsedMb: mb(heapUsed), loadMs: Math.round(loadMs), idleCpuMs: Math.round((cpu.user + cpu.system) / 1000) }),
);
process.exit(0);

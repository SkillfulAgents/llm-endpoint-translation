// Holds CONCURRENCY streaming /v1/messages requests against the proxy for DURATION_S, sampling its /__stats.
// Prints one JSON line: proxy RSS/heap peaks, proxy CPU %, streams completed, events/s.

const PROXY = process.env.PROXY_URL ?? "http://127.0.0.1:8787";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 1);
const DURATION_S = Number(process.env.DURATION_S ?? 30);

const REQUEST = JSON.stringify({
  model: "claude-bench",
  max_tokens: 4096,
  stream: true,
  messages: [{ role: "user", content: "bench" }],
  tools: [{ name: "save_note", description: "Save a note", input_schema: { type: "object", properties: { text: { type: "string" } } } }],
});

const stats = async () => (await fetch(`${PROXY}/__stats`)).json();

let completed = 0;
let failed = 0;
let events = 0;
const deadline = Date.now() + DURATION_S * 1000;

async function worker() {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${PROXY}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: REQUEST,
      });
      const text = await res.text();
      if (!res.ok || !text.includes("message_stop")) throw new Error(`bad stream ${res.status}`);
      events += text.split("\n\n").length - 1;
      completed++;
    } catch {
      failed++;
    }
  }
}

const before = await stats();
const started = process.hrtime.bigint();
let peakRss = before.memory.rss;
let peakHeap = before.memory.heapUsed;
const sampler = setInterval(async () => {
  const s = await stats();
  peakRss = Math.max(peakRss, s.memory.rss);
  peakHeap = Math.max(peakHeap, s.memory.heapUsed);
}, 250);

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
clearInterval(sampler);
const after = await stats();
const wallUs = Number(process.hrtime.bigint() - started) / 1000;
const cpuUs = after.cpu.user + after.cpu.system - (before.cpu.user + before.cpu.system);

const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
console.log(
  JSON.stringify({
    backend: process.env.BACKEND,
    concurrency: CONCURRENCY,
    durationS: DURATION_S,
    completed,
    failed,
    eventsPerS: Math.round(events / (wallUs / 1e6)),
    idleRssMb: mb(before.memory.rss),
    peakRssMb: mb(peakRss),
    peakHeapMb: mb(peakHeap),
    cpuPct: Math.round((cpuUs / wallUs) * 1000) / 10,
    cpuMsPerStream: completed ? Math.round(cpuUs / 1000 / completed) : null,
  }),
);

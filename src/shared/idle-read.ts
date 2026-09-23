// Max silence between upstream SSE events before the stream is declared stalled.
// 5 min: observed xAI stalls exceeded 3 min with the connection held open.
export const STREAM_IDLE_TIMEOUT_MS = 300_000;

export async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<Awaited<ReturnType<typeof reader.read>> | "idle_timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = reader.read();
  // The losing read() settles later (e.g. rejects after cancel) — keep it observed.
  read.catch(() => {});
  try {
    return await Promise.race([
      read,
      new Promise<"idle_timeout">((resolve) => {
        timer = setTimeout(() => resolve("idle_timeout"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

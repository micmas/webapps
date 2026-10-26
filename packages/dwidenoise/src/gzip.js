// Gzip of the output file in a worker that loads no WebAssembly, so the web page's thread stays
// free and a cancel stops the compression.
// The worker's messages: in { type: "gzip", buffer } (the buffer is transferred), out { data }
// (the gzip bytes, transferred) or { error }.
const GZIP_SLICE = 1 << 24;

/** Compresses `buffer` from 16 MB slices of it, so no second uncompressed copy is made. */
export async function gzipBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  const source = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const end = Math.min(offset + GZIP_SLICE, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  return new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

/**
 * The gzip worker's message handler.
 * @param post posts one message (and its transfer list) to the caller
 */
export function gzipWorkerHandler(post) {
  return async (message) => {
    try {
      const data = await gzipBuffer(message.buffer);
      post({ data }, [data]);
    } catch (error) {
      post({ error: error?.message ?? String(error) });
    }
  };
}

/**
 * Gzips `buffer` in a new worker from `spawn` (one running gzipWorkerHandler, with the Web Worker
 * interface the pool uses) and returns the compressed bytes. The buffer is moved to the worker,
 * not copied, so it is detached here afterwards. A cancel stops the worker.
 */
export function gzipInWorker(buffer, { signal, spawn }) {
  const worker = spawn();
  return new Promise((resolve, reject) => {
    const finish = (error, data) => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(data);
    };
    const abort = () => finish(signal.reason ?? new DOMException("Denoising cancelled", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "The compression worker failed."));
    worker.onmessage = ({ data: message }) => finish(message.error ? new Error(message.error) : null, message.data);
    worker.postMessage({ type: "gzip", buffer }, [buffer]);
  });
}

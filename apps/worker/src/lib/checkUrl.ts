const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000; // cap so a huge/streaming response can't hang the worker

/** Result of a single URL health check. `error` is non-null only for
 * network-level failures (DNS, connection refused, timeout) — a
 * well-formed HTTP response of any status code, including 4xx/5xx,
 * produces `error: null` with `httpStatus` set. */
export interface CheckResult {
  httpStatus: number | null;
  responseMs: number;
  pageTitle: string | null;
  error: string | null;
}

/** Performs one URL health check: follows redirects, records the final
 * response's status code and timing, and — for HTML responses — streams
 * up to `MAX_BODY_BYTES` looking for a `<title>` tag, stopping as soon as
 * one is found so a large page doesn't have to be fully buffered.
 * Network/timeout errors are caught and returned as `error` (transient,
 * meant to trigger the caller's BullMQ retry+backoff) rather than thrown;
 * a non-2xx/3xx HTTP response is NOT an error at this layer — it's a
 * valid, final result the caller should record as `succeeded`. */
export async function checkUrl(url: string): Promise<CheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "bulk-url-health-checker/1.0" },
    });

    const responseMs = Date.now() - start;
    const contentType = res.headers.get("content-type") ?? "";

    let pageTitle: string | null = null;
    if (contentType.includes("text/html") && res.body) {
      const reader = res.body.getReader();
      let received = 0;
      let html = "";
      const decoder = new TextDecoder();
      while (received < MAX_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        html += decoder.decode(value, { stream: true });
        const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (match) {
          pageTitle = match[1].trim();
          break;
        }
      }
      await reader.cancel().catch(() => {});
    }

    return { httpStatus: res.status, responseMs, pageTitle, error: null };
  } catch (err: any) {
    const responseMs = Date.now() - start;
    const message = err?.name === "AbortError" ? "Request timed out" : err?.message ?? "Request failed";
    return { httpStatus: null, responseMs, pageTitle: null, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

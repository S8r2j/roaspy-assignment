/** Hard cap on URLs accepted per batch submission. A submission over this
 * limit is rejected outright (400) rather than silently truncated. */
export const MAX_URLS_PER_BATCH = 2000;

// Hostnames/IP ranges that must never be fetched server-side: loopback,
// link-local (includes cloud metadata endpoints like 169.254.169.254),
// private RFC1918 ranges, and *.local. This is a best-effort literal check
// at submission time, not a full SSRF defense (it doesn't resolve DNS, so a
// public hostname that resolves to a private IP at request time isn't
// caught here — the worker's HTTP client would still need its own
// redirect/DNS-rebind guard for full protection; flagged as a follow-up in
// the README).
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true;
  }
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true; // IPv6 loopback / link-local / unique-local
  }
  return false;
}

/** Parses either newline/comma-separated pasted text or raw CSV content
 * into a deduped, order-preserving list of normalized URLs. CSV is
 * treated as "one URL per line, optionally with other columns" — only the
 * first column on each line is read as the URL. Only http(s) URLs to
 * non-private hosts are accepted; malformed or blocked individual lines
 * are silently dropped rather than rejecting the whole submission, since
 * a bulk paste/CSV commonly has a few bad lines. The returned list is
 * never truncated here — enforcing `MAX_URLS_PER_BATCH` is the caller's
 * job, so an over-limit submission is rejected outright instead of
 * silently processing only the first N URLs. */
export function parseUrlList(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    for (const cell of cells) {
      if (!cell) continue;
      const candidate = /^https?:\/\//i.test(cell) ? cell : `https://${cell}`;
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") break;
        if (isBlockedHost(parsed.hostname)) break;
        const normalized = parsed.toString();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          urls.push(normalized);
        }
      } catch {
        // not a valid URL, skip
      }
      break; // only take the first cell per line (URL column)
    }
  }

  return urls;
}

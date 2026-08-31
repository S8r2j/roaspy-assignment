import type { BatchStatus, UrlCheckStatus } from "@roaspy/shared";

type Status = BatchStatus | UrlCheckStatus;

// Pairs color with a symbol + text label so status is never conveyed by
// color alone (accessibility: color-blind / low-vision users, screen readers).
const STATUS_META: Record<Status, { label: string; symbol: string }> = {
  pending: { label: "Pending", symbol: "○" }, // ○
  queued: { label: "Queued", symbol: "○" }, // ○
  running: { label: "Running", symbol: "●" }, // ● (animated via CSS class)
  succeeded: { label: "Succeeded", symbol: "✓" }, // ✓
  done: { label: "Done", symbol: "✓" }, // ✓
  failed: { label: "Failed", symbol: "✕" }, // ✕
  cancelled: { label: "Cancelled", symbol: "⊘" }, // ⊘ (stopped/prohibited, clearer than a plain dash)
};

/** Renders a batch or URL-check status as a colored pill pairing a symbol
 * with a text label — status is never conveyed by color alone, for
 * color-blind/low-vision users and screen readers. Accepts either a
 * `BatchStatus` or `UrlCheckStatus` value, plus the display-only
 * `"queued"` override some callers pass for a `running` batch that
 * hasn't actually started yet (see README). */
export function StatusBadge({ status }: { status: Status }) {
  const meta = STATUS_META[status] ?? { label: status, symbol: "?" };
  return (
    <span className={`badge badge-${status}`}>
      <span aria-hidden="true">{meta.symbol}</span>
      {meta.label}
    </span>
  );
}

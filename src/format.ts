// Small formatting helpers shared by the extension, the terminal chat and the
// webview. Pure, and no Node imports (the webview bundle uses it too).

/** The message of an error or a thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How long a tool ran: "4.2s", or "2m 5s" from a minute up. */
export function formatElapsed(ms: number): string {
  return ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** "2s", "15m 30s", "1h 5m": a reply's duration in the terminal footer. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

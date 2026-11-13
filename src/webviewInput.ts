// Validation of what the chat webview posts to the extension. The webview is
// treated as untrusted. Pure (no vscode import).

import type { PromptImage } from "./types";

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 10;
/** Longest typed answer to the agent's question. */
export const MAX_ANSWER = 4000;

/** Longest message typed while the agent works. */
export const MAX_STEER = 20000;

/** A message typed while the agent works; undefined = nothing to send. */
export function cleanSteer(raw: unknown): string | undefined {
  const text = typeof raw === "string" ? raw.trim().slice(0, MAX_STEER) : "";
  return text || undefined;
}

/** An answer from the webview to the agent's question; undefined = skipped. */
export function cleanAnswer(raw: unknown): string | undefined {
  const text = typeof raw === "string" ? raw.trim().slice(0, MAX_ANSWER) : "";
  return text || undefined;
}

/** Validate image attachments posted by the webview before forwarding them. */
export function sanitizeImages(raw: unknown): PromptImage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PromptImage[] = [];
  for (const item of raw.slice(0, MAX_IMAGES)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const r = item as Record<string, unknown>;
    const mimeType = String(r.mimeType ?? "");
    const data = typeof r.data === "string" ? r.data : "";
    if (!ALLOWED_IMAGE_TYPES.has(mimeType) || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      continue;
    }
    // Base64 expands by 4/3; reject oversized payloads.
    if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) {
      continue;
    }
    out.push({ mimeType, data, name: r.name ? String(r.name).slice(0, 200) : undefined });
  }
  return out;
}

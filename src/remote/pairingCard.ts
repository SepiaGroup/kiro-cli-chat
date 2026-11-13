// The HTML of the remote access card shown in VS Code: the QR code for the
// pairing link, the link itself and the buttons. Pure (no vscode import).
// The page's script only posts button names; the link never goes back from the
// page to the extension. The CSP allows no inline styles except this page's own
// <style> (by nonce) and no scripts except the one below.

import { randomBytes } from "crypto";

export interface PairingCardOptions {
  /** The pairing link. */
  link: string;
  /** The QR code as SVG (made from `link`); left out when the link only works on this Mac. */
  qrSvg?: string;
  /** Why the link only works on this Mac, and what to do. Set when there is no tailnet address. */
  problem?: { advice: string; canOpenSetup: boolean };
  /** When the link stops working, as the user's clock shows it. */
  expiresAt: string;
  nonce?: string;
}

/** The button names the page may post. */
export type CardAction = "copy" | "open" | "newLink" | "setup" | "retry";
export const CARD_ACTIONS: readonly CardAction[] = ["copy", "open", "newLink", "setup", "retry"];

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function pairingCardHtml(o: PairingCardOptions): string {
  const nonce = o.nonce ?? randomBytes(18).toString("base64url");
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
  const intro = o.problem
    ? `<p class="warn" role="status">Remote access is on for this Mac only. ${esc(o.problem.advice)}</p>`
    : `<p>Point your phone's camera at the code, or send yourself the link. Your phone needs Tailscale on.</p>`;
  const qr = o.qrSvg ? `<div class="qr">${o.qrSvg}</div>` : "";
  const setup = o.problem?.canOpenSetup ? `<button data-action="setup">Open Tailscale Setup</button>` : "";
  const retry = o.problem ? `<button data-action="retry">Try Again</button>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Kiro Remote Access</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 24px; max-width: 42em; line-height: 1.5; }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 8px; }
  .warn { border-left: 3px solid var(--vscode-editorWarning-foreground); padding: 4px 12px; }
  .qr { display: inline-block; margin: 8px 0; padding: 0; border-radius: 6px; overflow: hidden; line-height: 0; }
  code { display: block; word-break: break-all; user-select: all; padding: 8px 10px; margin: 8px 0; background: var(--vscode-textCodeBlock-background); border-radius: 4px; font-family: var(--vscode-editor-font-family); }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
  button { font: inherit; padding: 6px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .note { opacity: 0.8; }
</style>
</head>
<body>
<h1>Remote access</h1>
${intro}
${qr}
<code id="link" aria-label="Pairing link">${esc(o.link)}</code>
<div class="buttons">
  <button class="primary" data-action="copy">Copy Link</button>
  <button data-action="open">Open in Browser</button>
  <button data-action="newLink">New Link</button>
  ${setup}
  ${retry}
</div>
<p class="note">The link works once, until ${esc(o.expiresAt)}. A device you pair stays paired until you remove it (Kiro CLI Chat: Remove Remote Device…).</p>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-action]");
    if (b) { vscode.postMessage({ action: b.dataset.action }); }
  });
</script>
</body>
</html>`;
}

/** The action in a message from the card, or undefined for anything else. */
export function cardAction(msg: unknown): CardAction | undefined {
  const a = (msg as { action?: unknown } | null)?.action;
  return typeof a === "string" && (CARD_ACTIONS as readonly string[]).includes(a) ? (a as CardAction) : undefined;
}

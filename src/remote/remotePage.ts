// The HTML a browser gets from remote access: the chat page (the same markup
// the VS Code webview uses) with the shim that stands in for VS Code's
// webview API loaded first. Pure (no vscode import).

import { webviewHtml } from "../webviewHtml";

/** Paths the page loads from the server (see remoteServer's `assets`). */
export const REMOTE_ASSETS = {
  shim: "/static/remoteShim.js",
  script: "/static/webview.js",
  style: "/static/webview.css",
  remoteStyle: "/static/remote.css",
  manifest: "/static/manifest.webmanifest",
} as const;

/** The page, with a fresh script nonce. Everything it loads is from its own origin. */
export function remotePageHtml(): string {
  return webviewHtml({
    scriptUri: REMOTE_ASSETS.script,
    styleUri: REMOTE_ASSETS.style,
    cspSource: "'self'",
    connectSrc: "'self'",
    manifestUri: REMOTE_ASSETS.manifest,
    preScriptUris: [REMOTE_ASSETS.shim],
    extraStyleUris: [REMOTE_ASSETS.remoteStyle],
  });
}

/** Headers for every response that cannot go in the page's meta tag. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

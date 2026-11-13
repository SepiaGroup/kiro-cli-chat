// The chat webview's HTML page (the same for every chat). Pure (no vscode
// import): the caller passes the webview URIs and CSP source.

import { randomBytes } from "crypto";

export interface WebviewHtmlOptions {
  /** `webview.asWebviewUri(...)` of media/webview.js and media/webview.css. */
  scriptUri: string;
  styleUri: string;
  /** `webview.cspSource`. */
  cspSource: string;
  /** Script nonce; a fresh random one by default. */
  nonce?: string;
}

/** A random nonce for the script tag. */
export function makeNonce(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * The page. The CSP allows only the extension's own script (by nonce),
 * stylesheet and images: no inline styles or scripts.
 */
export function webviewHtml(opts: WebviewHtmlOptions): string {
  const { scriptUri, styleUri, cspSource } = opts;
  const nonce = opts.nonce ?? makeNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} data:`,
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>Kiro CLI Chat</title>
</head>
<body>
<div id="app">
<div id="toolbar">
  <select id="sel-model" class="toolbar-model" title="Model" aria-label="Model" disabled>
    <option>Auto</option>
  </select>
  <button id="ctx-meter" class="ctx-meter hidden" aria-describedby="ctx-card" aria-label="Context usage">
    <svg class="ctx-ring" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle class="ctx-ring-bg" cx="10" cy="10" r="8" />
      <circle id="ctx-ring-fg" class="ctx-ring-fg" cx="10" cy="10" r="8" />
    </svg>
    <span id="ctx-text" class="ctx-text"></span>
  </button>
  <div id="ctx-card" class="ctx-card hidden" role="tooltip"></div>
  <span id="status">Starting…</span>
  <span id="spacer"></span>
  <select id="sel-mode" class="toolbar-model toolbar-mode" title="Agent mode" aria-label="Agent mode" disabled>
    <option>Default</option>
  </select>
  <button id="btn-resume" title="Resume previous session">Resume</button>
  <button id="btn-restart" title="Restart engine">Restart</button>
  <button id="btn-new-tab" title="New chat tab" aria-label="New chat tab">＋</button>
  <button id="btn-settings" title="Settings">⚙</button>
</div>
<div id="resume-panel" class="resume-panel hidden">
  <div id="resume-header" class="resume-header">
    <span>Previous sessions</span>
    <button id="resume-close" class="resume-close" title="Close" aria-label="Close previous sessions">✕</button>
  </div>
  <div id="resume-list" class="resume-list"></div>
</div>
<div id="settings" class="settings hidden">
  <div class="panel-header settings-header">
    <span>Settings</span>
    <button id="settings-close" class="resume-close" title="Close" aria-label="Close settings">✕</button>
  </div>
  <div class="settings-row hidden" id="effort-row">
    <label for="sel-effort">Effort</label>
    <select id="sel-effort"></select>
  </div>
  <div class="settings-row">
    <label for="chk-autopilot">Autopilot</label>
    <input type="checkbox" id="chk-autopilot" />
  </div>
  <div class="settings-note">Autopilot auto-approves tool actions. Off = Supervised (approve each change).</div>
  <div class="settings-row">
    <label for="sel-memory">Memory reflection</label>
    <select id="sel-memory"></select>
  </div>
  <div class="settings-note">Lets the session learn and store new long-term memories.</div>
  <div class="settings-row">
    <label for="sel-content">Content collection</label>
    <select id="sel-content"></select>
  </div>
  <div class="settings-note">Whether your content may be used for service improvement.</div>
</div>
<div id="messages"></div>
<div id="composer">
  <div id="cmd-picker" class="cmd-picker hidden" role="listbox" aria-label="Slash commands"></div>
  <div id="cmd-hint" class="cmd-hint hidden"></div>
  <div id="attachments" class="attachments hidden" aria-label="Attached images"></div>
  <textarea id="input" rows="1" placeholder="Ask Kiro something…  (/ for commands)" aria-label="Message"></textarea>
  <button id="btn-send" title="Send (Enter)" aria-label="Send">
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>
  </button>
</div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

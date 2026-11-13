// The files remote access serves from media/, and their content types.
// A fixed list: nothing else in the folder is reachable. Pure (no vscode import).

export const ASSET_NAMES: ReadonlySet<string> = new Set([
  "webview.js",
  "webview.css",
  "remoteShim.js",
  "remote.css",
  "manifest.webmanifest",
  "icon.png",
  "icon@2x.png",
  "icon.svg",
]);

const TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
};

/** The content type for a servable file name; undefined for anything not on the list. */
export function assetType(name: string): string | undefined {
  if (!ASSET_NAMES.has(name)) {
    return undefined;
  }
  return TYPES[name.slice(name.lastIndexOf(".") + 1)];
}

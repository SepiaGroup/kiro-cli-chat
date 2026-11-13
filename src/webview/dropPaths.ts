// Reading file paths and images out of a drag-and-drop, for the chat webview.
// Pure (no DOM types), so it can be unit-tested in Node.

/** The parts of a DataTransfer this module reads. */
export interface DropData {
  getData(format: string): string;
  readonly types: readonly string[];
  readonly files: ArrayLike<{ name: string; type: string; size: number; path?: string }>;
}

/** Convert a dropped URI/path string to a plain filesystem path. */
export function uriToPath(raw: string): string | undefined {
  const t = raw.trim();
  if (!t || t.startsWith("#")) {
    return undefined;
  }
  if (/^file:\/\//i.test(t)) {
    try {
      return decodeURIComponent(t.replace(/^file:\/\//i, ""));
    } catch {
      return t.replace(/^file:\/\//i, "");
    }
  }
  // Non-file schemes (http, vscode-remote, …) are not local paths.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    return undefined;
  }
  return t;
}

/** Collect local file paths from every drag format VS Code / the OS may use. */
export function pathsFromDrop(dt: DropData): string[] {
  const out: string[] = [];
  const add = (p: string | undefined): void => {
    if (p && !out.includes(p)) {
      out.push(p);
    }
  };
  // VS Code Explorer drags: JSON array of URI strings.
  const resourceUrls = dt.getData("resourceurls");
  if (resourceUrls) {
    try {
      const arr = JSON.parse(resourceUrls) as unknown;
      if (Array.isArray(arr)) {
        for (const u of arr) {
          add(uriToPath(String(u)));
        }
      }
    } catch {
      /* ignore malformed payload */
    }
  }
  // Standard URI list.
  for (const line of dt.getData("text/uri-list").split("\n")) {
    add(uriToPath(line));
  }
  // OS file drops (Electron exposes File.path).
  for (let i = 0; i < dt.files.length; i++) {
    add(dt.files[i].path);
  }
  // Plain text fallback (only if it looks like an absolute path).
  if (out.length === 0) {
    const text = dt.getData("text/plain").trim();
    if (text.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(text)) {
      add(text);
    }
  }
  return out;
}

/** Quote a path if it contains whitespace so the agent reads it as one token. */
export function formatPath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** MIME type for an image file, falling back to its extension (Finder drops can omit type). */
export function imageMime(name: string, type: string): string | undefined {
  if (type.startsWith("image/")) {
    return type;
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXT_MIME[ext];
}

export const isImagePath = (p: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(p);

/** Describe a drop for the Output channel, so failures can be diagnosed. */
export function describeDrop(dt: DropData): string {
  const files: string[] = [];
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files[i];
    files.push(`${f.name}|${f.type || "?"}|${f.size}`);
  }
  const uri = dt.getData("text/uri-list").slice(0, 300);
  return `types=[${Array.from(dt.types).join(", ")}] files=[${files.join("; ")}] uri-list=${JSON.stringify(uri)}`;
}

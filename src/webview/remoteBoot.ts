// The decisions of the remote page's start-up (pairing link, which chat to
// open, what to tell the user), kept apart from the DOM code so they can be
// tested. Pure.

export interface ChatInfo {
  id: string;
  title: string;
  busy: boolean;
}

/** The pairing secret in a URL fragment like `#k=...`; undefined if there is none. */
export function fragmentSecret(hash: string): string | undefined {
  const m = /^#(?:[^&]*&)*k=([A-Za-z0-9_-]{16,200})(?:&.*)?$/.exec(hash);
  return m ? m[1] : undefined;
}

/** The chat list from the server, keeping only well-formed entries. */
export function parseChatList(raw: unknown): ChatInfo[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ChatInfo[] = [];
  for (const item of raw) {
    const c = item as { id?: unknown; title?: unknown; busy?: unknown } | null;
    if (c && typeof c.id === "string" && c.id && typeof c.title === "string") {
      out.push({ id: c.id, title: c.title.slice(0, 80), busy: c.busy === true });
    }
  }
  return out;
}

/** The chat to open straight away: the one used last time, or the only one. Undefined = let the user pick. */
export function pickChat(chats: readonly ChatInfo[], saved: string | null | undefined): string | undefined {
  if (saved && chats.some((c) => c.id === saved)) {
    return saved;
  }
  return chats.length === 1 ? chats[0].id : undefined;
}

export type GateKind = "badLink" | "unpaired" | "noChats" | "pick" | "gone" | "removed" | "denied" | "offline";

/** What the start-up screen says. Short sentences that say what to do next. */
export const GATE_TEXT: Record<GateKind, string> = {
  badLink: "This pairing link is not valid any more. In VS Code run \"Kiro CLI Chat: Show Remote Access Link\" and open the new link.",
  unpaired: "This device is not paired. In VS Code run \"Kiro CLI Chat: Show Remote Access Link\" and open that link here.",
  noChats: "No chat is open in VS Code. Open one there, then reload this page.",
  pick: "Choose a chat",
  gone: "That chat was closed in VS Code. Choose another.",
  removed: "This device was removed in VS Code. Run \"Kiro CLI Chat: Show Remote Access Link\" to pair it again.",
  denied: "This device may not view chats. Change kiroCliChat.remote.permissions in VS Code.",
  offline: "Cannot reach VS Code. Check that Tailscale is on and that remote access is running, then reload.",
};

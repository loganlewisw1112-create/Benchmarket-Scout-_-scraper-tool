// Client-side helpers for the optional access-key gate. Beta users paste a
// shared code once; it is kept in localStorage and attached to API calls as
// the `x-scout-key` header. Low-sensitivity by design (it only gates a free
// tool), and all access is guarded for non-browser / disabled-storage cases.
//
// Exposed as an external store so components can read it via
// useSyncExternalStore (SSR-safe, no setState-in-effect).

const STORAGE_KEY = "scout_access_key";
const CHANGE_EVENT = "scout-key-change";

export function getAccessKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAccessKey(value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage disabled; the key simply won't persist across reloads.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeAccessKey(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function jsonHeaders(): Record<string, string> {
  const key = getAccessKey();
  return {
    "Content-Type": "application/json",
    ...(key ? { "x-scout-key": key } : {}),
  };
}

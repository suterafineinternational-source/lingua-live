export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Request failed (${response.status}).`);
    error.code = payload.error?.code;
    error.retriable = payload.error?.retriable;
    throw error;
  }
  return payload;
}
export function clientId(storageKey) {
  let id = localStorage.getItem(storageKey);
  if (!id) {
    id = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(storageKey, id);
  }
  return id;
}

export function webSocketUrl(params) {
  const url = new URL("/ws", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

export function reconnectDelay(attempt) {
  const base = Math.min(500 * 2 ** attempt, 10_000);
  return base + Math.floor(Math.random() * Math.min(500, base / 4));
}

export function setText(element, value) {
  if (element) element.textContent = value;
}

const translated = document.querySelector("#translated-transcript");
const source = document.querySelector("#source-transcript");
const service = document.querySelector("#service-status");

function ensureDraft(container, kind) {
  if (!container) return null;
  const selector = `[data-live-${kind}-draft]`;
  let node = container.querySelector(selector);
  if (!node) {
    const placeholder = container.querySelector(".meta");
    if (placeholder) placeholder.remove();
    node = document.createElement("p");
    node.className = "transcript-line";
    node.dataset[`live${kind[0].toUpperCase()}${kind.slice(1)}Draft`] = "true";
    container.append(node);
  }
  return node;
}

function updateDraft(container, kind, text) {
  const value = String(text || "").trim();
  if (!value) return;
  const node = ensureDraft(container, kind);
  if (!node) return;
  node.textContent = value.slice(-1600);
  container.scrollTop = container.scrollHeight;
}

if (service) {
  const render = () => {
    const value = service.textContent || "";
    if (value.startsWith("TRANSLATING:")) updateDraft(translated, "translation", value.slice("TRANSLATING:".length));
    if (value.startsWith("HEARD:")) updateDraft(source, "source", value.slice("HEARD:".length));
  };
  new MutationObserver(render).observe(service, { childList: true, characterData: true, subtree: true });
  render();
}

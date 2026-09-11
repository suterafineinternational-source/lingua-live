const PROVIDERS = [
  {
    id: "browser-capture",
    name: "Browser tab / system audio",
    category: "universal",
    status: "available",
    requiresCredentials: false,
    description: "Capture meeting/webinar audio through the browser's supported display-capture APIs.",
  },
  {
    id: "zoom",
    name: "Zoom",
    category: "meeting-provider",
    status: "requires-provider-setup",
    requiresCredentials: true,
    description: "Reserved for an official Zoom app/bot integration configured with provider credentials.",
  },
  {
    id: "microsoft-teams",
    name: "Microsoft Teams",
    category: "meeting-provider",
    status: "requires-provider-setup",
    requiresCredentials: true,
    description: "Reserved for an official Microsoft Teams integration configured with provider credentials.",
  },
  {
    id: "google-meet",
    name: "Google Meet",
    category: "meeting-provider",
    status: "requires-provider-setup",
    requiresCredentials: true,
    description: "Reserved for an official Google Meet integration configured with provider credentials.",
  },
  {
    id: "webex",
    name: "Webex",
    category: "meeting-provider",
    status: "requires-provider-setup",
    requiresCredentials: true,
    description: "Reserved for an official Webex integration configured with provider credentials.",
  },
];

export function integrationCapabilities() {
  return PROVIDERS.map((provider) => ({ ...provider }));
}

export function createIntegrationRegistry(adapters = {}) {
  const registered = new Map(Object.entries(adapters));
  return {
    capabilities() {
      return PROVIDERS.map((provider) => ({
        ...provider,
        status: registered.has(provider.id) ? "configured" : provider.status,
      }));
    },
    get(id) {
      return registered.get(id) || null;
    },
    register(id, adapter) {
      if (!PROVIDERS.some((provider) => provider.id === id)) throw new Error(`Unknown integration provider: ${id}`);
      if (!adapter || typeof adapter.start !== "function" || typeof adapter.stop !== "function") {
        throw new TypeError("Integration adapters must implement start(context) and stop(context).");
      }
      registered.set(id, adapter);
      return adapter;
    },
  };
}

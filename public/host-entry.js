const ua = navigator.userAgent || "";
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let qualityLoaded = false;

if (!isIOS) {
  try {
    await import("/quality-bootstrap.js?v=20260912-2");
    qualityLoaded = true;
  } catch (error) {
    console.warn("Realtime Quality Monitor disabled for browser compatibility:", error?.message || error);
  }
}

try {
  await import("/low-latency-webrtc.js?v=20260912-2");
} catch (error) {
  console.warn("Low-latency WebRTC transport unavailable; server relay fallback remains active:", error?.message || error);
  const transport = document.querySelector("#transport-mode");
  const detail = document.querySelector("#transport-detail");
  if (transport) {
    transport.textContent = "TRANSPORT: SERVER FALLBACK";
    transport.dataset.state = "fallback";
  }
  if (detail) detail.textContent = "The low-latency browser transport could not load; the server relay remains available.";
}

await import("/host.js?v=20260911-4");

if (!qualityLoaded) {
  const verdict = document.querySelector("#quality-verdict");
  const health = document.querySelector("#quality-health");
  const delay = document.querySelector("#current-english-delay");
  const delayDetail = document.querySelector("#english-delay-detail");
  if (verdict) verdict.textContent = isIOS
    ? "Quality stress-test telemetry is disabled on iPhone/iPad to keep the Host console fully compatible. Run the quality test from desktop Chrome."
    : "Quality stress-test telemetry is unavailable in this browser, but interpretation controls remain active.";
  if (health) {
    health.textContent = "MOBILE SAFE";
    health.dataset.state = "warming-up";
  }
  if (delay) {
    delay.textContent = "Current English delay: desktop measurement only";
    delay.dataset.state = "idle";
  }
  if (delayDetail) delayDetail.textContent = "Open the Host console in desktop Chrome to measure live English delay continuously.";
}

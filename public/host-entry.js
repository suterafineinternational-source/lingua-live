const ua = navigator.userAgent || "";
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let qualityLoaded = false;

if (!isIOS) {
  try {
    await import("/quality-bootstrap.js?v=20260911-2");
    qualityLoaded = true;
  } catch (error) {
    console.warn("Realtime Quality Monitor disabled for browser compatibility:", error?.message || error);
  }
}

await import("/host.js?v=20260911-4");

if (!qualityLoaded) {
  const verdict = document.querySelector("#quality-verdict");
  const health = document.querySelector("#quality-health");
  if (verdict) verdict.textContent = isIOS
    ? "Quality stress-test telemetry is disabled on iPhone/iPad to keep the Host console fully compatible. Run the quality test from desktop Chrome."
    : "Quality stress-test telemetry is unavailable in this browser, but interpretation controls remain active.";
  if (health) {
    health.textContent = "MOBILE SAFE";
    health.dataset.state = "warming-up";
  }
}

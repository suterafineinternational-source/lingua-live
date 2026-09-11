const code = new URLSearchParams(location.search).get("room")?.trim().toUpperCase();
const error = document.querySelector("#error");
const player = document.querySelector("#player");
if (!code || !/^[A-Z2-9]{6}$/.test(code)) {
  player.hidden = true;
  error.hidden = false;
  error.textContent = "Add ?room=ROOMCODE to the embed URL.";
} else {
  player.src = `/audience/${encodeURIComponent(code)}`;
}

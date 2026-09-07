/** This isolated preload exposes nothing to either web page. Only the two
 * buttons in the main-owned, escaped confirmation document can send a result. */
const { ipcRenderer } = require("electron") as typeof import("electron");
const identity = process.argv.find((value) => value.startsWith("--planning-review-identity="))?.slice(27);
window.addEventListener("DOMContentLoaded", () => {
  let sent = false;
  function send(action: "confirm" | "cancel"): void {
    if (sent || identity === undefined) return; sent = true;
    ipcRenderer.send("ai-dev-os:native-planning-review-result", { identity, action });
  }
  document.querySelector("#native-confirm")?.addEventListener("click", () => send("confirm"));
  document.querySelector("#native-cancel")?.addEventListener("click", () => send("cancel"));
});
export {};

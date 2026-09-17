// Run before styles paint, without weakening script-src for inline JavaScript.
try {
  document.documentElement.dataset.mode = localStorage.getItem("ytdw-theme") === "dark" ? "dark" : "light";
} catch {
  document.documentElement.dataset.mode = "light";
}
if (location.pathname.startsWith("/s/")) document.documentElement.dataset.view = "shared";

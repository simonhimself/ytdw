// Run before styles paint, without weakening script-src for inline JavaScript.
try {
  document.documentElement.dataset.mode = localStorage.getItem("ytdw-theme") === "dark" ? "dark" : "light";
} catch {
  document.documentElement.dataset.mode = "light";
}
if (location.pathname.startsWith("/s/")) document.documentElement.dataset.view = "shared";
else if (location.pathname === "/library") document.documentElement.dataset.view = "library";
else if (location.pathname === "/verify") document.documentElement.dataset.view = "verify";
else if (location.pathname === "/reset-password") document.documentElement.dataset.view = "reset";
else if (location.pathname === "/account") document.documentElement.dataset.view = "account";

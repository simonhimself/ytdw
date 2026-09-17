(() => {
  const byId = (id) => document.getElementById(id);
  const isSharedView = location.pathname.startsWith("/s/");
  const form = byId("summary-form");
  const input = byId("youtube-url");
  const submitButton = byId("submit-button");
  const status = byId("status");
  const error = byId("error");
  const result = byId("result");
  const themeToggle = byId("theme-toggle");
  const stackDetails = byId("cloudflare-stack");
  const shareButton = byId("share-button");
  const copyButton = byId("copy-button");
  let currentResult = null;
  let phase = "idle";
  let submittedUrl = "";
  let widgetId;
  let verificationTimer;
  let copyInFlight = null;
  let shareInFlight = null;

  function setSubmitState() {
    submitButton.disabled = phase !== "idle" || !input.validity.valid;
    input.readOnly = phase !== "idle";
  }

  function showStatus(title, detail) {
    byId("process-announcement").textContent = `${title} ${detail}`;
    byId("status-title").textContent = title;
    byId("status-detail").textContent = detail;
    status.hidden = false;
  }

  function setPhase(next) {
    phase = next;
    if (next !== "verifying") clearTimeout(verificationTimer);
    form.setAttribute("aria-busy", String(next !== "idle"));
    document.body.classList.toggle("is-busy", next !== "idle");
    submitButton.querySelector(".button-label").textContent = next === "idle" ? "Summarize" : next === "verifying" ? "Verifying" : "Working";
    byId("previous-result-note").hidden = !currentResult || next === "idle";
    if (next === "verifying") showStatus("Verifying…", "Complete the verification if prompted. Your video URL is saved for this request.");
    if (next === "processing") showStatus("Preparing your brief…", "Waiting for a processing slot, reading captions, and creating the summary. This can take a few minutes.");
    if (next === "idle") {
      status.hidden = true;
      byId("process-announcement").textContent = "";
    }
    setSubmitState();
  }

  function showTurnstileError(message) {
    byId("turnstile-error").textContent = message;
    byId("turnstile-error").hidden = !message;
  }

  function failVerification(message) {
    // Expiry callbacks after token consumption must not interrupt generation.
    if (phase !== "verifying") return;
    setPhase("idle");
    showTurnstileError(message);
    if (window.turnstile && widgetId !== undefined) window.turnstile.reset(widgetId);
  }

  async function setupVerification() {
    try {
      const response = await fetch("/api/config", { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("Configuration unavailable");
      const config = await response.json();
      if (typeof config.turnstileSitekey !== "string" || !config.turnstileSitekey) throw new Error("Missing sitekey");
      window.onTurnstileLoad = () => {
        widgetId = window.turnstile.render("#turnstile-widget", {
          sitekey: config.turnstileSitekey,
          action: "summarize",
          execution: "execute",
          appearance: "interaction-only",
          callback(token) {
            if (phase !== "verifying") return;
            showTurnstileError("");
            void runSummary(submittedUrl, token);
          },
          "expired-callback": () => failVerification("Verification expired. Please try again."),
          "timeout-callback": () => failVerification("Verification timed out. Please try again."),
          "error-callback": () => {
            const message = "Verification could not load. Check your connection, allow challenges.cloudflare.com, and retry.";
            if (phase === "verifying") failVerification(message);
            else if (phase === "idle") showTurnstileError(message);
          }
        });
        showTurnstileError("");
      };
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit";
      script.onerror = () => showTurnstileError("Verification is blocked. Allow challenges.cloudflare.com and reload.");
      document.head.append(script);
      window.setTimeout(() => {
        if (widgetId === undefined) showTurnstileError("Verification is unavailable. Check your connection and reload.");
      }, 10_000);
    } catch {
      showTurnstileError("Verification could not load. Check your connection and reload.");
    }
  }

  function setTheme(mode) {
    document.documentElement.dataset.mode = mode;
    themeToggle.setAttribute("aria-pressed", String(mode === "dark"));
    themeToggle.setAttribute("aria-label", `Switch to ${mode === "dark" ? "light" : "dark"} mode`);
  }
  setTheme(document.documentElement.dataset.mode === "dark" ? "dark" : "light");
  themeToggle.addEventListener("click", () => {
    const mode = document.documentElement.dataset.mode === "dark" ? "light" : "dark";
    setTheme(mode);
    try { localStorage.setItem("ytdw-theme", mode); } catch {}
  });
  document.addEventListener("click", (event) => {
    if (stackDetails.open && !stackDetails.contains(event.target)) stackDetails.open = false;
  });
  stackDetails.addEventListener("mouseenter", () => { stackDetails.open = true; });
  stackDetails.addEventListener("mouseleave", () => {
    if (!stackDetails.matches(":focus-within")) stackDetails.open = false;
  });
  stackDetails.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      stackDetails.open = false;
      stackDetails.querySelector("summary").focus();
    }
  });

  function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${minutes % 60}m` : `${minutes} min`;
  }

  function appendInlineText(element, text) {
    for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
      if (part.startsWith("**") && part.endsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = part.slice(2, -2);
        element.append(strong);
      } else element.append(document.createTextNode(part));
    }
  }

  function appendPointText(element, text) {
    if (/^\*\*[^*]+\*\*/.test(text)) return appendInlineText(element, text);
    const separator = text.search(/[:,;](?:\s|$)/);
    const words = text.split(/\s+/);
    const fallbackEnd = words.slice(0, Math.min(8, words.length)).join(" ").length;
    const leadEnd = separator >= 12 && separator <= 180 ? separator : fallbackEnd;
    const strong = document.createElement("strong");
    strong.textContent = `${text.slice(0, leadEnd).replace(/[.:;]+$/, "")}:`;
    element.append(strong);
    const detail = text.slice(leadEnd).replace(/^[:,;]?\s*/, "");
    if (detail) element.append(document.createTextNode(` ${detail}`));
  }

  function renderSummary(markdown) {
    const container = document.createDocumentFragment();
    let list = null;
    let nextIndex = 1;
    for (const rawLine of markdown.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      const topic = line.match(/^\*\*(.+?)\*\*:?$/);
      const numberedItem = line.match(/^(\d+)[.)]\s+(.+)$/);
      const bulletItem = line.match(/^[-*•]\s+(.+)$/);
      let element;
      if (heading) {
        list = null;
        element = document.createElement(heading[1].length >= 3 ? "h4" : "h3");
        appendInlineText(element, /^overview$/i.test(heading[2]) ? "Summary" : heading[2]);
      } else if (topic) {
        list = null;
        element = document.createElement("h4");
        appendInlineText(element, topic[1].replace(/:$/, ""));
      } else if (numberedItem || bulletItem) {
        if (!list) {
          list = document.createElement("ol");
          container.append(list);
        }
        element = document.createElement("li");
        const index = numberedItem ? Number(numberedItem[1]) : nextIndex;
        element.value = index;
        element.dataset.index = String(index).padStart(2, "0");
        appendPointText(element, numberedItem ? numberedItem[2] : bulletItem[1]);
        list.append(element);
        nextIndex = index + 1;
        continue;
      } else {
        list = null;
        element = document.createElement("p");
        appendInlineText(element, line);
      }
      container.append(element);
    }
    return container;
  }

  function actionStatus(id, text, visible = false) {
    const element = byId(id);
    element.classList.toggle("sr-only", !visible);
    element.textContent = text;
  }

  function showResult(data) {
    // Validate and build the replacement before changing the previous brief.
    if (!data || !/^[A-Za-z0-9_-]{11}$/.test(data.id) || typeof data.title !== "string" ||
        !Number.isFinite(data.duration) || data.duration < 0 || typeof data.summary !== "string" || !data.summary.trim() ||
        (data.share !== null && (!data.share || !/^\/s\/[0-9a-f-]{36}$/.test(data.share.url) ||
          !Number.isFinite(data.share.expiresAt) || !Number.isFinite(new Date(data.share.expiresAt).getTime())))) {
      throw new Error("The service returned an incomplete brief. Please try again.");
    }
    const summaryContent = renderSummary(data.summary);
    const expiryText = data.share
      ? `Share link available until ${new Date(data.share.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. Anyone with the link can read and forward it.`
      : "Sharing is temporarily unavailable. You can still copy this brief.";
    currentResult = data;
    byId("result-channel").textContent = data.uploader || "YouTube";
    byId("result-title").textContent = data.title;
    byId("result-duration").textContent = formatDuration(data.duration);
    const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(data.id)}`;
    byId("video-link").href = videoUrl;
    byId("regenerate-link").href = `/?url=${encodeURIComponent(videoUrl)}`;
    byId("regenerate-link").hidden = true;
    byId("transcript-note").textContent = data.transcriptTruncated ? "Long transcript condensed" : "Full transcript processed";
    shareButton.disabled = !data.share;
    copyButton.disabled = false;
    shareButton.setAttribute("aria-disabled", String(!data.share));
    copyButton.setAttribute("aria-disabled", "false");
    actionStatus("copy-status", "");
    actionStatus("share-status", "");
    byId("copy-fallback").hidden = true;
    byId("share-fallback").hidden = true;
    byId("previous-result-note").hidden = true;
    byId("share-expiry").hidden = Boolean(data.share);
    byId("share-expiry").textContent = expiryText;
    byId("result-summary").replaceChildren(summaryContent);
    document.title = `${data.title} | YT;DW`;
    document.body.classList.add("has-result");
    result.hidden = false;
    result.focus({ preventScroll: true });
  }

  async function responseData(response) {
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("The service could not respond. Please try again in a moment.");
    }
    return response.json();
  }

  async function loadSharedBrief() {
    showStatus("Opening the shared brief…", "Loading the saved result");
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(location.pathname.slice(3))}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const data = await responseData(response);
      if (response.status === 404) throw new Error("This link has expired or is unavailable. Ask the sender for the original video URL, then summarize it again.");
      if (!response.ok) throw new Error(data.error || "Please reload to try again.");
      showResult(data);
    } catch (requestError) {
      error.querySelector("strong").textContent = "Shared brief unavailable";
      byId("error-message").textContent = requestError.name === "TimeoutError" ? "Loading took too long. Please reload to try again." : requestError.message;
      error.hidden = false;
    } finally {
      status.hidden = true;
    }
  }

  async function runSummary(url, turnstileToken) {
    setPhase("processing");
    try {
      const response = await fetch("/api/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, turnstileToken }),
        signal: AbortSignal.timeout(8 * 60 * 1000)
      });
      const data = await responseData(response);
      if (!response.ok) throw new Error(data.error || "Please try again.");
      showResult(data);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      result.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    } catch (requestError) {
      byId("error-message").textContent = requestError.name === "TimeoutError"
        ? `This request took too long. Please try again.${currentResult ? " Your previous brief is still available below." : ""}`
        : requestError.message || "Check your connection and try again.";
      error.hidden = false;
      // Never discard a successful brief just because its replacement failed.
      if (currentResult) result.hidden = false;
    } finally {
      setPhase("idle");
      submittedUrl = "";
      if (window.turnstile && widgetId !== undefined) window.turnstile.reset(widgetId);
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (phase !== "idle" || !form.reportValidity()) return;
    if (!window.turnstile || widgetId === undefined) {
      showTurnstileError("Verification is not ready. Wait a moment or reload the page.");
      return;
    }
    submittedUrl = input.value;
    error.hidden = true;
    showTurnstileError("");
    setPhase("verifying");
    verificationTimer = setTimeout(() => failVerification("Verification timed out. Please try again."), 120_000);
    try { window.turnstile.execute(widgetId); }
    catch { failVerification("Verification could not start. Please reload and try again."); }
  });
  input.addEventListener("input", setSubmitState);

  copyButton.addEventListener("click", async () => {
    const brief = currentResult;
    if (!brief || copyInFlight === brief) return;
    copyInFlight = brief;
    copyButton.setAttribute("aria-disabled", "true");
    actionStatus("copy-status", "");
    try {
      // Preserve the source Markdown: CSS counters/textContent lose numbering and breaks.
      await navigator.clipboard.writeText(brief.summary);
      if (currentResult !== brief) return;
      byId("copy-fallback").hidden = true;
      actionStatus("copy-status", "Brief copied.");
    } catch {
      if (currentResult !== brief) return;
      byId("copy-fallback").hidden = false;
      byId("copy-text").value = brief.summary;
      byId("copy-text").focus();
      byId("copy-text").select();
      actionStatus("copy-status", "Copying is unavailable. Select and copy the brief below.", true);
    } finally {
      if (copyInFlight === brief) copyInFlight = null;
      if (currentResult === brief) copyButton.setAttribute("aria-disabled", "false");
    }
  });

  shareButton.addEventListener("click", async () => {
    const brief = currentResult;
    if (!brief?.share || shareButton.disabled || shareInFlight === brief) return;
    shareInFlight = brief;
    shareButton.setAttribute("aria-disabled", "true");
    byId("share-expiry").hidden = false;
    byId("share-fallback").hidden = true;
    actionStatus("share-status", "");
    let expired = false;
    try {
      const id = brief.share.url.split("/").pop();
      // Ask the server, not the user's clock. Checking never renews a snapshot.
      const response = await fetch(`/api/shares/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (currentResult !== brief) return;
      if (response.status === 404) {
        expired = true;
        byId("share-expiry").textContent = "This share link has expired or is unavailable. You can still copy the brief.";
        byId("regenerate-link").hidden = false;
        actionStatus("share-status", "Share link unavailable. Summarize this video again to create a new link.");
        return;
      }
      if (!response.ok) {
        const data = await responseData(response);
        throw new Error(data.error || "Could not check this link. Please try again.");
      }
      const url = new URL(brief.share.url, location.origin).href;
      try {
        await navigator.clipboard.writeText(url);
        if (currentResult === brief) actionStatus("share-status", "Share link copied.");
      } catch {
        if (currentResult !== brief) return;
        byId("share-fallback").hidden = false;
        byId("share-url").value = url;
        byId("share-url").focus();
        byId("share-url").select();
        actionStatus("share-status", "Select and copy the link below.", true);
      }
    } catch (requestError) {
      if (currentResult === brief) actionStatus("share-status", requestError.name === "TimeoutError" ? "Checking the link took too long. Please try Share again." : requestError.message, true);
    } finally {
      if (shareInFlight === brief) shareInFlight = null;
      if (currentResult === brief) {
        const wasFocused = document.activeElement === shareButton;
        shareButton.disabled = expired;
        shareButton.setAttribute("aria-disabled", String(expired));
        if (expired && wasFocused) byId("regenerate-link").focus();
      }
    }
  });

  if (isSharedView) void loadSharedBrief();
  else {
    input.value = new URLSearchParams(location.search).get("url") || "";
    setSubmitState();
    void setupVerification();
  }
})();

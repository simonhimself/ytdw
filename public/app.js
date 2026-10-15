(() => {
  const byId = (id) => document.getElementById(id);
  const isSharedView = location.pathname.startsWith("/s/");
  const isLibraryView = location.pathname === "/library";
  const isVerifyView = location.pathname === "/verify";
  const isResetView = location.pathname === "/reset-password";
  const isAccountView = location.pathname === "/account";
  const isHomeView = !isSharedView && !isLibraryView && !isVerifyView && !isResetView && !isAccountView;
  // Email links carry a one-time token. Read it, then strip it from the URL before anything
  // else runs so it can't leak through history, screenshots, or the Referer header.
  const linkToken = isVerifyView || isResetView ? new URLSearchParams(location.search).get("token") || "" : "";
  if (isVerifyView || isResetView) history.replaceState({}, "", location.pathname);
  const invalidLinkMessage = "This link is invalid or has expired.";
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
  const saveButton = byId("save-button");
  const readButton = byId("read-button");
  const deleteButton = byId("delete-button");
  let currentResult = null;
  // The single-bar video being summarized on this page; the header queue menu shows it too.
  let liveSummary = null;
  const LIVE_MENU_DELAY_MS = 1000;
  let currentLibraryItem = null;
  let phase = "idle";
  let submittedUrl = "";
  let widgetId;
  let verificationTimer;
  let processingTimer;
  const processingSteps = [
    ["Opening the video", "Starting a secure media worker"],
    ["Reading the captions", "Separating dialogue from timing data"],
    ["Finding the signal", "Distilling claims, facts, and conclusions"]
  ];
  let copyInFlight = null;
  let shareInFlight = null;

  // Several pasted links look like one valid URL to the browser; they belong in the queue box.
  // Links pasted without a separator ("…xyzhttps://…") still count separately.
  const linksIn = (text) => text.match(/https?:\/\/.*?(?=https?:\/\/|\s|$)/g) ?? [];
  function setSubmitState() {
    const several = linksIn(input.value).length > 1;
    submitButton.disabled = phase !== "idle" || !input.validity.valid || several;
    input.readOnly = phase !== "idle";
    renderSeveralLinks(several);
  }

  function showStatus(title, detail) {
    byId("process-announcement").textContent = `${title} ${detail}`;
    byId("status-title").textContent = title;
    byId("status-detail").textContent = detail;
    status.hidden = false;
  }

  function setPhase(next) {
    clearInterval(processingTimer);
    phase = next;
    if (next !== "verifying") clearTimeout(verificationTimer);
    form.setAttribute("aria-busy", String(next !== "idle"));
    document.body.classList.toggle("is-busy", next === "processing");
    submitButton.querySelector(".button-label").textContent = next === "idle" ? "Summarize" : next === "verifying" ? "Verifying" : "Working";
    byId("previous-result-note").hidden = !currentResult || next === "idle";
    if (next === "verifying") {
      // Keep verification feedback in the button so the loading block appears only during processing.
      status.hidden = true;
      byId("process-announcement").textContent = "Verifying. Complete the verification if prompted.";
    }
    if (next === "processing") {
      // These timed messages describe the workflow, not backend-reported progress.
      let step = 0;
      showStatus(...processingSteps[step]);
      processingTimer = setInterval(() => {
        showStatus(...processingSteps[++step]);
        if (step === processingSteps.length - 1) clearInterval(processingTimer);
      }, 4500);
    }
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

  // One shared load of the sitekey config and Turnstile script. The summarize widget
  // renders on the landing page; the auth widget renders lazily when the dialog opens,
  // so shared and library pages never contact Turnstile until someone signs in.
  let turnstileReady;
  function loadTurnstile() {
    turnstileReady ??= (async () => {
      let sitekey;
      try {
        const response = await fetch("/api/config", { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("Configuration unavailable");
        const config = await response.json();
        if (typeof config.turnstileSitekey !== "string" || !config.turnstileSitekey) throw new Error("Missing sitekey");
        sitekey = config.turnstileSitekey;
      } catch {
        throw new Error("Verification could not load. Check your connection and reload.");
      }
      await new Promise((resolve, reject) => {
        window.onTurnstileLoad = resolve;
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit";
        script.onerror = () => reject(new Error("Verification is blocked. Allow challenges.cloudflare.com and reload."));
        document.head.append(script);
        window.setTimeout(() => reject(new Error("Verification is unavailable. Check your connection and reload.")), 10_000);
      });
      return sitekey;
    })();
    // A failed load may be retried (for example when the auth dialog is reopened).
    turnstileReady.catch(() => { turnstileReady = undefined; });
    return turnstileReady;
  }

  async function setupVerification() {
    try {
      const sitekey = await loadTurnstile();
      widgetId = window.turnstile.render("#turnstile-widget", {
        sitekey,
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
    } catch (setupError) {
      showTurnstileError(setupError.message || "Verification could not load. Check your connection and reload.");
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

  const validShare = (share) => Boolean(share) && /^\/s\/[0-9a-f-]{36}$/.test(share.url) &&
    Number.isFinite(share.expiresAt) && Number.isFinite(new Date(share.expiresAt).getTime());

  const shareExpiryText = (share) =>
    `Share link available until ${new Date(share.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. Anyone with the link can read and forward it.`;

  function showResult(data, { libraryItem = null } = {}) {
    // Validate and build the replacement before changing the previous brief.
    if (!data || !/^[A-Za-z0-9_-]{11}$/.test(data.id) || typeof data.title !== "string" ||
        !Number.isFinite(data.duration) || data.duration < 0 || typeof data.summary !== "string" || !data.summary.trim() ||
        (data.share !== null && !validShare(data.share))) {
      throw new Error("The service returned an incomplete brief. Please try again.");
    }
    const summaryContent = renderSummary(data.summary);
    // Library items create their link on demand, so the note stays empty until Share is used.
    const expiryText = data.share
      ? shareExpiryText(data.share)
      : libraryItem ? "" : "Sharing and saving are temporarily unavailable. You can still copy this brief.";
    // A library item can always attempt Share; its link is created by the click.
    const canShare = Boolean(data.share) || Boolean(libraryItem);
    currentResult = data;
    currentLibraryItem = libraryItem;
    byId("result-channel").textContent = data.uploader || "YouTube";
    byId("result-title").textContent = data.title;
    byId("result-duration").textContent = formatDuration(data.duration);
    const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(data.id)}`;
    byId("video-link").href = videoUrl;
    byId("regenerate-link").href = `/?url=${encodeURIComponent(videoUrl)}`;
    byId("regenerate-link").hidden = true;
    byId("transcript-note").textContent = data.transcriptTruncated ? "Long transcript condensed" : "Full transcript processed";
    shareButton.disabled = !canShare;
    copyButton.disabled = false;
    shareButton.setAttribute("aria-disabled", String(!canShare));
    copyButton.setAttribute("aria-disabled", "false");
    actionStatus("copy-status", "");
    actionStatus("share-status", "");
    actionStatus("save-status", "");
    actionStatus("item-status", "");
    byId("copy-fallback").hidden = true;
    byId("share-fallback").hidden = true;
    byId("previous-result-note").hidden = true;
    byId("share-expiry").hidden = Boolean(data.share) || Boolean(libraryItem);
    byId("share-expiry").textContent = expiryText;
    // Library items reuse this article but swap Save for read-state and delete.
    saveButton.hidden = Boolean(libraryItem);
    shareButton.hidden = false;
    for (const button of [readButton, deleteButton, byId("library-back")]) button.hidden = !libraryItem;
    byId("library-meta").hidden = !libraryItem;
    renderSaveButton();
    if (libraryItem) renderLibraryItemState();
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

  // Anonymous daily counts for the funnel (/stats); a failure is never shown.
  function countEvent(event) {
    fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event }), keepalive: true }).catch(() => {});
  }

  async function loadSharedBrief() {
    showStatus("Opening the shared brief…", "Loading the saved result");
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(location.pathname.slice(3))}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const data = await responseData(response);
      if (response.status === 404) throw new Error("This link has expired or is unavailable. Ask the sender for the original video URL, then summarize it again.");
      if (!response.ok) throw new Error(data.error || "Please reload to try again.");
      showResult(data);
      countEvent("share_view");
    } catch (requestError) {
      error.querySelector("strong").textContent = "Shared brief unavailable";
      byId("error-message").textContent = requestError.name === "TimeoutError" ? "Loading took too long. Please reload to try again." : requestError.message;
      error.hidden = false;
    } finally {
      status.hidden = true;
    }
  }

  function videoIdOf(url) {
    try {
      const parsed = new URL(url);
      const id = parsed.hostname === "youtu.be" ? parsed.pathname.split("/")[1] : parsed.searchParams.get("v") ?? parsed.pathname.split("/")[2];
      return /^[A-Za-z0-9_-]{11}$/.test(id ?? "") ? id : null;
    } catch { return null; }
  }

  async function runSummary(url, turnstileToken) {
    setPhase("processing");
    // Cached briefs return at once: show the run in the header menu only if it takes a while.
    const liveTimer = setTimeout(() => {
      liveSummary = { videoId: videoIdOf(url) };
      renderQueueMenu();
    }, LIVE_MENU_DELAY_MS);
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
      clearTimeout(liveTimer);
      liveSummary = null;
      renderQueueMenu();
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
    const item = currentLibraryItem;
    if (!brief || (!brief.share && !item) || shareButton.disabled || shareInFlight === brief) return;
    shareInFlight = brief;
    shareButton.setAttribute("aria-disabled", "true");
    byId("share-expiry").hidden = !brief.share;
    byId("share-fallback").hidden = true;
    actionStatus("share-status", "");
    let expired = false;
    try {
      if (brief.share) {
        const id = brief.share.url.split("/").pop();
        // Ask the server, not the user's clock. Checking never renews a snapshot.
        const response = await fetch(`/api/shares/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (currentResult !== brief) return;
        if (response.status === 404 && item) {
          // The saved copy outlives its link, so mint a new one below.
          brief.share = null;
        } else if (response.status === 404) {
          expired = true;
          byId("share-expiry").textContent = "This share link has expired or is unavailable. You can still copy the brief.";
          byId("regenerate-link").hidden = false;
          actionStatus("share-status", "Share link unavailable. Summarize this video again to create a new link.");
          return;
        } else if (!response.ok) {
          const data = await responseData(response);
          throw new Error(data.error || "Could not check this link. Please try again.");
        }
      }
      if (!brief.share) {
        // Library items carry no link of their own: create one from the saved copy.
        const response = await apiRequest(`/api/library/${encodeURIComponent(item.id)}/share`, { method: "POST", body: {} });
        if (response.status === 401) {
          endSession();
          if (currentLibraryItem === item) showSignedOut(true);
          return;
        }
        if (currentResult !== brief) return;
        if (response.status === 404) throw new Error("This brief is no longer in your library.");
        if (!response.ok) throw new Error(await failureMessage(response, "Could not create a share link. Please try again."));
        const { share } = await responseData(response);
        if (currentResult !== brief) return;
        if (!validShare(share)) throw new Error("The service returned an incomplete share link. Please try again.");
        brief.share = share;
        byId("share-expiry").textContent = shareExpiryText(share);
        byId("share-expiry").hidden = false;
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

  // ---- Accounts -----------------------------------------------------------------

  const signInButton = byId("sign-in-button");
  const libraryLink = byId("library-link");
  const accountMenu = byId("account-menu");
  const authDialog = byId("auth-dialog");
  const authForm = byId("auth-form");
  const authEmail = byId("auth-email");
  const authPassword = byId("auth-password");
  const authSubmit = byId("auth-submit");
  const library = byId("library");
  let user = null;
  let accountKnown = false;
  let libraryCounts = null;
  // Keyed by brief object so a replacement brief always starts unsaved.
  let savedBriefs = new WeakSet();
  let savingInFlight = null;

  function parseUser(value) {
    // Only an explicit false counts as unverified, so a response without the field never nags.
    return value && typeof value.email === "string" && value.email ? { email: value.email, emailVerified: value.emailVerified !== false } : null;
  }

  function apiRequest(path, { method = "GET", body, timeout = 15_000 } = {}) {
    const init = { method, cache: "no-store", signal: AbortSignal.timeout(timeout) };
    // The API rejects mutating requests without a JSON content type (CSRF defense), DELETE included.
    if (method !== "GET") init.headers = { "content-type": "application/json" };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(path, init);
  }

  async function failureMessage(response, fallback) {
    try {
      const data = await responseData(response);
      if (typeof data.error === "string" && data.error) return data.error;
    } catch {}
    return fallback;
  }

  function requestFailureMessage(requestError, fallback) {
    return requestError.name === "TimeoutError" ? "That took too long. Please try again." : requestError.message || fallback;
  }

  function announceAccount(text) {
    byId("account-status").textContent = text;
  }

  function setCounts(counts) {
    if (!counts || !Number.isFinite(counts.unread) || !Number.isFinite(counts.all)) return;
    libraryCounts = { unread: counts.unread, all: counts.all };
    renderAccount();
    for (const tab of document.querySelectorAll(".library-tab")) {
      tab.querySelector(".library-tab__count").textContent = String(libraryCounts[tab.dataset.filter]);
    }
  }

  function renderAccount() {
    signInButton.hidden = !accountKnown || Boolean(user);
    libraryLink.hidden = !user;
    accountMenu.hidden = !user;
    if (!user) accountMenu.open = false;
    else byId("account-email").textContent = user.email;
    const unread = libraryCounts?.unread ?? 0;
    const badge = byId("library-badge");
    badge.hidden = !user || unread < 1;
    badge.textContent = unread > 99 ? "99+" : String(unread);
    libraryLink.setAttribute("aria-label", user && unread > 0 ? `Library, ${unread} unread` : "Library");
    if (isLibraryView) libraryLink.setAttribute("aria-current", "page");
    if (isAccountView) byId("account-link").setAttribute("aria-current", "page");
    renderVerifyBanner();
    renderQueueBox();
  }

  // The banner follows signed-in-but-unverified accounts on the main, library, and account views.
  // It stays off shared and email-link pages, which have their own context.
  let resendState = "idle";
  function renderVerifyBanner() {
    const show = Boolean(user) && !user.emailVerified && (isHomeView || isLibraryView || isAccountView);
    if (!show) resendState = "idle";
    byId("verify-banner").hidden = !show;
    byId("verify-banner-resend").hidden = resendState === "sent";
    byId("verify-banner-sent").hidden = resendState !== "sent";
    if (resendState !== "idle" || !show) byId("verify-banner-note").hidden = true;
  }

  // Shared by the banner and the /verify page. Resolves to an outcome instead of touching the DOM.
  async function requestResend() {
    try {
      const response = await apiRequest("/api/auth/verify/resend", { method: "POST", body: {} });
      if (response.status === 401) {
        endSession();
        return { outcome: "signed-out" };
      }
      if (!response.ok) throw new Error(await failureMessage(response, "Could not send the email. Please try again."));
      // 200 with a user means the address was already verified; 202 means a new email is on its way.
      if (response.status === 200) {
        const verified = parseUser((await responseData(response).catch(() => ({}))).user);
        if (verified) {
          user = verified;
          renderAccount();
          return { outcome: "verified" };
        }
      }
      return { outcome: "sent" };
    } catch (requestError) {
      return { outcome: "error", message: requestFailureMessage(requestError, "Could not send the email. Please try again.") };
    }
  }

  byId("verify-banner-resend").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.getAttribute("aria-disabled") === "true") return;
    button.setAttribute("aria-disabled", "true");
    byId("verify-banner-note").hidden = true;
    const { outcome, message } = await requestResend();
    button.setAttribute("aria-disabled", "false");
    if (outcome === "sent") {
      resendState = "sent";
      renderVerifyBanner();
      announceAccount("Verification email sent. Check your inbox.");
      byId("verify-banner-sent").focus();
    } else if (outcome === "verified") {
      announceAccount("Your email is already verified.");
      accountMenu.querySelector("summary").focus();
    } else if (outcome === "signed-out") {
      announceAccount("Your session has ended. Sign in again.");
      signInButton.focus();
    } else {
      byId("verify-banner-note").textContent = message;
      byId("verify-banner-note").hidden = false;
      announceAccount(message);
    }
  });

  // Pages that depend on the signed-in user re-render whenever it changes.
  function afterSessionChange() {
    syncQueue();
    renderSaveButton();
    if (isAccountView) renderAccountPage();
    if (isVerifyView) renderVerifyPage();
  }

  // Header counts come from the unread list endpoint; failures just omit the badge.
  async function refreshCounts() {
    if (!user) return;
    try {
      const response = await apiRequest("/api/library?filter=unread");
      if (!response.ok || !user) return;
      const data = await responseData(response);
      if (user) setCounts(data.counts);
    } catch {}
  }

  function endSession() {
    user = null;
    libraryCounts = null;
    savedBriefs = new WeakSet();
    renderAccount();
    renderSaveButton();
    afterSessionChange();
  }

  async function loadAccount() {
    try {
      const response = await apiRequest("/api/auth/me", { timeout: 10_000 });
      if (response.ok) user = parseUser((await responseData(response)).user);
    } catch {}
    // The /verify request can finish before /me; keep the in-memory user in step with it.
    if (user && verifyState === "success") user.emailVerified = true;
    accountKnown = true;
    renderAccount();
    renderSaveButton();
    afterSessionChange();
    if (user && !isLibraryView) void refreshCounts();
  }

  document.addEventListener("click", (event) => {
    if (accountMenu.open && !accountMenu.contains(event.target)) accountMenu.open = false;
  });
  accountMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && accountMenu.open) {
      accountMenu.open = false;
      accountMenu.querySelector("summary").focus();
    }
  });

  byId("sign-out-button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.getAttribute("aria-disabled") === "true") return;
    button.setAttribute("aria-disabled", "true");
    try {
      const response = await apiRequest("/api/auth/logout", { method: "POST", body: {} });
      // 401 means the session is already gone, which is what the user asked for.
      if (!response.ok && response.status !== 401) throw new Error(await failureMessage(response, "Could not sign out. Please try again."));
      endSession();
      announceAccount("Signed out.");
      if (isLibraryView) showSignedOut(false);
      signInButton.focus();
    } catch (requestError) {
      announceAccount(requestFailureMessage(requestError, "Could not sign out. Please try again."));
    } finally {
      button.setAttribute("aria-disabled", "false");
    }
  });

  // ---- Background queue -----------------------------------------------------------
  // Verified users paste several URLs into an on-demand box on the home page. Progress
  // lives in a header menu that only exists while something is queued, processing, or
  // failed; finished briefs simply land in the library as unread.

  const QUEUE_MAX_URLS = 10;
  const QUEUE_POLL_MS = 10_000;
  const queueMenu = byId("queue-menu");
  const queueBox = byId("queue-box");
  const queueOpen = byId("queue-open");
  const queueUrls = byId("queue-urls");
  const queueSubmit = byId("queue-submit");
  let queueItems = [];
  let queueQuota = null;
  let queueRequest = 0;
  let queuePollTimer;
  let queueBusy = false;
  const queueResultLabels = {
    queued: "Queued",
    duplicate: "Listed twice",
    alreadyQueued: "Already queued",
    alreadySaved: "Already in library",
    libraryFull: "Library is full",
    invalid: "Not a YouTube link",
    overQuota: "Over today’s limit",
  };

  function queueLines() {
    return queueUrls.value.split(/\s+/).map((line) => line.trim()).filter(Boolean);
  }

  function renderQueueBox() {
    const signedIn = Boolean(user) && isHomeView;
    if (!signedIn) queueBox.hidden = true;
    queueOpen.setAttribute("aria-expanded", String(!queueBox.hidden));
    const verified = Boolean(user?.emailVerified);
    const count = queueLines().length;
    queueUrls.disabled = !verified || queueBusy;
    queueSubmit.disabled = !verified || queueBusy || count === 0;
    queueSubmit.textContent = queueBusy ? "Adding…" : count > 0 ? `Add ${count} to queue` : "Add to queue";
    renderSeveralLinks(linksIn(input.value).length > 1);
    const left = byId("queue-left");
    if (!verified) left.textContent = "Verify your email to queue videos.";
    else if (queueQuota) left.textContent = `${queueQuota.remaining} of ${queueQuota.limit} left today`;
    else left.textContent = "";
  }

  function showQueueError(message) {
    const element = byId("queue-error");
    element.textContent = message;
    element.hidden = !message;
    queueUrls.setAttribute("aria-invalid", String(Boolean(message)));
  }

  function openQueueBox() {
    queueBox.hidden = false;
    showQueueError("");
    renderQueueBox();
    (queueUrls.disabled ? queueSubmit : queueUrls).focus();
    if (user?.emailVerified && !queueQuota) void loadQueue();
  }

  function closeQueueBox() {
    queueBox.hidden = true;
    byId("queue-results").hidden = true;
    showQueueError("");
    renderQueueBox();
    queueOpen.focus();
  }

  function queueStateText(item) {
    if (item.status === "processing") return "Summarizing…";
    if (item.status === "failed") return item.error || "Could not be summarized.";
    return item.error ? "Waiting to try again" : "Queued";
  }

  function renderQueueMenu() {
    const live = user ? liveSummary : null;
    const visible = Boolean(user) && (queueItems.length > 0 || Boolean(live));
    queueMenu.hidden = !visible;
    if (!visible) {
      queueMenu.open = false;
      return;
    }
    const active = queueItems.filter((item) => item.status !== "failed").length + (live ? 1 : 0);
    const failed = queueItems.length + (live ? 1 : 0) - active;
    queueMenu.toggleAttribute("data-active", active > 0);
    byId("queue-count").textContent = String(active + failed);
    byId("queue-summary").setAttribute("aria-label", [
      active ? `${active} ${active === 1 ? "video" : "videos"} in progress` : "",
      failed ? `${failed} failed` : "",
    ].filter(Boolean).join(", "));
    // A single-bar summary is not saved and does not use the daily quota: with nothing
    // queued, the menu says neither.
    const queued = queueItems.length > 0;
    byId("queue-head").textContent = queued ? "In progress · queued briefs go to your library" : "In progress";
    byId("queue-quota").textContent = queueQuota ? `${queueQuota.remaining} of ${queueQuota.limit} left today` : "";
    byId("queue-quota").hidden = !queued || !queueQuota;
    // Polling re-renders every few seconds: leave the rows alone when nothing changed, so
    // keyboard focus and screen-reader position survive.
    const list = byId("queue-list");
    const rendered = JSON.stringify([live?.videoId ?? null, live ? 1 : 0, queueItems.map((item) => [item.id, item.status, item.error, item.retryable])]);
    if (rendered === list.dataset.rendered) return;
    list.dataset.rendered = rendered;
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusedRow = focused?.closest("li");
    const focusedIndex = focusedRow ? [...list.children].indexOf(focusedRow) : -1;
    list.replaceChildren(...(live ? [liveRow(live)] : []), ...queueItems.map((item) => {
      const li = document.createElement("li");
      li.dataset.id = item.id;
      const main = document.createElement("span");
      main.className = "queue-item__main";
      const video = document.createElement("a");
      video.className = "queue-item__video";
      video.href = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
      video.target = "_blank";
      video.rel = "noopener noreferrer";
      video.textContent = `youtu.be/${item.videoId}`;
      video.dataset.action = "open";
      const state = document.createElement("span");
      state.className = `queue-item__state${item.status === "failed" ? " is-failed" : ""}`;
      state.textContent = queueStateText(item);
      main.append(video, state);
      const actions = document.createElement("span");
      actions.className = "queue-item__actions";
      if (item.status === "failed" && item.retryable) actions.append(queueAction("Retry", item, "retry"));
      actions.append(queueAction("Remove", item, "remove"));
      li.append(main, actions);
      return li;
    }));
    if (focused) restoreQueueFocus(focusedRow?.dataset.id, focused.dataset.action, focusedIndex);
  }

  // Same control on the same item; else that item's link; else the row now in that
  // place (never its Remove, so a repeated Enter cannot delete a second item).
  function restoreQueueFocus(id, action, index) {
    const list = byId("queue-list");
    const row = [...list.children].find((li) => id && li.dataset.id === id);
    const fallback = row ?? list.children[Math.min(index, list.children.length - 1)];
    const target = row?.querySelector(`[data-action="${action}"]`) ?? fallback?.querySelector("a") ?? byId("queue-summary");
    target.focus();
  }

  // The single-bar video runs in this page's request, so it has no Retry or Remove.
  function liveRow(live) {
    const li = document.createElement("li");
    li.dataset.id = "live";
    const main = document.createElement("span");
    main.className = "queue-item__main";
    const video = document.createElement(live.videoId ? "a" : "span");
    video.className = "queue-item__video";
    if (live.videoId) {
      video.href = `https://www.youtube.com/watch?v=${encodeURIComponent(live.videoId)}`;
      video.target = "_blank";
      video.rel = "noopener noreferrer";
    }
    video.textContent = live.videoId ? `youtu.be/${live.videoId}` : "This video";
    video.dataset.action = "open";
    const state = document.createElement("span");
    state.className = "queue-item__state";
    state.textContent = "Summarizing on this page…";
    main.append(video, state);
    li.append(main);
    return li;
  }

  function queueAction(label, item, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", `${label} youtu.be/${item.videoId}`);
    button.dataset.action = action;
    button.addEventListener("click", () => void runQueueAction(button, item, action));
    return button;
  }

  function scheduleQueuePoll() {
    clearTimeout(queuePollTimer);
    if (!user || !queueItems.some((item) => item.status !== "failed")) return;
    queuePollTimer = setTimeout(() => {
      if (document.visibilityState === "visible") void loadQueue();
      else scheduleQueuePoll();
    }, QUEUE_POLL_MS);
  }

  // Briefs that left the active queue may have landed in the library.
  function applyQueue(data) {
    const previous = new Set(queueItems.filter((item) => item.status !== "failed").map((item) => item.id));
    queueItems = Array.isArray(data.items) ? data.items : [];
    if (data.quota && Number.isFinite(data.quota.remaining)) queueQuota = data.quota;
    const stillActive = new Set(queueItems.filter((item) => item.status !== "failed").map((item) => item.id));
    const finished = [...previous].filter((id) => !stillActive.has(id) && !queueItems.some((item) => item.id === id)).length;
    renderQueueMenu();
    renderQueueBox();
    scheduleQueuePoll();
    if (finished > 0) {
      announceAccount(`${finished} ${finished === 1 ? "brief is" : "briefs are"} ready in your library.`);
      if (isLibraryView && !new URLSearchParams(location.search).get("item")) void routeLibrary(false);
      else void refreshCounts();
    }
  }

  async function loadQueue() {
    if (!user) return;
    const request = ++queueRequest;
    try {
      const response = await apiRequest("/api/queue");
      if (request !== queueRequest || !user) return;
      if (response.status === 401) return endSession();
      if (!response.ok) return scheduleQueuePoll();
      applyQueue(await responseData(response));
    } catch {
      if (request === queueRequest) scheduleQueuePoll();
    }
  }

  function syncQueue() {
    if (user) void loadQueue();
    else {
      queueRequest++;
      clearTimeout(queuePollTimer);
      queueItems = [];
      queueQuota = null;
      // The next person on this browser must not see what was pasted.
      queueUrls.value = "";
      byId("queue-results").hidden = true;
      showQueueError("");
      renderQueueMenu();
      renderQueueBox();
    }
  }

  async function runQueueAction(button, item, action) {
    if (button.getAttribute("aria-disabled") === "true") return;
    button.setAttribute("aria-disabled", "true");
    const label = `youtu.be/${item.videoId}`;
    try {
      const response = await apiRequest(`/api/queue/${encodeURIComponent(item.id)}${action === "retry" ? "/retry" : ""}`, {
        method: action === "retry" ? "POST" : "DELETE",
        body: action === "retry" ? {} : undefined,
      });
      if (response.status === 401) {
        endSession();
        announceAccount("Your session has ended. Sign in again.");
        return signInButton.focus();
      }
      // 404: already gone (another tab removed it, or it finished); 409: no longer retryable.
      if (!response.ok && response.status !== 404 && response.status !== 409) {
        throw new Error(await failureMessage(response, "That didn’t work. Please try again."));
      }
      // A removed item must not be announced as a finished brief.
      if (action === "remove") queueItems = queueItems.filter((entry) => entry.id !== item.id);
      announceAccount(action === "retry" ? `Retrying ${label}.` : `Removed ${label}.`);
    } catch (requestError) {
      announceAccount(requestFailureMessage(requestError, "That didn’t work. Please try again."));
    }
    await loadQueue();
    // Still here when the list did not change (for example after an error).
    button.removeAttribute("aria-disabled");
    // A re-render keeps focus in the menu (restoreQueueFocus); an unchanged list keeps the button.
    if (queueMenu.hidden) {
      (isHomeView ? input : libraryLink).focus();
    }
  }

  function renderQueueResults(results) {
    const list = byId("queue-results");
    const problems = results.filter((entry) => entry.status !== "queued");
    list.replaceChildren(...problems.map((entry) => {
      const li = document.createElement("li");
      if (["invalid", "overQuota", "libraryFull"].includes(entry.status)) li.className = "is-problem";
      const label = document.createElement("strong");
      label.textContent = queueResultLabels[entry.status] ?? entry.status;
      const url = document.createElement("span");
      url.textContent = entry.videoId ? `youtu.be/${entry.videoId}` : entry.url;
      li.append(label, url);
      return li;
    }));
    list.hidden = problems.length === 0;
  }

  // Several links in the single bar: offer to move them into the queue box.
  const severalHint = byId("several-links");
  function renderSeveralLinks(several) {
    const show = several && isHomeView && phase === "idle";
    severalHint.hidden = !show;
    // One hint at a time: the several-links offer replaces the general queue link.
    // Signed-out visitors see the link too; it invites them to create an account.
    byId("queue-toggle").hidden = !accountKnown || !isHomeView || !queueBox.hidden || show;
    if (show) byId("several-links-action").textContent = !user ? "Sign up to queue them" : user.emailVerified ? "Queue them instead" : "Verify your email to queue them";
  }
  byId("several-links-action").addEventListener("click", () => {
    if (!user) return openAuth({ mode: "signup", opener: byId("several-links-action"), lede: queueSignupLede });
    // Unverified accounts cannot queue: leave the links in place and point at the banner.
    if (!user.emailVerified) {
      const resend = byId("verify-banner-resend");
      resend.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      return resend.focus({ preventScroll: true });
    }
    const links = linksIn(input.value);
    const existing = queueLines();
    queueUrls.value = [...existing, ...links].join("\n");
    input.value = "";
    setSubmitState();
    openQueueBox();
  });

  const queueSignupLede = "Create an account to queue several videos. Their briefs land in your library.";
  queueOpen.addEventListener("click", () => {
    if (user) return openQueueBox();
    openAuth({ mode: "signup", opener: queueOpen, lede: queueSignupLede, then: openQueueBox });
  });
  byId("queue-cancel").addEventListener("click", closeQueueBox);
  queueUrls.addEventListener("input", () => {
    showQueueError("");
    renderQueueBox();
  });
  queueBox.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeQueueBox();
    // Cmd/Ctrl+Enter submits from the textarea, where Enter adds a line.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !queueSubmit.disabled) queueBox.requestSubmit();
  });
  queueBox.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (queueBusy || !user?.emailVerified) return;
    const urls = queueLines();
    if (urls.length === 0) return showQueueError("Paste at least one YouTube URL.");
    if (urls.length > QUEUE_MAX_URLS) return showQueueError(`Paste at most ${QUEUE_MAX_URLS} URLs at a time. You have ${urls.length}.`);
    showQueueError("");
    queueBusy = true;
    renderQueueBox();
    try {
      const response = await apiRequest("/api/queue", { method: "POST", body: { urls } });
      if (response.status === 401) {
        endSession();
        openAuth({ opener: queueOpen });
        return;
      }
      if (!response.ok) throw new Error(await failureMessage(response, "Could not add these videos. Please try again."));
      const data = await responseData(response);
      const results = Array.isArray(data.results) ? data.results : [];
      queueRequest++;
      applyQueue(data);
      const queued = results.filter((entry) => entry.status === "queued").length;
      const summary = queued > 0
        ? `${queued} ${queued === 1 ? "video" : "videos"} queued. ${queued === 1 ? "It lands" : "They land"} in your library when ready.`
        : "Nothing new was queued.";
      // Keep only the lines that need attention, so a fix-and-resubmit is easy.
      const keep = results.filter((entry) => entry.status === "invalid" || entry.status === "overQuota").map((entry) => entry.url);
      queueUrls.value = keep.join("\n");
      queueBusy = false;
      if (results.every((entry) => entry.status === "queued")) {
        closeQueueBox();
        byId("queue-announcement").textContent = summary;
      } else {
        renderQueueResults(results);
        byId("queue-announcement").textContent = `${summary} ${results.length - queued} of ${results.length} need attention.`;
        renderQueueBox();
        queueUrls.focus();
      }
    } catch (requestError) {
      showQueueError(requestFailureMessage(requestError, "Could not add these videos. Please try again."));
      // The disabled textarea lost focus while adding; give it back with the error.
      queueBusy = false;
      renderQueueBox();
      queueUrls.focus();
    } finally {
      if (queueBusy) {
        queueBusy = false;
        renderQueueBox();
      }
    }
  });

  document.addEventListener("click", (event) => {
    if (queueMenu.open && !queueMenu.contains(event.target)) queueMenu.open = false;
  });
  queueMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && queueMenu.open) {
      queueMenu.open = false;
      byId("queue-summary").focus();
    }
  });
  // Returning to the tab checks right away instead of waiting out the poll.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && queueItems.some((item) => item.status !== "failed")) void loadQueue();
  });

  // ---- Auth dialog --------------------------------------------------------------

  let authMode = "signin";
  let authPhase = "idle";
  let authOpener = null;
  let authCredentials = null;
  let authTimer;
  let afterAuth = null;
  let authWidgetId;
  let authWidgetPromise;

  // Modes: "signin", "signup", and "forgot" (email only; always ends in a generic confirmation).
  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === "signup";
    const forgot = mode === "forgot";
    showAuthDone(null);
    byId("auth-title").textContent = forgot ? "Reset password" : signup ? "Create account" : "Sign in";
    byId("auth-lede").textContent = forgot ? "Enter your email and we’ll send a link to choose a new password."
      : signup ? "Create an account to save briefs and read them later." : "Sign in to save briefs and read them later.";
    authSubmit.textContent = forgot ? "Send reset link" : signup ? "Create account" : "Sign in";
    byId("auth-switch-prompt").textContent = signup ? "Already have an account?" : forgot ? "Remembered it?" : "New here?";
    byId("auth-switch").textContent = signup || forgot ? "Sign in" : "Create an account";
    byId("auth-password-field").hidden = forgot;
    byId("auth-hint").hidden = !signup;
    byId("auth-forgot-row").hidden = mode !== "signin";
    authPassword.autocomplete = signup ? "new-password" : "current-password";
  }

  // The confirmation replaces the form once a reset link has been requested.
  function showAuthDone(message) {
    const done = message !== null;
    byId("auth-fields").hidden = done;
    byId("auth-done").hidden = !done;
    if (done) {
      byId("auth-title").textContent = "Check your email";
      byId("auth-done-message").textContent = message;
      byId("auth-done-message").focus();
    }
  }

  function showAuthError(message, field) {
    const element = byId("auth-error");
    element.textContent = message;
    element.hidden = !message;
    byId("auth-error-actions").hidden = true;
    authEmail.removeAttribute("aria-invalid");
    authPassword.removeAttribute("aria-invalid");
    if (message && field) {
      field.setAttribute("aria-invalid", "true");
      field.focus();
    }
  }

  function setAuthPhase(next) {
    authPhase = next;
    if (next !== "verifying") clearTimeout(authTimer);
    const busy = next !== "idle";
    authForm.setAttribute("aria-busy", String(busy));
    authEmail.readOnly = busy;
    authPassword.readOnly = busy;
    authSubmit.setAttribute("aria-disabled", String(busy));
    const signup = authMode === "signup";
    const forgot = authMode === "forgot";
    const idleLabel = forgot ? "Send reset link" : signup ? "Create account" : "Sign in";
    const busyLabel = forgot ? "Sending…" : signup ? "Creating account…" : "Signing in…";
    authSubmit.textContent = next === "verifying" ? "Verifying…" : next === "submitting" ? busyLabel : idleLabel;
  }

  function resetAuthWidget() {
    if (window.turnstile && authWidgetId !== undefined) {
      try { window.turnstile.reset(authWidgetId); } catch {}
    }
  }

  function failAuth(message, field = authPassword) {
    // Late widget callbacks after cancel or completion must not touch a dialog that moved on.
    if (authPhase === "idle") return;
    setAuthPhase("idle");
    resetAuthWidget();
    showAuthError(message, field);
  }

  // Render the auth widget once, on first use. Its callbacks are independent of the summarize widget.
  function ensureAuthWidget() {
    authWidgetPromise ??= loadTurnstile().then((sitekey) => {
      authWidgetId = window.turnstile.render("#auth-turnstile", {
        sitekey,
        action: "auth",
        execution: "execute",
        appearance: "interaction-only",
        callback(token) {
          if (authPhase !== "verifying") return;
          clearTimeout(authTimer);
          void submitAuth(token);
        },
        "expired-callback": () => { if (authPhase === "verifying") failAuth("Verification expired. Please try again."); },
        "timeout-callback": () => { if (authPhase === "verifying") failAuth("Verification timed out. Please try again."); },
        "error-callback": () => { if (authPhase === "verifying") failAuth("Verification could not load. Check your connection, allow challenges.cloudflare.com, and retry."); }
      });
      return authWidgetId;
    });
    authWidgetPromise.catch(() => { authWidgetPromise = undefined; });
    return authWidgetPromise;
  }

  function openAuth({ mode = "signin", opener = document.activeElement, then = null, lede = null } = {}) {
    if (authDialog.open) return;
    authOpener = opener;
    afterAuth = then;
    // setAuthMode also clears any confirmation panel left from a previous forgot request.
    setAuthMode(mode);
    if (lede) byId("auth-lede").textContent = lede;
    setAuthPhase("idle");
    authPassword.value = "";
    showAuthError("");
    authDialog.showModal();
    authEmail.focus();
    ensureAuthWidget().catch((setupError) => showAuthError(setupError.message, null));
  }

  authDialog.addEventListener("close", () => {
    const wasBusy = authPhase !== "idle";
    setAuthPhase("idle");
    if (wasBusy) resetAuthWidget();
    afterAuth = null;
    authCredentials = null;
    authPassword.value = "";
    const opener = authOpener;
    authOpener = null;
    // The opener may have disappeared (for example the header button after signing in).
    const pageTitle = [byId("library-title"), byId("account-title"), byId("verify-title"), byId("reset-title")].find((element) => element.getClientRects().length);
    const target = opener?.isConnected && opener.getClientRects().length ? opener
      : pageTitle ?? (user && accountMenu.getClientRects().length ? accountMenu.querySelector("summary") : null);
    target?.focus();
  });
  authDialog.addEventListener("click", (event) => { if (event.target === authDialog) authDialog.close(); });
  byId("auth-close").addEventListener("click", () => authDialog.close());
  byId("auth-switch").addEventListener("click", () => {
    if (authPhase !== "idle") return;
    setAuthMode(authMode === "signin" ? "signup" : "signin");
    showAuthError("");
    authEmail.focus();
  });
  byId("auth-forgot").addEventListener("click", () => {
    if (authPhase !== "idle") return;
    setAuthMode("forgot");
    showAuthError("");
    authEmail.focus();
  });
  // Inline actions offered after a duplicate-signup error; the typed email is kept.
  byId("auth-error-signin").addEventListener("click", () => {
    if (authPhase !== "idle") return;
    setAuthMode("signin");
    showAuthError("");
    authPassword.focus();
  });
  byId("auth-error-reset").addEventListener("click", () => {
    if (authPhase !== "idle") return;
    setAuthMode("forgot");
    showAuthError("");
    authEmail.focus();
  });
  byId("auth-done-back").addEventListener("click", () => {
    setAuthMode("signin");
    showAuthError("");
    authEmail.focus();
  });
  signInButton.addEventListener("click", () => openAuth({ opener: signInButton }));
  byId("library-sign-in").addEventListener("click", (event) => openAuth({ opener: event.currentTarget }));

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (authPhase !== "idle") return;
    const email = authEmail.value.trim();
    const password = authPassword.value;
    const forgot = authMode === "forgot";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return showAuthError("Enter a valid email address.", authEmail);
    if (!forgot && password.length < 8) return showAuthError(authMode === "signup" ? "Use at least 8 characters for your password." : "Enter your password (at least 8 characters).", authPassword);
    if (!forgot && password.length > 256) return showAuthError("Use 256 characters or fewer for your password.", authPassword);
    authCredentials = forgot ? { email } : { email, password };
    showAuthError("");
    setAuthPhase("verifying");
    authTimer = setTimeout(() => failAuth("Verification timed out. Please try again."), 120_000);
    try {
      const id = await ensureAuthWidget();
      if (authPhase !== "verifying") return;
      window.turnstile.execute(id);
    } catch (setupError) {
      failAuth(setupError.message || "Verification could not start. Please reload and try again.");
    }
  });

  async function submitAuth(turnstileToken) {
    setAuthPhase("submitting");
    const signup = authMode === "signup";
    const forgot = authMode === "forgot";
    try {
      const response = await apiRequest(forgot ? "/api/auth/password/forgot" : signup ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        body: { ...authCredentials, turnstileToken }
      });
      if (authPhase !== "submitting") return;
      if (!response.ok) {
        const failure = new Error(await failureMessage(response, response.status === 409
          ? "An account with this email already exists. Sign in or reset your password."
          : "Could not complete that request. Please try again."));
        failure.status = response.status;
        throw failure;
      }
      if (forgot) {
        // The server answers the same way whether or not the address has an account.
        const message = await responseData(response).then((data) => data.message, () => "");
        if (authPhase !== "submitting") return;
        setAuthPhase("idle");
        resetAuthWidget();
        showAuthDone(typeof message === "string" && message ? message : "If that address has an account, we’ve sent a link to reset the password.");
        announceAccount("Check your email for a reset link.");
        return;
      }
      const signedIn = parseUser((await responseData(response)).user);
      if (!signedIn) throw new Error("The service returned an incomplete response. Please try again.");
      if (authPhase !== "submitting") return;
      user = signedIn;
      const then = afterAuth;
      afterAuth = null;
      setAuthPhase("idle");
      resetAuthWidget();
      authDialog.close();
      renderAccount();
      announceAccount(`Signed in as ${user.email}.`);
      afterSessionChange();
      if (isLibraryView) void routeLibrary(false);
      else void refreshCounts();
      then?.();
    } catch (requestError) {
      failAuth(requestFailureMessage(requestError, "Could not complete that request. Please try again."), signup || forgot ? authEmail : authPassword);
      // A duplicate signup is recoverable in one click: offer sign in or a password reset.
      if (signup && requestError.status === 409 && authPhase === "idle") byId("auth-error-actions").hidden = false;
    }
  }

  // ---- Save to library ----------------------------------------------------------

  function renderSaveButton() {
    const brief = currentResult;
    // Signed out, a visible invitation explains how to keep the brief.
    byId("save-hint").hidden = !brief || Boolean(currentLibraryItem) || !accountKnown || Boolean(user) || !brief.share;
    if (!brief || currentLibraryItem) return;
    const saved = savedBriefs.has(brief);
    saveButton.disabled = !brief.share;
    saveButton.textContent = saved ? "Saved" : "Save";
    saveButton.classList.toggle("is-saved", saved);
    saveButton.setAttribute("aria-disabled", String(!brief.share || saved || savingInFlight === brief));
    byId("save-note").hidden = !saved;
  }

  async function saveBrief(brief) {
    if (!brief?.share || savingInFlight === brief || savedBriefs.has(brief)) return;
    if (!user) {
      openAuth({ opener: saveButton, then: () => { if (currentResult === brief) void saveBrief(brief); } });
      return;
    }
    savingInFlight = brief;
    renderSaveButton();
    actionStatus("save-status", "");
    try {
      const response = await apiRequest("/api/library", { method: "POST", body: { shareId: brief.share.url.split("/").pop() } });
      if (response.status === 401) {
        endSession();
        if (currentResult === brief) {
          actionStatus("save-status", "Your session expired. Sign in to save this brief.", true);
          openAuth({ opener: saveButton, then: () => { if (currentResult === brief) void saveBrief(brief); } });
        }
        return;
      }
      if (response.status === 404) {
        const message = await failureMessage(response, "This brief is no longer available to save. Summarize the video again.");
        if (currentResult === brief) {
          actionStatus("save-status", message, true);
          byId("regenerate-link").hidden = false;
        }
        return;
      }
      if (!response.ok) throw new Error(await failureMessage(response, "Could not save this brief. Please try again."));
      const data = await responseData(response);
      savedBriefs.add(brief);
      if (currentResult === brief) actionStatus("save-status", data.alreadySaved ? "This brief was already in your library." : "Saved to your library.");
      void refreshCounts();
    } catch (requestError) {
      if (currentResult === brief) actionStatus("save-status", requestFailureMessage(requestError, "Could not save this brief. Please try again."), true);
    } finally {
      if (savingInFlight === brief) savingInFlight = null;
      if (currentResult === brief) renderSaveButton();
    }
  }

  byId("save-hint-action").addEventListener("click", () => void saveBrief(currentResult));
  saveButton.addEventListener("click", () => {
    if (saveButton.getAttribute("aria-disabled") === "true") return;
    void saveBrief(currentResult);
  });

  // ---- Library ------------------------------------------------------------------

  let libraryFilter = "unread";
  let libraryRequest = 0;
  let itemBusy = false;
  const formatDate = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });

  function showLibraryPanel(name) {
    library.hidden = name === "item" || name === "loading";
    byId("library-list-view").hidden = name !== "list";
    byId("library-signed-out").hidden = name !== "signed-out";
    byId("library-error").hidden = name !== "error";
    error.hidden = true;
    if (name !== "item") {
      result.hidden = true;
      currentResult = null;
      currentLibraryItem = null;
      document.body.classList.remove("has-result");
    }
  }

  function showSignedOut(expired) {
    showLibraryPanel("signed-out");
    document.title = "Library | YT;DW";
    byId("library-signed-out-title").textContent = expired ? "Your session has ended" : "Sign in to see your library";
    byId("library-signed-out-detail").textContent = expired
      ? "Sign in again to keep reading your saved briefs."
      : "Saved briefs live in your account, ready to read later.";
  }

  function showLibraryError(title, message, linkLabel) {
    showLibraryPanel("error");
    byId("library-error-title").textContent = title;
    byId("library-error-message").textContent = message;
    byId("library-error").querySelector("a").textContent = linkLabel;
  }

  function navigateLibrary(path) {
    if (path !== location.pathname + location.search) history.pushState({}, "", path);
    void routeLibrary(true);
  }

  function renderLibraryList(items) {
    const list = byId("library-list");
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.className = "library-item";
      link.href = `/library?item=${encodeURIComponent(item.id)}`;
      link.dataset.libraryNav = "";
      const main = document.createElement("span");
      main.className = "library-item__main";
      const title = document.createElement("strong");
      title.className = "library-item__title";
      title.textContent = item.title;
      const meta = document.createElement("span");
      meta.className = "library-item__meta";
      meta.textContent = [item.uploader || "YouTube", formatDuration(item.duration), `Saved ${formatDate(item.savedAt)}`].join(" · ");
      main.append(title, meta);
      link.append(main);
      if (item.readAt === null) {
        const unread = document.createElement("span");
        unread.className = "library-item__unread";
        unread.title = "Unread";
        const label = document.createElement("span");
        label.className = "sr-only";
        label.textContent = "Unread";
        unread.append(label);
        link.append(unread);
      }
      li.append(link);
      return li;
    }));
    const empty = items.length === 0;
    byId("library-empty").hidden = !empty;
    if (empty) {
      const nothingSaved = libraryCounts?.all === 0;
      byId("library-empty-title").textContent = nothingSaved ? "Nothing saved yet" : "You’re all caught up";
      byId("library-empty-detail").textContent = nothingSaved
        ? "Summarize a video, then choose Save to keep its brief here."
        : "No unread briefs. Switch to All to see everything you’ve saved.";
    }
    byId("library-status").textContent = empty
      ? "No briefs in this list."
      : `${items.length} ${libraryFilter === "unread" ? "unread " : ""}${items.length === 1 ? "brief" : "briefs"}.`;
  }

  async function loadLibraryList(request, focus) {
    showLibraryPanel("list");
    document.title = "Library | YT;DW";
    for (const tab of document.querySelectorAll(".library-tab")) tab.setAttribute("aria-pressed", String(tab.dataset.filter === libraryFilter));
    const list = byId("library-list");
    list.setAttribute("aria-busy", "true");
    byId("library-status").textContent = "Loading your library…";
    if (focus) byId("library-title").focus({ preventScroll: true });
    try {
      const response = await apiRequest(`/api/library?filter=${libraryFilter}`);
      if (request !== libraryRequest) return;
      if (response.status === 401) {
        endSession();
        showSignedOut(true);
        return;
      }
      if (!response.ok) throw new Error(await failureMessage(response, "Please reload to try again."));
      const data = await responseData(response);
      if (request !== libraryRequest) return;
      if (!Array.isArray(data.items) || data.items.some((item) => !item || typeof item.id !== "string" || typeof item.title !== "string" ||
          !Number.isFinite(item.duration) || !Number.isFinite(item.savedAt))) {
        throw new Error("The service returned an incomplete library. Please try again.");
      }
      setCounts(data.counts);
      renderLibraryList(data.items);
    } catch (requestError) {
      if (request !== libraryRequest) return;
      showLibraryError("Could not load your library", requestFailureMessage(requestError, "Please try again."), "Try again");
    } finally {
      if (request === libraryRequest) list.setAttribute("aria-busy", "false");
    }
  }

  async function openLibraryItem(id, request) {
    showLibraryPanel("loading");
    showStatus("Opening the brief…", "Loading it from your library");
    try {
      const response = await apiRequest(`/api/library/${encodeURIComponent(id)}`);
      if (request !== libraryRequest) return;
      if (response.status === 401) {
        endSession();
        showSignedOut(true);
        return;
      }
      if (response.status === 404) {
        showLibraryError("Brief unavailable", "This brief is no longer in your library.", "Back to library");
        document.title = "Library | YT;DW";
        return;
      }
      if (!response.ok) throw new Error(await failureMessage(response, "Please reload to try again."));
      const { item } = await responseData(response);
      if (request !== libraryRequest) return;
      if (!item || typeof item.id !== "string") throw new Error("The service returned an incomplete brief. Please try again.");
      showLibraryPanel("item");
      showResult({
        id: item.videoId, title: item.title, uploader: item.uploader, duration: item.duration,
        summary: item.summary, transcriptTruncated: Boolean(item.transcriptTruncated), share: null
      }, { libraryItem: item });
    } catch (requestError) {
      if (request !== libraryRequest) return;
      showLibraryError("Could not open this brief", requestFailureMessage(requestError, "Please try again."), "Back to library");
    } finally {
      if (request === libraryRequest) {
        status.hidden = true;
        byId("process-announcement").textContent = "";
      }
    }
  }

  async function routeLibrary(focus) {
    const request = ++libraryRequest;
    if (!user) {
      showSignedOut(false);
      return;
    }
    const id = new URLSearchParams(location.search).get("item");
    if (id) await openLibraryItem(id, request);
    else await loadLibraryList(request, focus);
  }

  function renderLibraryItemState() {
    const item = currentLibraryItem;
    if (!item) return;
    const isRead = item.readAt !== null;
    readButton.textContent = isRead ? "Mark as unread" : "Mark as read";
    byId("library-meta").textContent = `Saved ${formatDate(item.savedAt)} · ${isRead ? "Read" : "Unread"}`;
  }

  for (const tab of document.querySelectorAll(".library-tab")) {
    tab.addEventListener("click", () => {
      if (tab.dataset.filter === libraryFilter || !user) return;
      libraryFilter = tab.dataset.filter;
      void loadLibraryList(++libraryRequest, false);
    });
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-library-nav]");
    if (!link || !isLibraryView || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateLibrary(link.getAttribute("href"));
  });
  window.addEventListener("popstate", () => { if (isLibraryView) void routeLibrary(true); });

  readButton.addEventListener("click", async () => {
    const item = currentLibraryItem;
    if (!item || itemBusy) return;
    const makeRead = item.readAt === null;
    itemBusy = true;
    readButton.setAttribute("aria-disabled", "true");
    actionStatus("item-status", "");
    try {
      const response = await apiRequest(`/api/library/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { read: makeRead } });
      if (response.status === 401) {
        endSession();
        if (currentLibraryItem === item) showSignedOut(true);
        return;
      }
      if (!response.ok) throw new Error(await failureMessage(response, "Could not update this brief. Please try again."));
      const data = await responseData(response);
      if (!data.item || (data.item.readAt !== null && !Number.isFinite(data.item.readAt))) throw new Error("The service returned an incomplete response. Please try again.");
      item.readAt = data.item.readAt;
      if (currentLibraryItem !== item) return;
      renderLibraryItemState();
      actionStatus("item-status", makeRead ? "Marked as read." : "Marked as unread.");
      void refreshCounts();
    } catch (requestError) {
      if (currentLibraryItem === item) actionStatus("item-status", requestFailureMessage(requestError, "Could not update this brief. Please try again."), true);
    } finally {
      itemBusy = false;
      readButton.setAttribute("aria-disabled", "false");
    }
  });

  const confirmDialog = byId("confirm-dialog");
  deleteButton.addEventListener("click", () => {
    if (!currentLibraryItem || itemBusy) return;
    byId("confirm-detail").textContent = `“${currentLibraryItem.title}” will be removed from your library. This can’t be undone.`;
    confirmDialog.showModal();
    byId("confirm-cancel").focus();
  });
  byId("confirm-cancel").addEventListener("click", () => {
    confirmDialog.close();
    deleteButton.focus();
  });
  confirmDialog.addEventListener("click", (event) => { if (event.target === confirmDialog) confirmDialog.close(); });
  byId("confirm-delete").addEventListener("click", async () => {
    const item = currentLibraryItem;
    if (!item || itemBusy) return;
    itemBusy = true;
    confirmDialog.close();
    deleteButton.setAttribute("aria-disabled", "true");
    actionStatus("item-status", "");
    try {
      const response = await apiRequest(`/api/library/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      if (response.status === 401) {
        endSession();
        if (currentLibraryItem === item) showSignedOut(true);
        return;
      }
      // 404 means it is already gone, which is the outcome the user wanted.
      if (!response.ok && response.status !== 404) throw new Error(await failureMessage(response, "Could not delete this brief. Please try again."));
      if (currentLibraryItem !== item) return;
      // Replace the item entry so Back doesn't reopen a deleted brief.
      history.replaceState({}, "", "/library");
      void routeLibrary(true);
      announceAccount("Brief deleted.");
    } catch (requestError) {
      if (currentLibraryItem === item) {
        actionStatus("item-status", requestFailureMessage(requestError, "Could not delete this brief. Please try again."), true);
        deleteButton.focus();
      }
    } finally {
      itemBusy = false;
      deleteButton.setAttribute("aria-disabled", "false");
    }
  });

  // ---- Email verification page --------------------------------------------------

  let verifyState = "pending"; // pending | success | invalid | error
  let verifyMessage = "";
  let verifyNote = "";
  let verifyResent = false;
  let verifyRequest = 0;

  function renderVerifyPage(focus = false) {
    if (!isVerifyView) return;
    const verifiedAlready = Boolean(user?.emailVerified);
    let title = "Verifying your email…";
    let detail = "One moment while we confirm your address.";
    if (verifyState === "success") {
      title = "Email verified";
      detail = verifyMessage || "Thanks. Your account can now be recovered if you ever forget your password.";
    } else if (verifyState === "invalid") {
      title = "This link didn’t work";
      detail = verifyMessage || invalidLinkMessage;
      if (verifyResent) detail = "Sent — check your inbox. The new link will replace this one.";
      else if (verifiedAlready) detail += " Your email is already verified.";
      else detail += user ? " We can send you a new one." : " Sign in to request a new one.";
    } else if (verifyState === "error") {
      title = "Could not verify your email";
      detail = verifyMessage;
    }
    if (verifyNote) detail += ` ${verifyNote}`;
    byId("verify-title").textContent = title;
    byId("verify-detail").textContent = detail;
    const invalid = verifyState === "invalid";
    byId("verify-continue").hidden = verifyState !== "success" && !(invalid && verifiedAlready);
    byId("verify-resend").hidden = !invalid || !user || verifiedAlready || verifyResent;
    byId("verify-sign-in").hidden = !invalid || Boolean(user) || !accountKnown;
    byId("verify-retry").hidden = verifyState !== "error";
    document.title = "Verify email | YT;DW";
    if (focus && !authDialog.open) byId("verify-title").focus();
  }

  async function runVerify() {
    const request = ++verifyRequest;
    verifyState = "pending";
    verifyNote = "";
    renderVerifyPage();
    if (!linkToken) {
      verifyState = "invalid";
      verifyMessage = invalidLinkMessage;
      renderVerifyPage(true);
      return;
    }
    try {
      const response = await apiRequest("/api/auth/verify", { method: "POST", body: { token: linkToken } });
      if (request !== verifyRequest) return;
      if (response.status === 400) {
        verifyState = "invalid";
        verifyMessage = await failureMessage(response, invalidLinkMessage);
      } else if (!response.ok) {
        throw new Error(await failureMessage(response, "Please try again."));
      } else {
        const verified = parseUser((await responseData(response).catch(() => ({}))).user);
        if (user && verified) user = verified;
        if (user) user.emailVerified = true;
        verifyState = "success";
        verifyMessage = "";
        renderAccount();
      }
    } catch (requestError) {
      if (request !== verifyRequest) return;
      verifyState = "error";
      verifyMessage = requestFailureMessage(requestError, "Please try again.");
    }
    renderVerifyPage(true);
    announceAccount(verifyState === "success" ? "Email verified." : verifyState === "invalid" ? "This verification link is invalid or has expired." : "Could not verify your email.");
  }

  byId("verify-retry").addEventListener("click", () => void runVerify());
  byId("verify-sign-in").addEventListener("click", (event) => openAuth({ opener: event.currentTarget }));
  byId("verify-resend").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.getAttribute("aria-disabled") === "true") return;
    button.setAttribute("aria-disabled", "true");
    verifyNote = "";
    const { outcome, message } = await requestResend();
    button.setAttribute("aria-disabled", "false");
    if (outcome === "sent") {
      verifyResent = true;
      announceAccount("Verification email sent. Check your inbox.");
    } else if (outcome === "verified") {
      verifyState = "success";
      verifyMessage = "Your email is already verified.";
      announceAccount("Your email is already verified.");
    } else if (outcome === "signed-out") {
      announceAccount("Your session has ended. Sign in again.");
    } else {
      verifyNote = message;
      announceAccount(message);
    }
    renderVerifyPage(true);
  });

  // ---- Password reset page ------------------------------------------------------

  const resetForm = byId("reset-form");
  const resetField = byId("reset-password");
  const resetSubmit = byId("reset-submit");
  let resetBusy = false;

  // Page forms share one error pattern: a role=alert message plus aria-invalid on the culprit.
  function showFormMessage(id, text, field) {
    const element = byId(id);
    element.textContent = text;
    element.hidden = !text;
    element.closest("form")?.querySelectorAll("input").forEach((input) => input.removeAttribute("aria-invalid"));
    if (text && field) {
      field.setAttribute("aria-invalid", "true");
      field.focus();
    }
  }

  function showResetInvalid(message) {
    resetForm.hidden = true;
    byId("reset-invalid").hidden = false;
    byId("reset-title").textContent = "This link didn’t work";
    byId("reset-invalid-detail").textContent = `${message} Request a new link to choose a new password.`;
    document.title = "Reset password | YT;DW";
    byId("reset-title").focus();
  }

  function startResetPage() {
    byId("reset-page").hidden = false;
    document.title = "Reset password | YT;DW";
    if (!linkToken) showResetInvalid(invalidLinkMessage);
    else resetField.focus();
  }

  resetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (resetBusy) return;
    const password = resetField.value;
    if (password.length < 8) return showFormMessage("reset-error", "Use at least 8 characters for your password.", resetField);
    if (password.length > 256) return showFormMessage("reset-error", "Use 256 characters or fewer for your password.", resetField);
    showFormMessage("reset-error", "");
    resetBusy = true;
    resetField.readOnly = true;
    resetSubmit.setAttribute("aria-disabled", "true");
    resetSubmit.textContent = "Resetting…";
    let navigating = false;
    try {
      const response = await apiRequest("/api/auth/password/reset", { method: "POST", body: { token: linkToken, password } });
      if (response.status === 400) {
        const message = await failureMessage(response, invalidLinkMessage);
        // Only a rejected link retires the form; a rejected password can be corrected in place.
        if (/link|expired/i.test(message)) return showResetInvalid(message);
        throw new Error(message);
      }
      if (!response.ok) throw new Error(await failureMessage(response, "Could not reset your password. Please try again."));
      const signedIn = parseUser((await responseData(response)).user);
      if (!signedIn) throw new Error("The service returned an incomplete response. Please try again.");
      user = signedIn;
      renderAccount();
      announceAccount("Password updated. Signing you in.");
      // A full navigation re-reads the new session and renders the library from scratch.
      navigating = true;
      location.replace("/library");
    } catch (requestError) {
      showFormMessage("reset-error", requestFailureMessage(requestError, "Could not reset your password. Please try again."), resetField);
    } finally {
      if (!navigating) {
        resetBusy = false;
        resetField.readOnly = false;
        resetSubmit.setAttribute("aria-disabled", "false");
        resetSubmit.textContent = "Reset password";
      }
    }
  });
  byId("reset-request").addEventListener("click", (event) => openAuth({ mode: "forgot", opener: event.currentTarget }));

  // ---- Account page -------------------------------------------------------------

  const passwordForm = byId("password-form");
  const deleteForm = byId("delete-form");
  const deleteDialog = byId("delete-account-dialog");
  let passwordBusy = false;
  let deleteBusy = false;
  let deleteFocus = null;

  function renderAccountPage(focus = false) {
    if (!isAccountView) return;
    byId("account-signed-out").hidden = Boolean(user) || !accountKnown;
    byId("account-settings").hidden = !user;
    document.title = "Account | YT;DW";
    if (user) {
      byId("account-page-email").textContent = user.email;
      byId("account-page-status").textContent = user.emailVerified ? "Verified" : "Not verified";
    } else {
      // Nothing typed here should survive signing out.
      passwordForm.reset();
      deleteForm.reset();
      for (const id of ["password-error", "password-success", "delete-error"]) showFormMessage(id, "");
    }
    if (focus && !authDialog.open) byId("account-title").focus();
  }

  function startAccountPage() {
    byId("account-page").hidden = false;
    renderAccountPage();
  }

  byId("account-sign-in").addEventListener("click", (event) => openAuth({ opener: event.currentTarget }));

  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (passwordBusy) return;
    const currentField = byId("current-password");
    const newField = byId("new-password");
    const currentPassword = currentField.value;
    const newPassword = newField.value;
    byId("password-success").hidden = true;
    if (!currentPassword) return showFormMessage("password-error", "Enter your current password.", currentField);
    if (newPassword.length < 8) return showFormMessage("password-error", "Use at least 8 characters for your new password.", newField);
    if (newPassword.length > 256) return showFormMessage("password-error", "Use 256 characters or fewer for your new password.", newField);
    showFormMessage("password-error", "");
    passwordBusy = true;
    const submit = byId("password-submit");
    submit.setAttribute("aria-disabled", "true");
    submit.textContent = "Changing…";
    try {
      const response = await apiRequest("/api/auth/password/change", { method: "POST", body: { currentPassword, newPassword } });
      if (response.status === 401) {
        endSession();
        announceAccount("Your session has ended. Sign in again.");
        return;
      }
      if (response.status === 403) {
        showFormMessage("password-error", await failureMessage(response, "Current password is incorrect."), currentField);
        return;
      }
      if (!response.ok) throw new Error(await failureMessage(response, "Could not change your password. Please try again."));
      const updated = parseUser((await responseData(response).catch(() => ({}))).user);
      if (updated) user = updated;
      passwordForm.reset();
      byId("password-success").textContent = "Password changed.";
      byId("password-success").hidden = false;
      announceAccount("Password changed.");
    } catch (requestError) {
      showFormMessage("password-error", requestFailureMessage(requestError, "Could not change your password. Please try again."));
    } finally {
      passwordBusy = false;
      submit.setAttribute("aria-disabled", "false");
      submit.textContent = "Change password";
    }
  });

  deleteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (deleteBusy) return;
    const field = byId("delete-password");
    if (!field.value) return showFormMessage("delete-error", "Enter your password to delete your account.", field);
    showFormMessage("delete-error", "");
    deleteDialog.showModal();
    byId("delete-account-cancel").focus();
  });
  byId("delete-account-cancel").addEventListener("click", () => { if (!deleteBusy) deleteDialog.close(); });
  deleteDialog.addEventListener("click", (event) => { if (event.target === deleteDialog && !deleteBusy) deleteDialog.close(); });
  // Escape must not dismiss the dialog while the deletion request is in flight.
  deleteDialog.addEventListener("cancel", (event) => { if (deleteBusy) event.preventDefault(); });
  deleteDialog.addEventListener("close", () => {
    const target = deleteFocus ?? byId("delete-submit");
    deleteFocus = null;
    if (user) target.focus();
  });
  byId("delete-account-confirm").addEventListener("click", async (event) => {
    if (deleteBusy) return;
    const confirm = event.currentTarget;
    const cancel = byId("delete-account-cancel");
    const field = byId("delete-password");
    deleteBusy = true;
    confirm.setAttribute("aria-disabled", "true");
    cancel.setAttribute("aria-disabled", "true");
    confirm.textContent = "Deleting…";
    let navigating = false;
    try {
      const response = await apiRequest("/api/account/delete", { method: "POST", body: { password: field.value } });
      if (response.status === 401) {
        deleteDialog.close();
        endSession();
        announceAccount("Your session has ended. Sign in again.");
        return;
      }
      if (response.status === 403) {
        deleteFocus = field;
        deleteDialog.close();
        showFormMessage("delete-error", await failureMessage(response, "Password is incorrect."), field);
        return;
      }
      if (!response.ok) throw new Error(await failureMessage(response, "Could not delete your account. Please try again."));
      announceAccount("Account deleted.");
      // The session is gone server-side; a full navigation drops all signed-in state.
      navigating = true;
      location.replace("/");
    } catch (requestError) {
      deleteDialog.close();
      showFormMessage("delete-error", requestFailureMessage(requestError, "Could not delete your account. Please try again."));
    } finally {
      if (!navigating) {
        deleteBusy = false;
        confirm.setAttribute("aria-disabled", "false");
        cancel.setAttribute("aria-disabled", "false");
        confirm.textContent = "Delete account";
      }
    }
  });

  // ---- Init ---------------------------------------------------------------------

  // The duplicate-signup notice email links to /?auth=forgot, and share pages link to
  // /?ref=share. Consume both right away so a reload doesn't reopen the dialog or count
  // the visit twice; other params (such as ?url=) are left alone.
  const startParams = new URLSearchParams(location.search);
  const wantsForgot = startParams.get("auth") === "forgot";
  if (startParams.get("ref") === "share") countEvent("share_visit");
  if (startParams.has("auth") || startParams.has("ref")) {
    startParams.delete("auth");
    startParams.delete("ref");
    const rest = startParams.toString();
    history.replaceState({}, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  }

  const accountLoaded = loadAccount();
  void accountLoaded.then(() => {
    if (wantsForgot && !user) openAuth({ mode: "forgot", opener: signInButton });
  });
  if (isLibraryView) {
    libraryLink.dataset.libraryNav = "";
    void accountLoaded.then(() => routeLibrary(false));
  } else if (isSharedView) {
    void loadSharedBrief();
  } else if (isVerifyView) {
    byId("verify-page").hidden = false;
    void runVerify();
  } else if (isResetView) {
    startResetPage();
  } else if (isAccountView) {
    startAccountPage();
  } else {
    input.value = new URLSearchParams(location.search).get("url") || "";
    setSubmitState();
    void setupVerification();
  }
})();

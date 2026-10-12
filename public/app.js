(() => {
  const byId = (id) => document.getElementById(id);
  const isSharedView = location.pathname.startsWith("/s/");
  const isLibraryView = location.pathname === "/library";
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

  function showResult(data, { libraryItem = null } = {}) {
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
      : "Sharing and saving are temporarily unavailable. You can still copy this brief.";
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
    shareButton.disabled = !data.share;
    copyButton.disabled = false;
    shareButton.setAttribute("aria-disabled", String(!data.share));
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
    // Library items reuse this article but swap Share/Save for read-state and delete.
    for (const button of [shareButton, saveButton]) button.hidden = Boolean(libraryItem);
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
    return value && typeof value.email === "string" && value.email ? { email: value.email } : null;
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
  }

  async function loadAccount() {
    try {
      const response = await apiRequest("/api/auth/me", { timeout: 10_000 });
      if (response.ok) user = parseUser((await responseData(response)).user);
    } catch {}
    accountKnown = true;
    renderAccount();
    renderSaveButton();
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

  // ---- Auth dialog --------------------------------------------------------------

  let authMode = "signin";
  let authPhase = "idle";
  let authOpener = null;
  let authCredentials = null;
  let authTimer;
  let afterAuth = null;
  let authWidgetId;
  let authWidgetPromise;

  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === "signup";
    byId("auth-title").textContent = signup ? "Create account" : "Sign in";
    byId("auth-lede").textContent = signup ? "Create an account to save briefs and read them later." : "Sign in to save briefs and read them later.";
    authSubmit.textContent = signup ? "Create account" : "Sign in";
    byId("auth-switch-prompt").textContent = signup ? "Already have an account?" : "New here?";
    byId("auth-switch").textContent = signup ? "Sign in" : "Create an account";
    byId("auth-hint").hidden = !signup;
    authPassword.autocomplete = signup ? "new-password" : "current-password";
  }

  function showAuthError(message, field) {
    const element = byId("auth-error");
    element.textContent = message;
    element.hidden = !message;
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
    authSubmit.textContent = next === "verifying" ? "Verifying…" : next === "submitting" ? (signup ? "Creating account…" : "Signing in…") : (signup ? "Create account" : "Sign in");
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

  function openAuth({ mode = "signin", opener = document.activeElement, then = null } = {}) {
    if (authDialog.open) return;
    authOpener = opener;
    afterAuth = then;
    setAuthMode(mode);
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
    const target = opener?.isConnected && opener.getClientRects().length ? opener
      : isLibraryView && byId("library-title").getClientRects().length ? byId("library-title")
      : user && accountMenu.getClientRects().length ? accountMenu.querySelector("summary") : null;
    target?.focus();
  });
  authDialog.addEventListener("click", (event) => { if (event.target === authDialog) authDialog.close(); });
  byId("auth-close").addEventListener("click", () => authDialog.close());
  byId("auth-switch").addEventListener("click", () => {
    if (authPhase !== "idle") return;
    setAuthMode(authMode === "signup" ? "signin" : "signup");
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return showAuthError("Enter a valid email address.", authEmail);
    if (password.length < 8) return showAuthError(authMode === "signup" ? "Use at least 8 characters for your password." : "Enter your password (at least 8 characters).", authPassword);
    if (password.length > 256) return showAuthError("Use 256 characters or fewer for your password.", authPassword);
    authCredentials = { email, password };
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
    try {
      const response = await apiRequest(signup ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        body: { ...authCredentials, turnstileToken }
      });
      if (authPhase !== "submitting") return;
      if (!response.ok) throw new Error(await failureMessage(response, "Could not complete that request. Please try again."));
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
      if (isLibraryView) void routeLibrary(false);
      else void refreshCounts();
      then?.();
    } catch (requestError) {
      failAuth(requestFailureMessage(requestError, "Could not complete that request. Please try again."), signup ? authEmail : authPassword);
    }
  }

  // ---- Save to library ----------------------------------------------------------

  function renderSaveButton() {
    const brief = currentResult;
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

  if (isLibraryView) {
    libraryLink.dataset.libraryNav = "";
    void loadAccount().then(() => routeLibrary(false));
  } else {
    void loadAccount();
    if (isSharedView) void loadSharedBrief();
    else {
      input.value = new URLSearchParams(location.search).get("url") || "";
      setSubmitState();
      void setupVerification();
    }
  }
})();

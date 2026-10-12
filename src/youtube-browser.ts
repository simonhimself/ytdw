import puppeteer from "@cloudflare/puppeteer";

// Browser Rendering path for video metadata and caption URLs. A plain Worker
// request to YouTube's player API is bot-walled, but the same request made from
// inside a loaded watch page (with that page's cookies and visitor data)
// succeeds. The IOS client is used because its caption URLs need no PO token;
// ANDROID_VR returned LOGIN_REQUIRED for most videos in this context. Validated
// on 16 videos (2026-10-12); see TEST_RESULTS.md. Expect YouTube to change
// this: callers must treat any failure as "use the Sandbox fallback".

const IOS_CLIENT = {
  clientName: "IOS",
  clientVersion: "20.10.4",
  deviceMake: "Apple",
  deviceModel: "iPhone16,2",
  osName: "iPhone",
  osVersion: "18.3.2.22D82",
};
const IOS_CLIENT_ID = 5;

export interface PlayerTrack {
  languageCode: string;
  kind?: string;
  baseUrl: string;
}

export interface BrowserPlayerResponse {
  status?: string;
  reason?: string;
  videoId?: string;
  title?: string;
  lengthSeconds?: string;
  author?: string;
  tracks: PlayerTrack[];
  translatableToEnglish: boolean;
}

function withTimeout<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(0, deadline - Date.now()));
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function fetchPlayerResponse(
  binding: Parameters<typeof puppeteer.launch>[0],
  videoId: string,
  timeoutMs: number,
): Promise<BrowserPlayerResponse> {
  const deadline = Date.now() + timeoutMs;
  const launching = puppeteer.launch(binding);
  let browser: Awaited<typeof launching>;
  try {
    browser = await withTimeout(launching, deadline, "Browser launch");
  } catch (error) {
    // A launch that finishes after the timeout must not hold a browser slot.
    launching.then((late) => late.close()).catch(() => {});
    throw error;
  }
  try {
    const page = await browser.newPage();
    // Only the watch page's HTML and scripts are needed.
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const type = request.resourceType();
      if (type === "image" || type === "media" || type === "font" || request.url().includes("googlevideo.com")) {
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });
    // Pre-answer the EU consent interstitial.
    await page.setCookie(
      { name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/" },
      { name: "CONSENT", value: "YES+cb", domain: ".youtube.com", path: "/" },
    );
    await page.goto(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1000, deadline - Date.now()),
    });
    return await withTimeout(page.evaluate(async (id: string, client: typeof IOS_CLIENT, clientId: number) => {
      // Runs in the page: globalThis is YouTube's window.
      const config = (globalThis as unknown as { ytcfg?: { get?: (key: string) => unknown } }).ytcfg;
      const visitorData = config?.get?.("VISITOR_DATA");
      const key = config?.get?.("INNERTUBE_API_KEY");
      const response = await fetch(`/youtubei/v1/player?prettyPrint=false${typeof key === "string" ? `&key=${key}` : ""}`, {
        // Same-origin request, so the page's cookies are sent by default.
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-youtube-client-name": String(clientId),
          "x-youtube-client-version": client.clientVersion,
        },
        body: JSON.stringify({
          context: { client: { ...client, hl: "en", gl: "US", visitorData } },
          videoId: id,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      });
      const player: any = await response.json().catch(() => null);
      const renderer = player?.captions?.playerCaptionsTracklistRenderer;
      return {
        status: player?.playabilityStatus?.status,
        reason: player?.playabilityStatus?.reason,
        videoId: player?.videoDetails?.videoId,
        title: player?.videoDetails?.title,
        lengthSeconds: player?.videoDetails?.lengthSeconds,
        author: player?.videoDetails?.author,
        tracks: (renderer?.captionTracks ?? []).filter((track: any) => typeof track?.baseUrl === "string" && typeof track?.languageCode === "string")
          .map((track: any) => ({ languageCode: track.languageCode, kind: track.kind, baseUrl: track.baseUrl })),
        translatableToEnglish: (renderer?.translationLanguages ?? []).some((language: any) => language?.languageCode === "en"),
      };
    }, videoId, IOS_CLIENT, IOS_CLIENT_ID), deadline, "Player request");
  } finally {
    await browser.close().catch(() => {});
  }
}

import { BadRequestError } from "./http";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

// Shared by the website (/api/summarize), the Coordinator, and the queue so every
// path accepts exactly the same URLs. Returns the canonical watch URL.
export function normalizeYouTubeUrl(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new BadRequestError("Enter a YouTube video URL");
  }

  let videoUrl: URL;
  try {
    videoUrl = new URL(value);
  } catch {
    throw new BadRequestError("Enter a valid YouTube video URL");
  }
  if (videoUrl.protocol !== "https:" || !YOUTUBE_HOSTS.has(videoUrl.hostname)) {
    throw new BadRequestError("Only HTTPS YouTube video URLs are accepted");
  }

  let videoId: string | null = null;
  if (videoUrl.hostname === "youtu.be") {
    videoId = videoUrl.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (videoUrl.pathname === "/watch") {
    videoId = videoUrl.searchParams.get("v");
  } else {
    const match = videoUrl.pathname.match(/^\/(?:embed|shorts)\/([^/]+)$/);
    videoId = match?.[1] ?? null;
  }

  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new BadRequestError("Enter a valid YouTube video URL");
  }

  return `https://www.youtube.com/watch?v=${videoId}`;
}

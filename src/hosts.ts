// Workers Previews are served at <preview-name>.<suffix> (e.g. feat-x.previews.ytdw.fyi).
// A hostname counts as a Preview host only when it is exactly ONE DNS label of
// [a-z0-9-] followed by "." and the suffix. No normalisation is applied here:
// uppercase, trailing dots, extra labels, and lookalikes such as
// "x.previews.ytdw.fyi.evil.com" are all rejected. Request hostnames are already
// lowercased by URL parsing, and Siteverify reports lowercase hostnames.
const LABEL = /^[a-z0-9-]+$/;
const SUFFIX = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function isPreviewHost(hostname: unknown, suffix: unknown): hostname is string {
  if (typeof hostname !== "string" || typeof suffix !== "string" || !SUFFIX.test(suffix)) return false;
  const tail = `.${suffix}`;
  if (!hostname.endsWith(tail)) return false;
  return LABEL.test(hostname.slice(0, -tail.length));
}

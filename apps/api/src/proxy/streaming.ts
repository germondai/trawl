// Adaptive buffer-vs-stream decision for the MITM proxy.
//
// Goal: keep memory footprint low for big binaries (videos, archives, ISO images)
// while still letting small JSON/HTML/text responses round-trip through the
// challenge detector in a single Buffer - which is required because Tier 0
// (direct forward) only knows whether the response is CF-challenged after it
// has the body to inspect.
//
// Decision precedence:
//   1. Unknown Content-Length + binary-looking Content-Type → stream (safer).
//   2. Content-Length >= STREAM_THRESHOLD_BYTES → stream.
//   3. Content-Type starts with video/ or audio/ → stream.
//   4. URL extension matches a known binary container → stream.
//   5. Otherwise → buffer.

export const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024 // 8 MiB

// URL extensions that are almost always large binaries worth streaming.
// Audio/video and HLS manifests are streamed even below the size threshold
// because chunked transport is the whole point of those protocols.
const STREAM_EXTENSIONS =
  /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v|mp3|flac|wav|ogg|opus|aac|m4a|aif|ts|m3u8|mpd|hls|exe|zip|dmg|iso|img|tar|gz|tgz|bz2|xz|7z|rar|pkg|deb|rpm|apk|ipa|msi|pdf|woff2?|ttf|otf|eot)(?:\?|$|#)/i

export interface StreamDecision {
  stream: boolean
  reason:
    | "size-threshold"
    | "video-content-type"
    | "audio-content-type"
    | "binary-extension"
    | "unknown-length-binary"
    | "default-buffer"
}

export function shouldStream(url: string, contentLength?: number, contentType?: string): StreamDecision {
  const ct = (contentType ?? "").toLowerCase()
  const ctBase = ct.split(";")[0]?.trim() ?? ""

  // 1. Unknown length with binary-looking type → stream to avoid buffering
  // multi-gigabyte downloads into RAM.
  if ((contentLength === undefined || Number.isNaN(contentLength)) && ctBase) {
    if (
      ctBase.startsWith("video/") ||
      ctBase.startsWith("audio/") ||
      ctBase === "application/octet-stream" ||
      ctBase === "application/pdf" ||
      ctBase.startsWith("application/zip") ||
      ctBase === "application/x-7z-compressed" ||
      ctBase === "application/x-rar-compressed" ||
      ctBase === "application/x-tar" ||
      ctBase === "application/x-bittorrent"
    ) {
      return { stream: true, reason: "unknown-length-binary" }
    }
  }

  // 2. Size threshold.
  if (typeof contentLength === "number" && contentLength >= STREAM_THRESHOLD_BYTES) {
    return { stream: true, reason: "size-threshold" }
  }

  // 3/4. Video/audio content-type.
  if (ctBase.startsWith("video/")) return { stream: true, reason: "video-content-type" }
  if (ctBase.startsWith("audio/")) return { stream: true, reason: "audio-content-type" }

  // 5. Known binary extension in URL.
  if (STREAM_EXTENSIONS.test(url)) return { stream: true, reason: "binary-extension" }

  return { stream: false, reason: "default-buffer" }
}

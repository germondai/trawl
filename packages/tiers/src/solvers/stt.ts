// Speech-to-text for audio CAPTCHA solving (reCAPTCHA v2 and AWS WAF).
//
// Default (zero-cost, no key): uses Google's own free Speech Recognition endpoint.
// Google's reCAPTCHA audio is designed for screen-reader accessibility — their own
// STT transcribes it well. We download the audio, convert it to FLAC via ffmpeg
// (ships in the Docker image), and POST to Google's endpoint. No billing, no signup.
// This is the same technique the open-source Buster accessibility extension uses.
//
// Optional (bring-your-own): set STT_URL to any Whisper-compatible HTTP server.
// Free local options (run in Docker alongside TRAWL):
//   whisper.cpp:            STT_URL=http://localhost:8080/inference
//   faster-whisper-server:  STT_URL=http://localhost:8000/v1/audio/transcriptions

import { randomUUID } from "node:crypto"
import { $ } from "bun"

const STT_URL = process.env.STT_URL ?? ""
const STT_KEY = process.env.STT_API_KEY ?? ""
// FFMPEG_PATH: full path to ffmpeg binary. Docker installs 'ffmpeg' via apt.
// On macOS with Playwright's bundled binary it's named 'ffmpeg-mac'; set this
// env var or create a symlink to make 'ffmpeg' resolve.
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg"

// Google's public Speech API key — used in Google's own demos and the Buster extension.
// Has been public since 2013. Google can't revoke it without breaking their own accessibility tooling.
const GOOGLE_STT =
  "https://www.google.com/speech-api/v2/recognize?output=json&lang=en-US&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw"

export async function transcribeAudio(audioUrl: string, signal?: AbortSignal): Promise<string | undefined> {
  return STT_URL ? transcribeWhisper(audioUrl, signal) : transcribeGoogle(audioUrl, signal)
}

async function transcribeWhisper(audioUrl: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(audioUrl, {
      signal,
      headers: audioFetchHeaders(audioUrl),
    })
    if (!res.ok) return

    const form = new FormData()
    const audio = await res.blob()
    form.append("file", audio, audioFilename(audio.type))
    form.append("model", "whisper-1")
    form.append("language", "en")
    form.append("response_format", "text")

    const headers: Record<string, string> = {}
    if (STT_KEY) headers.Authorization = `Bearer ${STT_KEY}`

    const sttRes = await fetch(STT_URL, { method: "POST", headers, body: form, signal })
    if (!sttRes.ok) return
    return clean(await sttRes.text())
  } catch {
    return
  }
}

// Converts the source audio → FLAC via ffmpeg, then sends it to Google's free Speech API.
// Tries 8000 Hz first (reCAPTCHA audio is typically low-bitrate), then 16000 Hz.
async function transcribeGoogle(audioUrl: string, signal?: AbortSignal): Promise<string | undefined> {
  const id = randomUUID().slice(0, 8)
  const input = `/tmp/trawl-${id}.audio`
  const flac8 = `/tmp/trawl-${id}-8k.flac`
  const flac16 = `/tmp/trawl-${id}-16k.flac`
  try {
    const res = await fetch(audioUrl, {
      signal,
      headers: audioFetchHeaders(audioUrl),
    })
    if (!res.ok) {
      console.log("[stt] audio download failed:", res.status)
      return
    }
    const audioBytes = await res.arrayBuffer()
    console.log("[stt] audio downloaded:", audioBytes.byteLength, "bytes, type:", res.headers.get("content-type"))
    if (audioBytes.byteLength < 1000) {
      console.log("[stt] audio too small")
      return
    }
    await Bun.write(input, audioBytes)

    // Try both sample rates — reCAPTCHA audio varies (8kHz native, 16kHz after processing)
    for (const [rate, flac] of [
      [8000, flac8],
      [16000, flac16],
    ] as [number, string][]) {
      const ff = await $`${FFMPEG} -i ${input} -ar ${rate} -ac 1 -c:a flac ${flac} -y -loglevel error`.nothrow()
      if (ff.exitCode !== 0) {
        console.log(`[stt] ffmpeg ${rate}Hz error:`, ff.stderr.toString().trim().slice(0, 120))
        continue
      }
      const flacData = await Bun.file(flac).arrayBuffer()
      console.log(`[stt] flac@${rate}Hz size:`, flacData.byteLength, "bytes")
      if (flacData.byteLength < 500) continue

      const sttRes = await fetch(`${GOOGLE_STT}`, {
        method: "POST",
        headers: { "Content-Type": `audio/x-flac; rate=${rate}` },
        body: flacData,
        signal,
      })
      if (!sttRes.ok) {
        console.log("[stt] Google STT failed:", sttRes.status)
        continue
      }

      const raw = await sttRes.text()
      console.log("[stt] raw response:", raw.slice(0, 300))

      for (const line of raw.split("\n").reverse()) {
        if (!line.startsWith("{")) continue
        try {
          const j = JSON.parse(line) as { result?: Array<{ alternative?: Array<{ transcript?: string }> }> }
          const t = j?.result?.[0]?.alternative?.[0]?.transcript
          if (t) {
            const cleaned = clean(t)
            console.log("[stt] raw transcript:", JSON.stringify(t), "→", JSON.stringify(cleaned))
            if (cleaned) return cleaned
            // transcript exists but cleaned to empty — try next rate
          }
        } catch {}
      }
    }
    return
  } catch (err) {
    console.log("[stt] error:", err instanceof Error ? err.message : err)
    return
  } finally {
    await $`rm -f ${input} ${flac8} ${flac16}`.nothrow().catch(() => {})
  }
}

function audioFetchHeaders(audioUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
    Accept: "audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,application/ogg;q=0.7,video/*;q=0.6,*/*;q=0.5",
    "Accept-Language": "en-US,en;q=0.5",
  }
  if (/google\.com\/recaptcha|recaptcha\.net/i.test(audioUrl)) {
    headers.Referer = "https://www.google.com/recaptcha/api2/bframe"
  }
  return headers
}

function audioFilename(contentType: string): string {
  if (/aac|mp4/i.test(contentType)) return "audio.aac"
  if (/wav/i.test(contentType)) return "audio.wav"
  if (/ogg/i.test(contentType)) return "audio.ogg"
  if (/webm/i.test(contentType)) return "audio.webm"
  return "audio.mp3"
}

// Accessibility challenges are word/phrase-based. Keep the full answer and
// normalize only case and whitespace before submitting it to the widget.
function clean(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ")
}

// Speech-to-text for audio CAPTCHA solving (reCAPTCHA v2 and AWS WAF).
//
// Default (zero-cost, no key): uses Google's own free Speech Recognition endpoint.
// We download the audio, convert it to FLAC via ffmpeg (shipped in the Docker
// image), and POST it to Google's endpoint. No billing or signup is required.
//
// Optional (bring-your-own): set STT_URL to any Whisper-compatible HTTP server.
// Free local options (run in Docker alongside TRAWL):
//   whisper.cpp:            STT_URL=http://localhost:8080/inference
//   faster-whisper-server:  STT_URL=http://localhost:8000/v1/audio/transcriptions

import { randomUUID } from "node:crypto"
import { $ } from "bun"

const STT_URL = process.env.STT_URL ?? ""
const STT_KEY = process.env.STT_API_KEY ?? ""
// FFMPEG_PATH: full path to ffmpeg binary. Docker installs `ffmpeg` via apt.
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg"

// Google's public Speech API key — used in Google's own demos and the Buster extension.
const GOOGLE_STT =
  "https://www.google.com/speech-api/v2/recognize?output=json&lang=en-US&maxresults=10&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw"

export type AudioChallengeKind = "generic" | "aws-waf"

export interface TranscribeAudioOptions {
  challenge?: AudioChallengeKind
}

interface AudioPayload {
  bytes: Uint8Array
  contentType: string
}

export interface GoogleTranscriptAlternative {
  transcript?: string
  confidence?: number
}

export async function transcribeAudio(
  audioUrl: string,
  signal?: AbortSignal,
  options: TranscribeAudioOptions = {},
): Promise<string | undefined> {
  return STT_URL
    ? transcribeWhisper(audioUrl, signal)
    : transcribeGoogle(audioUrl, signal, options.challenge ?? "generic")
}

async function transcribeWhisper(audioUrl: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const audio = await loadAudioSource(audioUrl, signal)
    if (!audio || audio.bytes.byteLength < 1000) {
      console.log("[stt] Whisper audio download was empty or too small")
      return
    }

    const form = new FormData()
    const blob = new Blob([Uint8Array.from(audio.bytes)], { type: audio.contentType })
    form.append("file", blob, audioFilename(audio.contentType))
    form.append("model", "whisper-1")
    form.append("language", "en")
    form.append("response_format", "text")

    const headers: Record<string, string> = {}
    if (STT_KEY) headers.Authorization = `Bearer ${STT_KEY}`

    const sttRes = await fetch(STT_URL, { method: "POST", headers, body: form, signal })
    if (!sttRes.ok) {
      console.log("[stt] Whisper endpoint failed:", sttRes.status)
      return
    }
    const transcript = clean(await sttRes.text())
    if (!transcript) console.log("[stt] Whisper endpoint returned an empty transcript")
    return transcript || undefined
  } catch (err) {
    console.log("[stt] Whisper error:", err instanceof Error ? err.message : err)
    return
  }
}

// Converts the source audio to FLAC, then sends it to Google's free Speech API.
async function transcribeGoogle(
  audioUrl: string,
  signal: AbortSignal | undefined,
  challenge: AudioChallengeKind,
): Promise<string | undefined> {
  const id = randomUUID().slice(0, 8)
  const input = `/tmp/trawl-${id}.audio`
  const flac8 = `/tmp/trawl-${id}-8k.flac`
  const flac16 = `/tmp/trawl-${id}-16k.flac`
  try {
    const audio = await loadAudioSource(audioUrl, signal)
    if (!audio) return
    console.log("[stt] audio downloaded:", audio.bytes.byteLength, "bytes, type:", audio.contentType)
    if (audio.bytes.byteLength < 1000) {
      console.log("[stt] audio too small")
      return
    }
    await Bun.write(input, audio.bytes)

    // AWS WAF serves native 16 kHz AAC; downsampling it first loses information
    // from its deliberately noisy track. Query both rates for AWS because the
    // adversarial mix can produce materially different alternatives; reCAPTCHA
    // remains more reliable at 8 kHz and returns on its first usable result.
    const awsAlternatives: GoogleTranscriptAlternative[] = []
    for (const rate of googleSampleRates(audio.contentType, challenge)) {
      const flac = rate === 16_000 ? flac16 : flac8
      const ff = await $`${FFMPEG} -i ${input} -ar ${rate} -ac 1 -c:a flac ${flac} -y -loglevel error`.nothrow()
      if (ff.exitCode !== 0) {
        console.log(`[stt] ffmpeg ${rate}Hz error:`, ff.stderr.toString().trim().slice(0, 120))
        continue
      }
      const flacData = await Bun.file(flac).arrayBuffer()
      console.log(`[stt] flac@${rate}Hz size:`, flacData.byteLength, "bytes")
      if (flacData.byteLength < 500) continue

      const sttRes = await fetch(GOOGLE_STT, {
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

      const alternatives: GoogleTranscriptAlternative[] = []
      for (const line of raw.split("\n").reverse()) {
        if (!line.startsWith("{")) continue
        try {
          const result = JSON.parse(line) as { result?: Array<{ alternative?: GoogleTranscriptAlternative[] }> }
          for (const item of result.result ?? []) alternatives.push(...(item.alternative ?? []))
        } catch {}
      }

      if (challenge === "aws-waf") {
        awsAlternatives.push(...alternatives)
        continue
      }

      const transcript = selectGoogleTranscript(alternatives, challenge)
      if (transcript) {
        console.log("[stt] selected transcript:", JSON.stringify(transcript))
        return transcript
      }
    }

    const transcript = selectGoogleTranscript(awsAlternatives, challenge)
    if (transcript) console.log("[stt] selected transcript:", JSON.stringify(transcript))
    return transcript
  } catch (err) {
    console.log("[stt] error:", err instanceof Error ? err.message : err)
    return
  } finally {
    await $`rm -f ${input} ${flac8} ${flac16}`.nothrow().catch(() => {})
  }
}

async function loadAudioSource(audioUrl: string, signal?: AbortSignal): Promise<AudioPayload | undefined> {
  const data = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(audioUrl)
  if (data) {
    try {
      const bytes = data[2]
        ? Uint8Array.from(Buffer.from(data[3], "base64"))
        : new TextEncoder().encode(decodeURIComponent(data[3]))
      return { bytes, contentType: inferAudioContentType(audioUrl, data[1], bytes) }
    } catch (err) {
      console.log("[stt] invalid audio data URL:", err instanceof Error ? err.message : err)
      return
    }
  }

  const response = await fetch(audioUrl, { signal, headers: audioFetchHeaders(audioUrl) })
  if (!response.ok) {
    console.log("[stt] audio download failed:", response.status)
    return
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    bytes,
    contentType: inferAudioContentType(audioUrl, response.headers.get("content-type") ?? "", bytes),
  }
}

export function inferAudioContentType(audioUrl: string, reportedType = "", bytes = new Uint8Array()): string {
  const dataType = /^data:([^;,]+)/i.exec(audioUrl)?.[1]
  const normalized = (dataType || reportedType).split(";", 1)[0].trim().toLowerCase()
  if (normalized.startsWith("audio/")) return normalized
  if (bytes.length >= 4) {
    const signature = String.fromCharCode(...bytes.subarray(0, 4))
    if (signature === "fLaC") return "audio/flac"
    if (signature === "OggS") return "audio/ogg"
    if (signature === "RIFF") return "audio/wav"
    if (signature.startsWith("ID3")) return "audio/mpeg"
    if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "audio/aac"
  }
  if (/\.aac(?:$|[?#])/i.test(audioUrl)) return "audio/aac"
  if (/\.flac(?:$|[?#])/i.test(audioUrl)) return "audio/flac"
  if (/\.ogg(?:$|[?#])/i.test(audioUrl)) return "audio/ogg"
  if (/\.wav(?:$|[?#])/i.test(audioUrl)) return "audio/wav"
  return "audio/mpeg"
}

export function googleSampleRates(contentType: string, challenge: AudioChallengeKind): readonly number[] {
  return challenge === "aws-waf" || /aac|mp4/i.test(contentType) ? [16_000, 8_000] : [8_000, 16_000]
}

export function selectGoogleTranscript(
  alternatives: readonly GoogleTranscriptAlternative[],
  challenge: AudioChallengeKind,
): string | undefined {
  const candidates = alternatives
    .map((alternative, index) => ({
      transcript: clean(alternative.transcript ?? ""),
      confidence: alternative.confidence ?? 0,
      index,
    }))
    .filter((alternative) => alternative.transcript)
  if (candidates.length === 0) return
  if (challenge !== "aws-waf") return candidates[0].transcript

  const score = (candidate: (typeof candidates)[number]): number => {
    const text = candidate.transcript
    const spokenByMe = /\bspoken by me\b/i.exec(text)
    const answerTail = spokenByMe ? text.slice((spokenByMe.index ?? 0) + spokenByMe[0].length).trim() : ""
    const answerWords = answerTail.match(/[a-z0-9]+/gi)?.length ?? 0
    return (
      candidate.confidence -
      candidate.index / 1000 +
      (answerTail ? 200 : 0) +
      Math.min(answerWords, 2) * 10 +
      (/spoken by me/i.test(text) ? 100 : 0) +
      (/following words?/i.test(text) ? 50 : 0) +
      (/one of (?:the )?two/i.test(text) ? 25 : 0) -
      (spokenByMe && !answerTail ? 200 : 0) -
      (/\b(?:do not|don't)\s+(?:type|enter|write|repeat)\b/i.test(text) ? 250 : 0)
    )
  }
  return candidates.toSorted((left, right) => score(right) - score(left))[0]?.transcript
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

export function audioFilename(contentType: string): string {
  if (/aac|mp4/i.test(contentType)) return "audio.aac"
  if (/flac/i.test(contentType)) return "audio.flac"
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

import { invoke } from "@tauri-apps/api/core"

const sounds = {
  press: { notes: [320], gain: 0.09 },
  navigate: { notes: [540], gain: 0.025 },
  active: { notes: [740], gain: 0.018 },
  success: { notes: [440, 660], gain: 0.09 },
  error: { notes: [320, 220], gain: 0.09 },
  open: { notes: [390, 585], gain: 0.06 },
  close: { notes: [480, 300], gain: 0.06 },
  "sidebar-open": { notes: [240, 360], gain: 0.04 },
  "sidebar-close": { notes: [360, 240], gain: 0.04 },
}
type Sound = keyof typeof sounds
type Haptic = "press" | "navigate" | "success" | "error" | "gesture" | "edge" | "reorder"
type Feedback = Sound | Haptic

let audio: AudioContext | undefined

async function readyAudio() {
  audio ??= new AudioContext()
  if (audio.state !== "running") await audio.resume()
  return audio
}

async function playSound(feedback: Sound) {
  const audio = await readyAudio()
  const now = audio.currentTime
  const { notes, gain } = sounds[feedback]
  for (const [index, frequency] of notes.entries()) {
    const start = now + index * 0.04
    const end = start + 0.055
    const oscillator = audio.createOscillator()
    const volume = audio.createGain()
    oscillator.frequency.value = frequency
    volume.gain.setValueAtTime(0.001, start)
    volume.gain.exponentialRampToValueAtTime(gain, start + 0.006)
    volume.gain.exponentialRampToValueAtTime(0.001, end)
    oscillator.connect(volume).connect(audio.destination)
    oscillator.onended = () => volume.disconnect()
    oscillator.start(start)
    oscillator.stop(end)
  }
}

export function useInteractionAudioActivation() {
  const desktop = useDesktopStore()
  function activate(event: Event) {
    if (event.isTrusted && desktop.native && desktop.config.desktop.interactionSounds && audio?.state !== "running")
      void readyAudio().catch(() => {})
  }
  useEventListener(document, "pointerup", activate, { capture: true })
  useEventListener(document, "keydown", activate, { capture: true })
}

export function useInteractionFeedback() {
  const desktop = useDesktopStore()
  return (feedback: Feedback, audible = true, tactile = true) => {
    if (!desktop.native || document.visibilityState !== "visible") return
    const { interactionSounds, hapticFeedback } = desktop.config.desktop
    const sound = feedback === "gesture" ? "navigate" : feedback
    if (audible && interactionSounds && sound !== "edge" && sound !== "reorder") void playSound(sound).catch(() => {})
    if (
      tactile &&
      hapticFeedback &&
      feedback !== "open" &&
      feedback !== "close" &&
      feedback !== "active" &&
      feedback !== "sidebar-open" &&
      feedback !== "sidebar-close" &&
      (desktop.mobile || /Mac/.test(navigator.platform))
    )
      void invoke("interaction_haptic", { feedback }).catch(() => {})
  }
}

import { invoke } from "@tauri-apps/api/core"

type Feedback = "press" | "navigate" | "success" | "error"

const tones: Record<Feedback, readonly number[]> = {
  press: [320],
  navigate: [440, 330],
  success: [440, 660],
  error: [320, 220],
}

let audio: AudioContext | undefined

async function playSound(feedback: Feedback) {
  audio ??= new AudioContext()
  if (audio.state !== "running") await audio.resume()
  const now = audio.currentTime
  for (const [index, frequency] of tones[feedback].entries()) {
    const start = now + index * 0.04
    const end = start + 0.055
    const oscillator = audio.createOscillator()
    const volume = audio.createGain()
    oscillator.frequency.value = frequency
    volume.gain.setValueAtTime(0.001, start)
    volume.gain.exponentialRampToValueAtTime(0.055, start + 0.006)
    volume.gain.exponentialRampToValueAtTime(0.001, end)
    oscillator.connect(volume).connect(audio.destination)
    oscillator.onended = () => volume.disconnect()
    oscillator.start(start)
    oscillator.stop(end)
  }
}

export function useInteractionFeedback() {
  const desktop = useDesktopStore()
  return (feedback: Feedback) => {
    if (!desktop.native || document.visibilityState !== "visible") return
    const { interactionSounds, hapticFeedback } = desktop.config.desktop
    if (interactionSounds) void playSound(feedback).catch(() => {})
    if (hapticFeedback && (desktop.mobile || /Mac/.test(navigator.platform)))
      void invoke("interaction_haptic", { feedback }).catch(() => {})
  }
}

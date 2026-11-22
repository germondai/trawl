// Picks the six digits out of a speech-to-text transcript of a DataDome audio CAPTCHA.
//
// The clip says "type the numbers you hear" and then reads six digits. Recognisers vary:
// some return numerals ("5 8. 9."), some spell them out ("Zero. 3. Seven."), some render
// the instruction in another language, and some mishear "four" as "for". A transcript that
// does not yield exactly six digits is rejected so the caller asks for a fresh puzzle
// instead of burning a submission on a guess.

export const DATADOME_DIGITS = 6

const WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  to: "2",
  too: "2",
  three: "3",
  four: "4",
  for: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  // The clip follows the browser's language, so a Portuguese locale gets Portuguese digits.
  um: "1",
  dois: "2",
  tres: "3",
  quatro: "4",
  cinco: "5",
  seis: "6",
  sete: "7",
  oito: "8",
  nove: "9",
}

// Everything up to the end of the spoken instruction is dropped, so the instruction's own
// words ("to", "for", "you") are never read as digits. English and Portuguese instructions
// end at "hear" / "ouvir"; any other translation ends at its sentence stop.
const INSTRUCTION_END = /(?:numbers?\s+(?:you\s+)?hear\b|n[uú]meros\s+(?:que\s+)?(?:voc[eê]\s+)?ouvir\b|[。｡])/i

export function extractDataDomeDigits(transcript: string): string | undefined {
  // Accents are dropped so "três" and "tres" read the same.
  const text = transcript.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  const end = INSTRUCTION_END.exec(text)
  const spoken = end ? text.slice(end.index + end[0].length) : text

  let digits = ""
  for (const token of spoken.match(/[a-z]+|\d/g) ?? []) {
    if (/^\d$/.test(token)) digits += token
    else if (token in WORDS) digits += WORDS[token]
    // Anything else is background noise or filler and is skipped.
  }
  return digits.length === DATADOME_DIGITS ? digits : undefined
}

// Picks the answer out of a speech-to-text transcript of an AWS WAF audio CAPTCHA.
//
// The clip says "type one of the two following words spoken by me" followed by two
// words, while a second voice reads unrelated prose over it. A recogniser often
// transcribes that background text right after the instruction instead of the two
// words, and submitting it only burns an attempt. Real answers are ordinary content
// words, so a pair that contains a common function word ("it", "to", "the") is
// background speech and is rejected, which lets the caller ask for a fresh puzzle.

const INSTRUCTION = /spoken by me\b/

// Deliberately narrow: only words that never appear as an answer. Words such as
// "unless", "unlike" or "actually" are legitimate answers and must not be listed.
const FUNCTION_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "so",
  "than",
  "then",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "to",
  "from",
  "into",
  "with",
  "as",
  "it",
  "its",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "not",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "he",
  "his",
  "she",
  "her",
  "they",
  "their",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "which",
  "who",
  "what",
  "when",
  "where",
  "can",
  "could",
  "would",
  "should",
  "may",
  "might",
  "will",
  "shall",
  "must",
  "ought",
  "etc",
  "according",
])

const CONNECTORS = new Set(["or", "and"])

export function extractAwsWafAnswer(transcript: string): string | undefined {
  const text = transcript.toLowerCase()
  const match = INSTRUCTION.exec(text)
  if (!match) return

  const tokens = text.slice(match.index + match[0].length).match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []
  const first = tokens[0]
  if (!first) return
  // "counter or stitch": the connector sits between the two words.
  const second = CONNECTORS.has(tokens[1] ?? "") ? tokens[2] : tokens[1]

  for (const word of [first, second]) {
    if (word === undefined) continue
    if (word.length < 2 || FUNCTION_WORDS.has(word)) return
  }
  return first
}

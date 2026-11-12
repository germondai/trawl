import { describe, expect, test } from "bun:test"
import { extractAwsWafAnswer } from "../src/solvers/awsWafAnswer"

describe("AWS WAF audio answer extraction", () => {
  test("takes the first of two words however the recogniser punctuates them", () => {
    expect(extractAwsWafAnswer("Type one of the two following words spoken by me. Target. Knowledge.")).toBe("target")
    expect(extractAwsWafAnswer("Type one of the two following words spoken by me: counter, statistics.")).toBe(
      "counter",
    )
    expect(extractAwsWafAnswer("type one of the two following words spoken by me: counter or stitch and stick.")).toBe(
      "counter",
    )
    expect(extractAwsWafAnswer('type one of the two following words spoken by me: "counter," "apply," the term')).toBe(
      "counter",
    )
    expect(extractAwsWafAnswer("type one of the two following words spoken by me. evolution. unlike.")).toBe(
      "evolution",
    )
  })

  test("accepts digits and a lone word, since either word is a valid answer", () => {
    expect(extractAwsWafAnswer("type one of the two following words spoken by me. 30. associate.")).toBe("30")
    expect(extractAwsWafAnswer("type one of the two following words spoken by me. digital.")).toBe("digital")
  })

  test("rejects a transcript that stops after the instruction", () => {
    expect(extractAwsWafAnswer("type one of the two following words spoken by me.")).toBeUndefined()
  })

  test("rejects a transcript without the instruction rather than guessing the last word", () => {
    expect(
      extractAwsWafAnswer("that this great problem, and perhaps many others, unknown root, namely, associate."),
    ).toBe(undefined)
    expect(extractAwsWafAnswer("")).toBeUndefined()
  })

  test("rejects background speech that follows the instruction", () => {
    // Pairs seen in rejected submissions: the recogniser kept the narrator, not the answer.
    for (const noise of [
      "spoken by me. it is the fact of marriage",
      "spoken by me should be found to fail",
      "spoken by me. 20 is only mixture",
      "spoken by me. according to the critique",
      "spoken by me, insisting that such guilt",
      "spoken by me. to preclude all doubt",
      "spoken by me with the whole",
      "spoken by me. etc. answer",
    ]) {
      expect(extractAwsWafAnswer(`type one of the two following words ${noise}`)).toBeUndefined()
    }
  })

  test("rejects single characters", () => {
    expect(extractAwsWafAnswer("type one of the two following words spoken by me. x.")).toBeUndefined()
  })

  test("does not treat answer-like connectors as part of the word", () => {
    expect(extractAwsWafAnswer("type one of the two following words spoken by me. unless. missiles.")).toBe("unless")
  })
})

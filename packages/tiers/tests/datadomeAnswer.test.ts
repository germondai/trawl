import { describe, expect, test } from "bun:test"
import { extractDataDomeDigits } from "../src/solvers/datadomeAnswer"

describe("DataDome audio answer", () => {
  test("reads numerals after the instruction", () => {
    expect(extractDataDomeDigits("please type the numbers you hear 5 8. 9. 2. 4. 4.")).toBe("589244")
    expect(extractDataDomeDigits("Please type the numbers you hear. 0 3. 5 4. 5 0")).toBe("035450")
  })

  test("reads digits spelled out, in any mix with numerals", () => {
    expect(extractDataDomeDigits("please type the numbers you hear 8 One. 9. eight. 9. zero.")).toBe("819890")
    expect(extractDataDomeDigits("please type the numbers you hear Zero. 3. Seven. 4. Three. Seven.")).toBe("037437")
    expect(extractDataDomeDigits("please type the numbers you hear nine seven one five six six")).toBe("971566")
  })

  test("never takes the instruction's own words for digits", () => {
    // "to" and "for" inside the instruction must not become 2 and 4.
    expect(extractDataDomeDigits("listen to the numbers you hear one two three four five six")).toBe("123456")
    expect(extractDataDomeDigits("Please type the numbers you hear for to one one one one")).toBe("421111")
  })

  test("ends the instruction at its sentence stop when it is not the English wording", () => {
    // U+3002 is the ideographic full stop a translated instruction ends with.
    expect(extractDataDomeDigits("instruction in another language。 5 8. 9. 2. 4. 4.")).toBe("589244")
    expect(extractDataDomeDigits("listen to the digits。 to for one one one one")).toBe("241111")
  })

  test("reads a Portuguese clip, with or without accents, and not its instruction", () => {
    expect(extractDataDomeDigits("Por favor, escreva os números que ouvir. Nove. Zero. Oito. Zero. Oito. Dois.")).toBe(
      "908082",
    )
    expect(extractDataDomeDigits("Por favor, escreva os numeros que ouvir. 9. Zero. Oito. Zero. oito. 2.")).toBe(
      "908082",
    )
    expect(extractDataDomeDigits("digite os números que você ouvir três um quatro cinco seis sete")).toBe("314567")
  })

  test("maps the usual mishearings", () => {
    expect(extractDataDomeDigits("please type the numbers you hear for zero zero three seven seven")).toBe("400377")
  })

  test("rejects a transcript that does not have exactly six digits", () => {
    expect(extractDataDomeDigits("please type the numbers you hear five eight nine two four")).toBeUndefined()
    expect(extractDataDomeDigits("please type the numbers you hear 1 2 3 4 5 6 7")).toBeUndefined()
    expect(extractDataDomeDigits("please type the numbers you hear")).toBeUndefined()
    expect(extractDataDomeDigits("")).toBeUndefined()
  })
})

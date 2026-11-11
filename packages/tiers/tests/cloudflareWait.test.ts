import { expect, spyOn, test } from "bun:test"
import type { Page } from "patchright"
import { solveTurnstile } from "../src/solvers/turnstile"
import { routeChallengeWait } from "../src/utils/challengeRouter"
import { attemptTurnstileClick, waitForChallengeResolution } from "../src/utils/challengeWait"

const wall =
  '<html><head><title>Just a moment...</title></head><body id="challenge-form">Checking your browser</body></html>'
const destination = "<html><head><title>Article</title></head><body><article>Requested content</article></body></html>"

function pageFixture() {
  return {
    title: async () => "Just a moment...",
    content: async () => wall,
    url: () => "https://example.test/article",
    frames: (): unknown[] => [],
    context: () => ({ cookies: async () => [{ name: "cf_clearance", domain: "example.test" }] }),
    keyboard: { press: async () => {} },
    waitForLoadState: async () => {},
    goto: async () => {},
  }
}

test("readable content can finish within a short budget while retaining two observations", async () => {
  const page = pageFixture()
  let observations = 0
  page.title = async () => "Article"
  page.content = async () => {
    observations++
    return destination
  }
  expect(await waitForChallengeResolution(page as unknown as Page, 550, page.url())).toBe("ok")
  expect(observations).toBeGreaterThanOrEqual(2)
})

test.each(["Please wait for the results", "One more step to finish setup"])(
  "does not classify the ordinary title '%s' as a challenge",
  async (title) => {
    const page = pageFixture()
    page.title = async () => title
    page.content = async () => destination
    expect(await waitForChallengeResolution(page as unknown as Page, 550, page.url())).toBe("ok")
  },
)

test("a challenge appearing after the first readable observation must still clear", async () => {
  const page = pageFixture()
  let observations = 0
  let solved = false
  page.title = async () => (++observations === 1 || solved ? "Article" : "Just a moment...")
  page.content = async () => (observations === 1 || solved ? destination : wall)
  page.keyboard.press = async () => {
    solved = true
  }
  expect(await waitForChallengeResolution(page as unknown as Page, 1600, page.url())).toBe("ok")
  expect(solved).toBe(true)
  expect(observations).toBeGreaterThanOrEqual(4)
})

test("Cloudflare routing reads the latest main-document headers after navigation", async () => {
  const page = pageFixture()
  let navigated = false
  page.title = async () => {
    navigated = true
    return "Article"
  }
  page.content = async () => destination
  const headers = (): Record<string, string> => (navigated ? {} : { "cf-mitigated": "challenge" })
  const result = await routeChallengeWait(
    page as unknown as Page,
    wall,
    headers(),
    1500,
    page.url(),
    undefined,
    403,
    undefined,
    headers,
  )
  expect(result).toEqual({ challengeType: "cloudflare-interstitial", resolution: "ok" })
})

test("clearance and a completed goto do not declare a persistent wall solved", async () => {
  const page = pageFixture()
  let navigations = 0
  page.goto = async () => {
    navigations++
  }
  const result = await waitForChallengeResolution(page as unknown as Page, 6500, page.url())
  expect(navigations).toBe(1)
  expect(result).toBe("timeout")
}, 8000)

test("persistent clearance cannot restart manual recovery indefinitely", async () => {
  const page = pageFixture()
  let now = Date.now()
  let navigations = 0
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  page.title = async () => {
    now += 3000
    return "Just a moment..."
  }
  page.goto = async () => {
    navigations++
  }
  try {
    const result = await waitForChallengeResolution(page as unknown as Page, 24000, page.url())
    expect(result).toBe("ip-blocked")
    expect(navigations).toBe(1)
  } finally {
    clock.mockRestore()
  }
}, 8000)

test("fresh clearance after recovery gets time to finish without another navigation", async () => {
  const page = pageFixture()
  let now = Date.now()
  let recoveredAt: number | undefined
  let navigations = 0
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const finished = () => recoveredAt !== undefined && now - recoveredAt >= 8000
  page.title = async () => {
    now += 2000
    return finished() ? "Article" : "Just a moment..."
  }
  page.content = async () => (finished() ? destination : wall)
  page.context = () => ({
    cookies: async () => [
      {
        name: "cf_clearance",
        domain: "example.test",
        value: recoveredAt !== undefined && now - recoveredAt >= 4000 ? "fresh-clearance" : "old-clearance",
      },
    ],
  })
  page.goto = async () => {
    navigations++
    recoveredAt = now
  }
  try {
    expect(await waitForChallengeResolution(page as unknown as Page, 36000, page.url())).toBe("ok")
    expect(navigations).toBe(1)
  } finally {
    clock.mockRestore()
  }
}, 8000)

test("manual clearance recovery confirms the destination without waiting for network idle", async () => {
  const page = pageFixture()
  let recovered = false
  const loadStates: string[] = []
  page.goto = async () => {
    recovered = true
  }
  page.title = async () => (recovered ? "Article" : "Just a moment...")
  page.content = async () => (recovered ? destination : wall)
  page.waitForLoadState = async (state?: string) => {
    loadStates.push(state ?? "load")
  }
  const result = await waitForChallengeResolution(page as unknown as Page, 7500, page.url())
  expect(result).toBe("ok")
  expect(loadStates).not.toContain("networkidle")
}, 9000)

test("settled content does not trigger a keyboard click for a provider link", async () => {
  const page = pageFixture()
  let presses = 0
  page.title = async () => "Article"
  page.content = async () =>
    destination.replace("</article>", '<a href="https://challenges.cloudflare.com/turnstile">Docs</a></article>')
  page.keyboard.press = async () => {
    presses++
  }
  expect(await waitForChallengeResolution(page as unknown as Page, 1500, page.url())).toBe("ok")
  expect(presses).toBe(0)
})

test("keyboard fallback stops before Space when Cloudflare clears after Tab", async () => {
  const page = pageFixture()
  const keys: string[] = []
  let cleared = false
  page.content = async () => (cleared ? destination : wall)
  page.keyboard.press = async (key?: string) => {
    keys.push(key ?? "")
    cleared = true
  }
  page.title = async () => (cleared ? "Article" : "Just a moment...")
  expect(await attemptTurnstileClick(page as unknown as Page)).toBe(false)
  expect(keys).toEqual(["Tab"])
})

test("interstitial clicks stop when Cloudflare clears during frame discovery", async () => {
  const page = pageFixture()
  let cleared = false
  let clicks = 0
  page.title = async () => (cleared ? "Article" : "Just a moment...")
  page.content = async () => (cleared ? destination : wall)
  page.frames = () => [
    {
      url: () => "https://challenges.cloudflare.com/turnstile/widget",
      evaluateHandle: async () => {
        throw new Error("Shadow root unavailable")
      },
      locator: () => ({
        first: () => ({
          isVisible: async () => {
            cleared = true
            return true
          },
          click: async () => {
            clicks++
          },
        }),
      }),
    },
  ]
  expect(await attemptTurnstileClick(page as unknown as Page)).toBe(false)
  expect(clicks).toBe(0)
})

test("shadow traversal visits each subtree once and releases browser handles", async () => {
  let evaluations = 0
  let released = 0
  let roots = 0
  const shadow = { children: [], querySelectorAll: () => [] }
  function node(child?: object, shadowRootUnl?: object): object {
    return {
      children: child ? [child] : [],
      shadowRootUnl,
      querySelectorAll() {
        evaluations++
        const descendants = []
        let current = child as { children: object[] } | undefined
        while (current) {
          descendants.push(current)
          current = current.children[0] as typeof current
        }
        return descendants
      },
    }
  }
  let tree = node(undefined, shadow)
  for (let i = 0; i < 8; i++) tree = node(tree)
  const frame = {
    url: () => "https://challenges.cloudflare.com/turnstile/widget",
    async evaluateHandle(callback: () => unknown[]) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
      Object.defineProperty(globalThis, "document", { configurable: true, value: tree })
      try {
        roots = callback().length
      } finally {
        if (descriptor) Object.defineProperty(globalThis, "document", descriptor)
        else Reflect.deleteProperty(globalThis, "document")
      }
      return {
        getProperties: async () => new Map(),
        dispose: async () => {
          released++
        },
      }
    },
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    frameElement: async () => undefined,
  }
  const page = { frames: () => [frame], content: async () => "" }
  expect(await attemptTurnstileClick(page as unknown as Page, false)).toBe(false)
  expect(roots).toBe(1)
  expect(evaluations).toBeLessThanOrEqual(9)
  expect(released).toBe(1)
})

test("Cloudflare deny URLs remain blocked even without an active widget", async () => {
  const page = pageFixture()
  page.url = () => "https://example.test/cdn-cgi/error/1020"
  page.title = async () => "Error"
  page.content = async () => "<html><title>Error</title><body>Forbidden</body></html>"
  expect(await waitForChallengeResolution(page as unknown as Page, 1500, page.url())).toBe("ip-blocked")
})

test.each(["", " \n ", undefined])("Cloudflare does not clear an unreadable or empty document (%s)", async (html) => {
  const page = pageFixture()
  page.title = async () => "Article"
  page.content = async () => {
    if (html === undefined) throw new Error("Document changed during navigation")
    return html
  }
  expect(await waitForChallengeResolution(page as unknown as Page, 900, page.url())).toBe("timeout")
})

test("Cloudflare clearance from a suffix sibling cannot trigger recovery navigation", async () => {
  const page = pageFixture()
  page.url = () => "https://notexample.test/article"
  let navigations = 0
  page.goto = async () => {
    navigations++
  }
  expect(await waitForChallengeResolution(page as unknown as Page, 6500, page.url())).toBe("timeout")
  expect(navigations).toBe(0)
}, 8000)

function clickableFrame(click: () => Promise<void>) {
  return {
    url: () => "https://challenges.cloudflare.com/turnstile/widget",
    evaluateHandle: async () => {
      throw new Error("Shadow root unavailable")
    },
    locator: () => ({ first: () => ({ isVisible: async () => true, click }) }),
  }
}

test("an embedded widget frame does not keep a cleared page in the interstitial waiter", async () => {
  const page = pageFixture()
  let clicked = false
  page.title = async () => "Article"
  page.content = async () => destination.replace("</body>", '<div class="cf-turnstile"></div></body>')
  page.frames = () => [
    clickableFrame(async () => {
      clicked = true
    }),
  ]
  expect(await waitForChallengeResolution(page as unknown as Page, 900, page.url())).toBe("ok")
  expect(clicked).toBe(false)
})

test("coordinate fallback stops when Cloudflare clears during mouse movement", async () => {
  const page = pageFixture()
  let cleared = false
  let clicks = 0
  page.title = async () => (cleared ? "Article" : "Just a moment...")
  page.content = async () => (cleared ? destination : wall)
  page.frames = () => [
    {
      url: () => "https://challenges.cloudflare.com/turnstile/widget",
      evaluateHandle: async () => {
        throw new Error("Shadow root unavailable")
      },
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
      frameElement: async () => ({
        boundingBox: async () => ({ x: 10, y: 100, width: 300, height: 65 }),
        hover: async () => {
          cleared = true
        },
        click: async () => {
          clicks++
        },
        dispose: async () => {},
      }),
    },
  ]
  expect(await attemptTurnstileClick(page as unknown as Page)).toBe(false)
  expect(clicks).toBe(0)
})

test("a detached challenge iframe cannot turn a coordinate fallback into a page click", async () => {
  let pageClicks = 0
  let disposed = 0
  const frame = {
    url: () => "https://challenges.cloudflare.com/turnstile/widget",
    evaluateHandle: async () => {
      throw new Error("Shadow root unavailable")
    },
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    frameElement: async () => ({
      boundingBox: async () => ({ x: 10, y: 100, width: 300, height: 65 }),
      hover: async () => {},
      click: async () => {
        throw new Error("Element is not attached to the DOM")
      },
      dispose: async () => {
        disposed++
      },
    }),
  }
  const page = {
    frames: () => [frame],
    mouse: {
      move: async () => {},
      click: async () => {
        pageClicks++
      },
    },
  }
  expect(await attemptTurnstileClick(page as unknown as Page, false)).toBe(false)
  expect(pageClicks).toBe(0)
  expect(disposed).toBe(1)
})

test("a widget on a real page cannot trigger the interstitial keyboard fallback", async () => {
  const page = pageFixture()
  let presses = 0
  page.title = async () => "Article"
  page.content = async () => destination.replace("</body>", '<div class="cf-turnstile"></div></body>')
  page.keyboard.press = async () => {
    presses++
  }
  expect(await attemptTurnstileClick(page as unknown as Page)).toBe(false)
  expect(presses).toBe(0)
})

test.each(["clicked", "hidden", "detached"])(
  "coordinate fallback releases its iframe handle when %s",
  async (state) => {
    let disposed = 0
    let clicked = 0
    const frame = {
      url: () => "https://challenges.cloudflare.com/turnstile/widget",
      evaluateHandle: async () => {
        throw new Error("Shadow root unavailable")
      },
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
      frameElement: async () => ({
        boundingBox: async () => {
          if (state === "detached") throw new Error("Frame detached")
          return state === "hidden" ? null : { x: 0, y: 0, width: 300, height: 65 }
        },
        hover: async () => {},
        click: async () => {
          if (state !== "clicked") throw new Error("Element is not attached to the DOM")
          clicked++
        },
        dispose: async () => {
          disposed++
        },
      }),
    }
    const page = {
      frames: () => [frame],
      mouse: {
        move: async () => {},
        click: async () => {
          clicked++
        },
      },
    }
    expect(await attemptTurnstileClick(page as unknown as Page, false)).toBe(state === "clicked")
    expect(clicked).toBe(state === "clicked" ? 1 : 0)
    expect(disposed).toBe(1)
  },
)

test("a newly mounted Cloudflare frame does not inherit the keyboard retry delay", async () => {
  const page = pageFixture()
  let mounted = false
  let clicked = false
  const frame = clickableFrame(async () => {
    clicked = true
  })
  page.frames = () => (mounted && !clicked ? [frame] : [])
  page.keyboard.press = async (key?: string) => {
    if (key === "Space") mounted = true
  }
  page.title = async () => (clicked ? "Article" : "Just a moment...")
  page.content = async () => (clicked ? destination : wall)
  expect(await waitForChallengeResolution(page as unknown as Page, 2200, page.url())).toBe("ok")
  expect(clicked).toBe(true)
})

test("embedded Turnstile retries discovery without waiting three seconds for an absent frame", async () => {
  let inspections = 0
  let clicked = false
  const frame = clickableFrame(async () => {
    clicked = true
  })
  const page = {
    evaluate: async () => clicked,
    evaluateHandle: async () => ({
      evaluate: async (read: any) => read({ verified: () => clicked, disconnect() {} }),
      dispose: async () => {},
    }),
    frames: () => (++inspections === 1 ? [] : [frame]),
    content: async () => "",
  }
  expect(await solveTurnstile(page as unknown as Page, 3000)).toBe(true)
  expect(clicked).toBe(true)
})

test("a failed shadow checkbox click falls through to the frame control", async () => {
  let clicked = false
  const frame = clickableFrame(async () => {
    clicked = true
  })
  const checkbox = {
    isVisible: async () => true,
    click: async () => {
      throw new Error("Checkbox detached")
    },
  }
  const checkboxHandle = { asElement: () => checkbox, dispose: async () => {} }
  const root = { evaluateHandle: async () => checkboxHandle }
  const rootHandle = { asElement: () => root, dispose: async () => {} }
  Object.assign(frame, {
    evaluateHandle: async () => ({
      getProperties: async () => new Map([["0", rootHandle]]),
      dispose: async () => {},
    }),
  })
  const page = { frames: () => [frame], content: async () => "" }
  expect(await attemptTurnstileClick(page as unknown as Page, false)).toBe(true)
  expect(clicked).toBe(true)
})

test("a known active challenge does not transfer HTML on every poll", async () => {
  const page = pageFixture()
  let clicked = false
  let activeCaptures = 0
  const frame = clickableFrame(async () => {
    clicked = true
  })
  page.frames = () => (clicked ? [] : [frame])
  page.title = async () => (clicked ? "Article" : "Just a moment...")
  page.content = async () => {
    if (!clicked) activeCaptures++
    return clicked ? destination : wall
  }
  expect(await waitForChallengeResolution(page as unknown as Page, 2000, page.url())).toBe("ok")
  expect(activeCaptures).toBe(0)
})

test("embedded click discovery does not read HTML for a disabled keyboard fallback", async () => {
  let captures = 0
  const page = {
    frames: () => [],
    content: async () => {
      captures++
      return "<html></html>"
    },
  }
  expect(await attemptTurnstileClick(page as unknown as Page, false)).toBe(false)
  expect(captures).toBe(0)
})

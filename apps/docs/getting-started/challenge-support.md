---
title: Challenge & CAPTCHA Support
description: Built-in challenge flows, CAPTCHA solving paths and optional external provider support.
---

# Challenge and CAPTCHA support

TRAWL detects supported walls, chooses the matching browser flow and checks whether the wall remains before returning content. Embedded widgets use response-token or verified-state checks. These are supported solving paths, not a guarantee that every deployment will accept the result.

| Challenge / CAPTCHA     | Built-in handling                                                                    | Optional 2Captcha handling                                |
| ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Cloudflare interstitial | Browser challenge execution, Turnstile interaction and clearance recovery            | Automatic fallback for captured Turnstile Challenge Pages |
| Standalone Turnstile    | Shadow-DOM/frame interaction; checks the response token                              | Automatic fallback for a supported declarative widget     |
| reCAPTCHA v2            | Checkbox and audio solving                                                           | Automatic fallback for a supported declarative widget     |
| reCAPTCHA v2 Enterprise | No dedicated Enterprise solver                                                       | Automatic fallback for a supported declarative widget     |
| reCAPTCHA v3            | No built-in score solver                                                             | Site profile required                                     |
| hCaptcha                | Checkbox auto-pass and audio where offered; no image-grid solver                     | Not included in the current external task catalogue       |
| GeeTest                 | Slide puzzle matching and verified-state checks                                      | Site profile required                                     |
| Shumei                  | Visible `spatial_select` widgets with supported smallest-color puzzles; SDK acceptance checks | No catalogue entry                                 |
| Baxia NC (Alibaba)      | "Slide to verify" slider on punish pages; passes only when a new `x5sec` cookie is issued | No catalogue entry                                 |
| ALTCHA                  | Bounded HTTP solving for supported access forms; browser widget fallback             | Site profile required                                     |
| Friendly Captcha v1/v2  | Bounded HTTP v1 access forms; browser v1/v2 widget execution and response checks       | Site profile required                                     |
| CAP                     | Native proof of work; verifies every visible widget                                  | No catalogue entry                                        |
| NCBI identity PoW       | Bounded HTTP SHA-256 solve; returns clearance cookies                                | No catalogue entry                                        |
| Anubis                  | Bounded HTTP proof of work and wait-based flows, with browser fallback                             | No catalogue entry                                        |
| Akamai Bot Manager      | Supported sensor and press-and-hold flows                                            | No dedicated catalogue entry                              |
| Imperva / Incapsula     | Supported sensor challenges; no built-in solver for its own interactive CAPTCHA      | Site profile required                                     |
| DDoS-Guard              | JavaScript challenge execution and cookie checks                                     | No dedicated catalogue entry                              |
| AWS WAF                 | Token challenges; CAPTCHA wall via the audio puzzle (needs a capable STT model)      | Site profile required for CAPTCHA                         |
| DataDome                | Device Check through the opt-in headful pool; detects slider CAPTCHA and hard blocks | Site profile required for slider CAPTCHA                  |
| DuckDuckGo anomaly wall | Detected and reported as requiring CAPTCHA; no built-in image-puzzle solver          | No dedicated catalogue entry                              |

DataDome browser handling requires `BROWSER_HEADFUL_POOL_SIZE=1`, which adds another browser pool. IP hard blocks may require a different egress IP. Google Search `/sorry/` redirects and supported bot-wall pages are also detected; detection alone does not mean a puzzle can be solved.

Baxia NC solving drags the slider on Alibaba's punish page (`.../_____tmd_____/punish`) in the page's own browser, in the punish document or its iframe. Success requires a new, non-empty `x5sec` cookie; the widget's verified text and the challenge's beacon traffic answer 2xx either way and are not trusted. A rejected slide is retried through the widget's own retry control, up to three drags. The click-in-order captcha Baxia sometimes serves for the same block is not solved, and the puzzle-piece variant used before 2026-11-08 is not supported.

Shumei solving uses the page's existing widget and normal browser clicks, retaining its proxy, cookies, User-Agent and SDK callbacks. It supports one visible `spatial_select` widget with Chinese smallest-color instructions, within image-size and request-deadline limits. Slide, text/icon selection, other spatial instructions and multiple widgets are not solved. TRAWL does not open arbitrary login controls or submit application forms to expose a popup. A provider-accepted widget does not prove that an application's backend accepted a subsequent form submission.

## External task catalogue

2Captcha is disabled by default. Enable it with `CAPTCHA_SOLVER=2captcha` and `TWOCAPTCHA_API_KEY`. Automatic fallback supports one declarative reCAPTCHA v2/Enterprise or standalone Turnstile widget per provider on a page, subject to the adapter's callback, CSP and task-budget checks.

Supported Cloudflare Challenge Pages also work without a profile: TRAWL captures the dynamic Turnstile render parameters before initialization, tries local resolution first and delivers the external answer to the original callback. Navigation, replaced parameters or a different provider user agent invalidate the answer. A token or clearance cookie alone does not prove that the target page is accessible.

Other task types require an exact-hostname profile with task inputs, response delivery and target verification. Recognized SDK markers can produce diagnostic candidates; they do not automatically create paid tasks.

<details>
  <summary>Additional task types supported through site profiles</summary>

- **Provider tasks:** Arkose/FunCaptcha, Capy, KeyCaptcha, Lemin, CyberSiara, MTCaptcha, CutCaptcha, ATB, Tencent, Prosopo, CaptchaFox, VK, Yidun, Binance, Hunt, TSPD, Basilisk, Alibaba and Yandex SmartCaptcha, alongside the profile-based providers in the table above.
- **Puzzle and media tasks:** image-to-text, text questions, audio, rotation, coordinates, grids, draw-around, bounding boxes, drag-and-drop, Temu images, SmartCaptcha images, Pazl puzzles and VK images. Generic images and audio are not automatically classified as CAPTCHA.

</details>

External integration is tested with local provider and widget fixtures. Real paid-service acceptance remains unverified. A widget token is not proof that a site's server accepted a form submission. TRAWL does not submit application forms automatically.

The HTTP PoW fast path supports a single ALTCHA or Friendly Captcha v1 widget in an access-challenge page with a challenge title and one POST form named `altcha-form`, `captcha-form` or `friendly-captcha-form`. Only hidden inputs and unnamed submit buttons are accepted; hidden fields such as CSRF tokens are preserved. Cross-origin form actions, custom callbacks, application inputs, multiple forms and ambiguous markup retain browser fallback. Solving an embedded application widget remains controlled by `solveEmbeddedCaptchas`; `/v1` still defaults to page delivery.

ALTCHA supports signed legacy SHA-256/384/512 proofs and the prefix protocol's SHA, PBKDF2/SHA, scrypt and Argon2id variants, within local cost and memory bounds. Friendly v1 supports inline puzzles and the standard puzzle API response. Friendly v2 stays on the existing browser path. All HTTP proof calculations share one process with the existing Anubis/NCBI solvers, run for at most one second and stop on cancellation. This path returns success only after a subsequent request delivers content without the recognized wall; it does not mark an isolated puzzle response as a solved page.

See [browser challenge flows](/architecture/tiered-execution#tier-3-fresh-challenge-solve) and [external solver configuration](/getting-started/configuration#optional-external-captcha-solver) for setup and limits.

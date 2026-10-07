export type { AcquireOptions, OrchestratorDeps } from "./orchestrator"
export { ScrapeError, scrape } from "./orchestrator"
export { type SolveResult, solvePageCaptchas } from "./solvers"
export { captchaTasks, detectExternalCaptchas } from "./solvers/captchaCatalog"
export type { CaptchaProfile } from "./solvers/captchaProfiles"
export { parseCaptchaProfiles } from "./solvers/captchaProfiles"
export type { ExternalCaptchaOptions } from "./solvers/externalCaptcha"
export { runTier1, type Tier1Result } from "./tiers/1"
export { runTier2, type Tier2Result } from "./tiers/2"
export { runTier3, type Tier3Result } from "./tiers/3"
export { runTier4, type Tier4Result } from "./tiers/4"
export { anubisInspectionText } from "./utils/anubis"
export type { LandingProbe, LandingProbeOptions } from "./utils/crossedLanding"
export {
  type ChallengeType,
  type DataDomeAction,
  detectChallengeType,
  getAwsWafAction,
  getDataDomeAction,
  hasAkamaiChallenge,
  hasAltcha,
  hasAnubisChallenge,
  hasAwsWafCaptcha,
  hasAwsWafChallenge,
  hasChallengeWallMarkers,
  hasDataDomeCaptcha,
  hasDataDomeChallenge,
  hasDdosGuardChallenge,
  hasDuckDuckGoChallenge,
  hasFriendlyCaptcha,
  hasHcaptcha,
  hasImpervaChallenge,
  hasRecaptcha,
  hasTurnstile,
  isBlocked,
  isBrowserErrorPage,
  isChallengeWall,
  isCloudflarePage,
  needsJs,
} from "./utils/detect"
export { isGoogleSorryUrl } from "./utils/googleSorry"
export { normalizeProxy, ProxyPool, type ProxySelection } from "./utils/proxyRotator"
export { isHtmlContentType } from "./utils/response"
export {
  isValidMethod,
  proxySanitizeHeaders,
  RESERVED_HEADER_NAMES,
  RESPONSE_HOP_BY_HOP_HEADERS,
  RequestValidationError,
  requireContentTypeForBody,
  routeContinueOverrides,
  SUPPORTED_METHODS,
  type SupportedMethod,
  sanitizeHeaders,
} from "./utils/sanitize"

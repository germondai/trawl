// API v2 task specifications reviewed against 2captcha.com/api-docs (2026-10-07).
export interface CaptchaTaskSpec {
  kind: string
  type: string
  doc: string
  proxy: "none" | "optional" | "required"
  required: string[]
  fields: Record<string, string>
  marker?: string
}
export const captchaTasks: CaptchaTaskSpec[] = [
  {
    kind: "recaptcha-v2",
    type: "RecaptchaV2Task",
    doc: "recaptcha-v2",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: {
      websiteURL: "string",
      websiteKey: "string",
      recaptchaDataSValue: "string",
      isInvisible: "boolean",
      userAgent: "string",
      cookies: "string",
      apiDomain: "string",
    },
    marker: "(?:google\\.com|recaptcha\\.net)/recaptcha/|class=[\"\\'][^\"\\']*g-recaptcha",
  },
  {
    kind: "recaptcha-v2-enterprise",
    type: "RecaptchaV2EnterpriseTask",
    doc: "recaptcha-v2-enterprise",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: {
      websiteURL: "string",
      websiteKey: "string",
      enterprisePayload: "object",
      isInvisible: "boolean",
      userAgent: "string",
      cookies: "string",
      apiDomain: "string",
    },
    marker: "(?:google\\.com|recaptcha\\.net)/recaptcha/enterprise",
  },
  {
    kind: "recaptcha-v3",
    type: "RecaptchaV3TaskProxyless",
    doc: "recaptcha-v3",
    proxy: "none",
    required: ["websiteURL", "websiteKey", "minScore"],
    fields: {
      websiteURL: "string",
      websiteKey: "string",
      minScore: "float",
      pageAction: "string",
      isEnterprise: "boolean",
      apiDomain: "string",
    },
    marker: "(?:google\\.com|recaptcha\\.net)/recaptcha/(?:api|enterprise)\\.js\\?[^\"\\']*render=(?!explicit)[\\w-]+",
  },
  {
    kind: "turnstile",
    type: "TurnstileTask",
    doc: "cloudflare-turnstile",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: { websiteURL: "string", websiteKey: "string", action: "string", data: "string", pagedata: "string" },
    marker: "challenges\\.cloudflare\\.com/|class=[\"\\'][^\"\\']*cf-turnstile",
  },
  {
    kind: "arkose",
    type: "FunCaptchaTask",
    doc: "arkoselabs-funcaptcha",
    proxy: "optional",
    required: ["websiteURL", "websitePublicKey"],
    fields: {
      websiteURL: "string",
      websitePublicKey: "string",
      funcaptchaApiJSSubdomain: "string",
      data: "string",
      userAgent: "string",
    },
    marker: "(?:arkoselabs\\.com|funcaptcha\\.com)/",
  },
  {
    kind: "geetest",
    type: "GeeTestTask",
    doc: "geetest",
    proxy: "optional",
    required: ["websiteURL"],
    fields: {
      websiteURL: "string",
      gt: "string",
      challenge: "string",
      geetestApiServerSubdomain: "string",
      userAgent: "string",
      version: "integer",
      initParameters: "object",
      riskType: "string",
    },
    marker: "(?:geetest\\.com/|initGeetest(?:4)?\\s*\\()",
  },
  {
    kind: "capy",
    type: "CapyTask",
    doc: "capy-puzzle-captcha",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: { websiteURL: "string", websiteKey: "string", userAgent: "string" },
    marker: "(?:capy\\.me/|capy\\.puzzle)",
  },
  {
    kind: "keycaptcha",
    type: "KeyCaptchaTask",
    doc: "keycaptcha",
    proxy: "optional",
    required: ["websiteURL", "s_s_c_user_id", "s_s_c_session_id", "s_s_c_web_server_sign", "s_s_c_web_server_sign2"],
    fields: {
      websiteURL: "string",
      s_s_c_user_id: "string",
      s_s_c_session_id: "string",
      s_s_c_web_server_sign: "string",
      s_s_c_web_server_sign2: "string",
    },
    marker: "(?:keycaptcha\\.com/|s_s_c_user_id\\s*=)",
  },
  {
    kind: "lemin",
    type: "LeminTask",
    doc: "lemin",
    proxy: "optional",
    required: ["websiteURL", "captchaId", "divId"],
    fields: {
      websiteURL: "string",
      captchaId: "string",
      divId: "string",
      leminApiServerSubdomain: "string",
      userAgent: "string",
    },
    marker: "(?:leminnow\\.com/|lemin-cropped-captcha)",
  },
  {
    kind: "aws-waf",
    type: "AmazonTask",
    doc: "amazon-aws-waf-captcha",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: {
      websiteURL: "string",
      websiteKey: "string",
      iv: "string",
      context: "string",
      challengeScript: "string",
      captchaScript: "string",
      jsapiScript: "string",
    },
    marker: "(?:token|captcha)\\.awswaf\\.com/",
  },
  {
    kind: "cybersiara",
    type: "AntiCyberSiAraTask",
    doc: "anti-cyber-siara",
    proxy: "optional",
    required: ["websiteURL", "SlideMasterUrlId", "userAgent"],
    fields: { websiteURL: "string", SlideMasterUrlId: "string", userAgent: "string" },
    marker: "(?:cybersiara\\.com/|SlideMasterUrlId)",
  },
  {
    kind: "mtcaptcha",
    type: "MtCaptchaTask",
    doc: "mtcaptcha",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: { websiteURL: "string", websiteKey: "string" },
    marker: "(?:mtcaptcha\\.com/|class=[\"\\'][^\"\\']*mtcaptcha)",
  },
  {
    kind: "datadome",
    type: "DataDomeSliderTask",
    doc: "datadome-slider-captcha",
    proxy: "required",
    required: ["websiteURL", "captchaUrl", "userAgent"],
    fields: { websiteURL: "string", captchaUrl: "string", userAgent: "string" },
    marker: "(?:captcha-delivery\\.com/|ct\\.datadome\\.co/)",
  },
  {
    kind: "friendly-captcha",
    type: "FriendlyCaptchaTask",
    doc: "friendly-captcha",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: {
      websiteURL: "string",
      websiteKey: "string",
      version: "string",
      moduleScript: "string",
      nomoduleScript: "string",
    },
    marker: "(?:friendlycaptcha\\.com/|friendly-challenge/|class=[\"\\'][^\"\\']*frc-captcha)",
  },
  {
    kind: "cutcaptcha",
    type: "CutCaptchaTask",
    doc: "cutcaptcha",
    proxy: "optional",
    required: ["websiteURL", "miseryKey", "apiKey"],
    fields: { websiteURL: "string", miseryKey: "string", apiKey: "string" },
    marker: "(?:cutcaptcha\\.com/|CUTCAPTCHA_MISERY_KEY)",
  },
  {
    kind: "atb",
    type: "AtbCaptchaTask",
    doc: "atb-captcha",
    proxy: "optional",
    required: ["websiteURL", "appId", "apiServer"],
    fields: { websiteURL: "string", appId: "string", apiServer: "string" },
    marker: "(?:aisecurius\\.com/|atb-captcha)",
  },
  {
    kind: "tencent",
    type: "TencentTask",
    doc: "tencent",
    proxy: "optional",
    required: ["websiteURL", "appId"],
    fields: { websiteURL: "string", appId: "string", captchaScript: "string" },
    marker: "(?:captcha\\.qq\\.com/|TencentCaptcha\\s*\\()",
  },
  {
    kind: "prosopo",
    type: "ProsopoTask",
    doc: "prosopo-procaptcha",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: { websiteURL: "string", websiteKey: "string" },
    marker: "(?:prosopo\\.io/|class=[\"\\'][^\"\\']*procaptcha)",
  },
  {
    kind: "captchafox",
    type: "CaptchaFoxTask",
    doc: "captchafox",
    proxy: "required",
    required: ["websiteURL", "websiteKey", "userAgent"],
    fields: { websiteURL: "string", apiServer: "string", websiteKey: "string", userAgent: "string" },
    marker: "(?:captchafox\\.com/|class=[\"\\'][^\"\\']*captchafox)",
  },
  {
    kind: "vk",
    type: "VKCaptchaTask",
    doc: "vk-captcha",
    proxy: "required",
    required: ["redirectUri", "userAgent"],
    fields: { redirectUri: "string", userAgent: "string" },
    marker: "id\\.vk\\.com/not_robot_captcha",
  },
  {
    kind: "altcha",
    type: "AltchaTask",
    doc: "altcha",
    proxy: "optional",
    required: ["websiteURL"],
    fields: { websiteURL: "string", challengeURL: "string", challengeJSON: "string" },
    marker: "<altcha-widget\\b",
  },
  {
    kind: "yidun",
    type: "YidunTask",
    doc: "yidun-necaptcha",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: {
      websiteURL: "string",
      websiteKey: "string",
      userAgent: "string",
      yidunGetLib: "string",
      yidunApiServerSubdomain: "string",
      challenge: "string",
      hcg: "string",
      hct: "number",
    },
    marker: "(?:c\\.dun\\.163\\.com/|cstaticdun\\.126\\.net/|initNECaptcha\\s*\\()",
  },
  {
    kind: "binance",
    type: "BinanceTask",
    doc: "binance-captcha",
    proxy: "optional",
    required: ["websiteURL", "websiteKey", "validateId"],
    fields: { websiteURL: "string", websiteKey: "string", validateId: "string" },
    marker: "(?:binance\\.com/[^\"\\']*captcha|securityCheckResponseValidateId)",
  },
  {
    kind: "hunt",
    type: "HuntTask",
    doc: "hunt-captcha",
    proxy: "required",
    required: ["websiteURL", "apiGetLib"],
    fields: { websiteURL: "string", apiGetLib: "string", userAgent: "string", data: "string" },
    marker: "/hd-api/external/apps/",
  },
  {
    kind: "tspd",
    type: "TspdTask",
    doc: "tspd-captcha",
    proxy: "required",
    required: ["websiteURL", "tspdCookie", "htmlPageBase64"],
    fields: { websiteURL: "string", tspdCookie: "string", htmlPageBase64: "string", userAgent: "string" },
    marker: "(?:tspd_101|/TSPD/)",
  },
  {
    kind: "basilisk",
    type: "BasiliskTask",
    doc: "basilisk-captcha",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: { websiteURL: "string", websiteKey: "string", userAgent: "string" },
    marker: "(?:basilisk-captcha|basilisk\\.render\\s*\\()",
  },
  {
    kind: "imperva",
    type: "ImpervaTask",
    doc: "imperva-incapsula",
    proxy: "required",
    required: ["websiteURL", "incapsulaScriptUrl", "incapsulaCookies"],
    fields: {
      websiteURL: "string",
      incapsulaScriptUrl: "string",
      incapsulaCookies: "string",
      userAgent: "string",
      reese84UrlEndpoint: "string",
    },
    marker: "_Incapsula_Resource\\?",
  },
  {
    kind: "alibaba",
    type: "AlibabaTask",
    doc: "alibaba-captcha",
    proxy: "optional",
    required: ["websiteURL", "sceneId", "prefix"],
    fields: {
      websiteURL: "string",
      sceneId: "string",
      prefix: "string",
      userId: "string",
      userUserId: "string",
      verifyType: "string",
      region: "string",
      userCertifyId: "string",
      apiGetLib: "string",
      userAgent: "string",
    },
    marker: "(?:aliyunCaptcha/|AliyunCaptcha\\.js|initAliyunCaptcha\\s*\\()",
  },
  {
    kind: "yandex",
    type: "YandexSmartCaptchaTask",
    doc: "yandex-smart-captcha",
    proxy: "optional",
    required: ["websiteURL", "websiteKey"],
    fields: { websiteURL: "string", websiteKey: "string", userAgent: "string", cookies: "string" },
    marker: "(?:smartcaptcha\\.yandexcloud\\.net/|class=[\"\\'][^\"\\']*smart-captcha)",
  },
  {
    kind: "image",
    type: "ImageToTextTask",
    doc: "normal-captcha",
    proxy: "none",
    required: ["body"],
    fields: {
      body: "string",
      phrase: "boolean",
      case: "boolean",
      numeric: "integer",
      math: "boolean",
      minLength: "integer",
      maxLength: "integer",
      comment: "string",
      imgInstructions: "string",
    },
  },
  {
    kind: "text",
    type: "TextCaptchaTask",
    doc: "text",
    proxy: "none",
    required: ["comment"],
    fields: { comment: "string" },
  },
  {
    kind: "audio",
    type: "AudioTask",
    doc: "audio",
    proxy: "none",
    required: ["body", "lang"],
    fields: { body: "string", lang: "string" },
  },
  {
    kind: "rotate",
    type: "RotateTask",
    doc: "rotate",
    proxy: "none",
    required: ["body"],
    fields: { body: "string", angle: "integer", comment: "string", imgInstructions: "string" },
  },
  {
    kind: "coordinates",
    type: "CoordinatesTask",
    doc: "coordinates",
    proxy: "none",
    required: ["body"],
    fields: {
      body: "string",
      comment: "string",
      imgInstructions: "string",
      minClicks: "integer",
      maxClicks: "integer",
    },
  },
  {
    kind: "grid",
    type: "GridTask",
    doc: "grid",
    proxy: "none",
    required: ["body"],
    fields: {
      body: "string",
      rows: "integer",
      columns: "integer",
      comment: "string",
      imgInstructions: "string",
      previousId: "string",
      imgType: "string",
      minClicks: "integer",
      maxClicks: "integer",
      canNoAnswer: "integer",
    },
  },
  {
    kind: "draw-around",
    type: "DrawAroundTask",
    doc: "draw-around",
    proxy: "none",
    required: ["body"],
    fields: { body: "string", comment: "string", imgInstructions: "string" },
  },
  {
    kind: "bounding-box",
    type: "BoundingBoxTask",
    doc: "bounding-box",
    proxy: "none",
    required: ["body"],
    fields: { body: "string", comment: "string", imgInstructions: "string", canNoAnswer: "integer" },
  },
  {
    kind: "drag-and-drop",
    type: "DragAndDropTask",
    doc: "drag-and-drop",
    proxy: "none",
    required: ["background", "images"],
    fields: { background: "string", images: "array of string", comment: "string" },
  },
  {
    kind: "temu-image",
    type: "TemuImageTask",
    doc: "temu-captcha",
    proxy: "none",
    required: ["image", "parts"],
    fields: { image: "string", parts: "array" },
  },
  {
    kind: "yandex-image",
    type: "SmartCaptchaTask",
    doc: "yandex-smart-captcha",
    proxy: "none",
    required: ["image", "imgInstructions"],
    fields: { image: "string", imgInstructions: "string", comment: "string" },
  },
  {
    kind: "yandex-puzzle",
    type: "PazlCaptchaTask",
    doc: "yandex-smart-captcha",
    proxy: "none",
    required: ["image", "task"],
    fields: { image: "string", task: "string" },
  },
]
// The Imperva reference uses IncapsulaTask in its table and ImpervaTask in its example.
const imperva = captchaTasks.find((spec) => spec.kind === "imperva")
if (imperva) {
  imperva.fields.websiteUrl = "string"
  captchaTasks.push({ ...imperva, type: "IncapsulaTask" })
}
const alibaba = captchaTasks.find((spec) => spec.kind === "alibaba")
if (alibaba) {
  alibaba.fields.websiteUrl = "string"
  alibaba.fields.UserCertifyId = "string"
}
const keycaptcha = captchaTasks.find((spec) => spec.kind === "keycaptcha")
if (keycaptcha) keycaptcha.fields.s_s_c_user_id = "string|integer"
const binance = captchaTasks.find((spec) => spec.kind === "binance")
if (binance) binance.fields.userAgent = "string"
const basilisk = captchaTasks.find((spec) => spec.kind === "basilisk")
if (basilisk) basilisk.fields.websiteUrl = "string"
captchaTasks.push({
  kind: "vk-image",
  type: "VKCaptchaImageTask",
  doc: "vk-captcha",
  proxy: "none",
  required: ["image", "steps"],
  fields: { image: "string", steps: "string|integer-array" },
})

export function captchaTask(type: string): CaptchaTaskSpec | undefined {
  return captchaTasks.find(
    (spec) =>
      type === spec.type ||
      (spec.proxy === "optional" && type === `${spec.type}${spec.kind === "binance" ? "proxyless" : "Proxyless"}`),
  )
}
export function detectExternalCaptchas(html: string): string[] {
  const sample = html.slice(0, 2_000_000)
  const found = captchaTasks
    .filter((spec) => spec.marker && new RegExp(spec.marker, "i").test(sample))
    .map((spec) => spec.kind)
  // These are alternate solving methods, not separate page widgets.
  if (found.includes("recaptcha-v3"))
    return found.filter((kind) => kind !== "recaptcha-v2" && kind !== "recaptcha-v2-enterprise")
  if (found.includes("recaptcha-v2-enterprise")) return found.filter((kind) => kind !== "recaptcha-v2")
  return [...new Set(found)]
}
export function validCaptchaTask(task: Record<string, unknown>): boolean {
  const spec = typeof task.type === "string" ? captchaTask(task.type) : undefined
  if (!spec) return false
  const reserved = ["type", "proxyType", "proxyAddress", "proxyPort", "proxyLogin", "proxyPassword"]
  if (Object.keys(task).some((key) => !Object.hasOwn(spec.fields, key) && !reserved.includes(key))) return false
  if (
    spec.required.some((key) =>
      key === "websiteURL" && Object.hasOwn(spec.fields, "websiteUrl")
        ? !task.websiteURL && !task.websiteUrl
        : spec.kind === "aws-waf" && key === "websiteKey" && task.jsapiScript
          ? false
          : task[key] === undefined || task[key] === null || task[key] === "",
    )
  )
    return false
  for (const [key, value] of Object.entries(task)) {
    const type = spec.fields[key]
    if (!type) continue
    if (
      type === "string|integer-array" &&
      !(
        (typeof value === "string" && value.length > 0 && value.length <= 65536) ||
        (Array.isArray(value) &&
          value.length > 0 &&
          value.length <= 256 &&
          value.every((item) => Number.isSafeInteger(item) && item >= 0 && item <= 255))
      )
    )
      return false
    if (
      type === "string|integer" &&
      !(
        (typeof value === "string" && value.length > 0 && value.length <= 512) ||
        (typeof value === "number" && Number.isSafeInteger(value))
      )
    )
      return false
    if (type === "string" && (typeof value !== "string" || !value || value.length > 2_000_000)) return false
    if (
      ["integer", "number", "float"].includes(type) &&
      (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value)))
    )
      return false
    if (type === "boolean" && typeof value !== "boolean") return false
    if (
      type.startsWith("array") &&
      (!Array.isArray(value) ||
        !value.length ||
        value.length > 64 ||
        value.some((item) => typeof item !== "string" || !item || item.length > 2_000_000))
    )
      return false
    if (type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) return false
  }
  if (spec.kind === "recaptcha-v3" && ![0.3, 0.7, 0.9].includes(task.minScore as number)) return false
  if (spec.kind === "geetest" && task.version !== undefined && ![3, 4].includes(task.version as number)) return false
  if (
    spec.kind === "geetest" &&
    (task.version === 4
      ? typeof (task.initParameters as { captcha_id?: string })?.captcha_id !== "string" ||
        !(task.initParameters as { captcha_id?: string })?.captcha_id
      : !task.gt || !task.challenge)
  )
    return false
  if (spec.kind === "altcha" && !task.challengeURL && !task.challengeJSON) return false
  if (spec.kind === "aws-waf" && !task.jsapiScript && (!task.iv || !task.context)) return false
  if (["grid", "draw-around", "bounding-box"].includes(spec.kind) && !task.comment && !task.imgInstructions)
    return false
  if (spec.proxy === "none" && task.proxyType) return false
  if (spec.proxy === "required" || (spec.proxy === "optional" && task.type === spec.type)) {
    if (
      !["http", "socks4", "socks5"].includes(String(task.proxyType)) ||
      typeof task.proxyAddress !== "string" ||
      !task.proxyAddress ||
      !/^\d+$/.test(String(task.proxyPort)) ||
      !Number.isInteger(Number(task.proxyPort)) ||
      Number(task.proxyPort) < 1 ||
      Number(task.proxyPort) > 65535
    )
      return false
  }
  return JSON.stringify(task).length <= 3_000_000
}

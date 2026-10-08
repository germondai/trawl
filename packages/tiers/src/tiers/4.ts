import type { BrowserHandle } from "@trawl/browser"
import type { CaptureOptions } from "../utils/capture"
import type { OutboundUrlValidator } from "../utils/outboundPolicy"
import { runBrowserTier } from "./browser"
import type { BrowserTierResult } from "./browserResult"

export type Tier4Result = BrowserTierResult<4>

export function runTier4(
  url: string,
  handle: BrowserHandle,
  maxTimeout: number,
  proxyUrl: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
  validateOutboundUrl?: OutboundUrlValidator,
  screenshot?: boolean,
  capture: CaptureOptions = {},
  ignoreCertificateErrors?: boolean,
): Promise<Tier4Result> {
  return runBrowserTier(
    4,
    url,
    handle,
    maxTimeout,
    proxyUrl,
    extraHeaders,
    method,
    body,
    validateOutboundUrl,
    screenshot,
    capture,
    ignoreCertificateErrors,
  )
}

export function isAndroidUserAgent(userAgent: string): boolean {
  // WebKitGTK can report "Linux; like Android" on desktop.
  return /(?:^|[;(])\s*Android\b/i.test(userAgent)
}

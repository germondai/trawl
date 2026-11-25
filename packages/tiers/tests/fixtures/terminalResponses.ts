export const ACCESS_DENIED = `<html><head><title>Access Denied</title></head><body>
<h1>Access Denied</h1><p>You don't have permission to access this server.</p>
<p>Reference #18.1234</p><a href="https://errors.edgesuite.net/18.1234">Error reference</a>
</body></html>`

export const VERIFICATION_REQUIRED = `<html><head><title>Verification Required</title></head><body>
<h1>Verification Required</h1><p>This site requires registration before automated access.</p>
<form action="/register"><input name="registration"></form></body></html>`

export const CLOUDFLARE_ORIGIN_ERROR = `<html><head><title>fixture | 522: Connection timed out</title></head><body>
<div id="cf-error-details"><h1>Connection timed out</h1><span>Error code 522</span>
<p>Browser Working, Cloudflare Working, Host Error</p></div></body></html>`

export const ORDINARY_RESPONSE_CONTROLS = [
  "<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>A poem.</p></body></html>",
  '<html><head><title>Verification Required</title></head><body><h1>Verification Required</h1><p>Check your email.</p><form action="/register"><input name="registration"></form></body></html>',
  '<html><head><title>Article</title></head><body><article><h1>Access Denied troubleshooting</h1><p>This guide explains verification required errors.</p><a href="https://errors.edgesuite.net/18.1234">Example error reference</a></article></body></html>',
  `<html><head><title>Article</title></head><body><pre>${ACCESS_DENIED.replaceAll("<", "&lt;")}</pre></body></html>`,
  `<html><head><title>Article</title></head><body><template>${VERIFICATION_REQUIRED}</template><p>Template documentation.</p></body></html>`,
  '<html><head><title>Article</title></head><body><p>Error code 522: Host Error</p><pre>&lt;div id="cf-error-details"&gt;</pre></body></html>',
  "<html><head><title>OK</title></head><body><h1>Welcome</h1><p>This is a small public page.</p></body></html>",
]

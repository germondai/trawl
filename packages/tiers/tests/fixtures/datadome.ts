// Real DataDome wall shapes. The `dd` object and the challenge script tell the variants
// apart: i.js is the Device Check, c.js the interactive slider.
export const DATADOME_INTERSTITIAL = `<html><head><title>example.test</title>
<style>#cmsg{animation: A 1.5s;}@keyframes A{0%{opacity:0;}99%{opacity:0;}100%{opacity:1;}}</style></head>
<body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p>
<script data-cfasync="false">var dd={'rt':'i','cid':'AHrlqAAAAAMACAOLE2sBBRMATaDxmw==','hsh':'13C44BAB3C9D728ABD66E2A9F0233C','b':1501854,'s':48047,'host':'geo.captcha-delivery.com'}</script>
<script data-cfasync="false" src="https://ct.captcha-delivery.com/i.js"></script></body></html>`

export const DATADOME_CAPTCHA = `<html><head><title>example.test</title></head>
<body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p>
<script data-cfasync="false">var dd={'rt':'c','cid':'AHrlqAAAAAMAo6M9v7QAWXJFuQ==','hsh':'A55FBF4311ED6F1BF9911EB71931D5','b':1239798,'s':17434,'host':'geo.captcha-delivery.com'}</script>
<script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>`

// XHR-shaped block: the challenge URL arrives as JSON instead of a page.
export const DATADOME_JSON_CAPTCHA = `{"url":"https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqAAAAAMAo6M9v7QAWXJFuQ%3D%3D&hash=A55FBF4311ED6F1BF9911EB71931D5&cid=nfMz~sT3&t=fe&referer=https%3A%2F%2Fexample.test%2F&s=17434&e=8b4b"}`

// `t=bv` is the hard block: the delivered page reads "Access denied", no widget to solve.
export const DATADOME_JSON_HARD_BLOCK = `{"url":"https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqAAAAAMAo6M9v7QAWXJFuQ%3D%3D&hash=A55FBF4311ED6F1BF9911EB71931D5&cid=nfMz~sT3&t=bv&referer=https%3A%2F%2Fexample.test%2F&s=17434&e=8b4b"}`

// Ordinary page of a DataDome-protected site: the client tag ships on every page.
export const DATADOME_TAGGED_PAGE = `<html><head><title>Shop</title>
<script src="https://js.datadome.co/tags.js" async></script></head>
<body><h1>Results</h1><p>12 items</p></body></html>`

// Verbatim shape of a live idealista.it block (session identifiers replaced). The hard
// block carries `t` inside the `dd` object, not as a query parameter, and pairs it with
// `rt: 'c'`: reading `rt` alone would call this a solvable slider.
export const DATADOME_HTML_HARD_BLOCK = `<html lang="it"><head><title>idealista.it</title><style>#cmsg{animation: A 1.5s;}@keyframes A{0%{opacity:0;}99%{opacity:0;}100%{opacity:1;}}</style></head><body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p><script data-cfasync="false">var dd={'rt':'c','cid':'AHrlqAAAAAMA_OZ7HfRgX2wAufK3kA==','hsh':'AC81AADC3279CA4C7B968B717FBB30','t':'bv','qp':'','s':17156,'e':'3ce1daac82b52b53723d1cea77f9f9f2','host':'geo.captcha-delivery.com','cookie':'3VF_ImHd7bW6O63Zb~4Kxl0LtFajjaBn'}</script><script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>`

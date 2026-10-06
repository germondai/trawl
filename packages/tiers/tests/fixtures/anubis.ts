// Minimal challenge envelope used by Anubis v1.27 and its current challenge pages.
// Synthetic identifiers keep real challenges and client metadata out of fixtures.
export const ANUBIS_CHALLENGE = `<html><head><title>Making sure you're not a bot!</title>
<script id="anubis_version" type="application/json">"v1.27.0"</script>
<script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"fast","difficulty":1},"challenge":{"id":"fixture-challenge","randomData":"fixture-data","spent":false}}</script>
</head><body><p>Protected by Anubis</p>
<script type="module" src="/.within.website/x/cmd/anubis/static/js/main.mjs"></script></body></html>`

export const ANUBIS_ARTICLE = `<html><head><title>Anubis documentation</title></head><body>
<p>Anubis uses proof of work. Protected by Anubis. Configuration keys include anubis_version and anubis_challenge.</p>
<pre>&lt;script id="anubis_challenge" type="application/json"&gt;example&lt;/script&gt;</pre></body></html>`

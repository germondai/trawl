// Captured from https://anubis.techaro.lol (Anubis v1.28.0-pre, metarefresh method),
// served at HTTP 200. Anubis's own documentation site is protected by Anubis itself.
export const ANUBIS_CHALLENGE = `<!DOCTYPE html><html lang="en"><head><title>Making sure you're not a bot!</title><link rel="stylesheet" href="/.within.website/x/xess/xess.min.css?cachebuster=v1.28.0-pre2.0.20261005010951-9bbfcb1bdc85"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex,nofollow"><style>
body, html { height: 100%; display: flex; justify-content: center; align-items: center; }
#progress { display: none; width: min(20rem, 90%); }
</style><script id="anubis_version" type="application/json">"v1.28.0-pre2.0.20261005010951-9bbfcb1bdc85"
</script><script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"metarefresh","difficulty":1},"challenge":{"issuedAt":"2026-10-06T00:20:58.299864129Z","id":"01a10e95-c33b-7cfd-a8d6-45a71e7139bf","method":"metarefresh","randomData":"ea7ff97b581c1c930d68a1ae4988650df1daec63d250253b26d13be39d5cfff87341d253c91fd559ccbe0440ca2980c77241c2205775f7865927c9d919e67119","difficulty":1,"spent":false}}
</script><script id="anubis_base_prefix" type="application/json">""
</script><script id="anubis_public_url" type="application/json">""
</script></head><body id="top"><script type="ignore"><a href="/.within.website/x/cmd/anubis/api/honeypot/3f59f780-f1f9-4d5a-a76b-306138000fc5/init">Don't click me</a></script><main><h1 id="title" class="centered-div">Making sure you're not a bot!</h1><div class="centered-div"><img id="image" style="width:100%;max-width:256px;" src="/.within.website/x/cmd/anubis/static/img/pensive.webp?cacheBuster=v1.28.0-pre2.0.20261005010951-9bbfcb1bdc85"><p id="status">Loading...</p><p>Please wait a moment while we ensure the security of your connection.</p></div><footer><div class="centered-div"><p>Protected by <a href="https://github.com/TecharoHQ/anubis">Anubis</a> From <a href="https://techaro.lol">Techaro</a>.</p><p>This website is running Anubis version <code>v1.28.0-pre2.0.20261005010951-9bbfcb1bdc85</code>.</p></div></footer></main></body></html>`

// A proof-of-work variant of the challenge (method changed, markup identical otherwise).
export const ANUBIS_POW_CHALLENGE = ANUBIS_CHALLENGE.replace(
  `{"rules":{"algorithm":"metarefresh","difficulty":1}`,
  `{"rules":{"algorithm":"fast","difficulty":4}`,
).replace(`"method":"metarefresh"`, `"method":"proof-of-work"`)

export const ANUBIS_DOCS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><title>Self-hosting Anubis | Anubis docs</title></head>
<body>
<article>
<h1>Custom challenge templates</h1>
<p>Templates may embed <code>&lt;script id="anubis_challenge" type="application/json"&gt;&lt;/script&gt;</code>
and link assets from the <code>/.within.website/x/cmd/anubis/</code> path prefix.</p>
</article>
</body>
</html>`

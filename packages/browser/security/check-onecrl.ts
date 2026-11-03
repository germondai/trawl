// Check effective certificate storage in a fresh profile, not just bundle contents.
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createConnection, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function* messages(socket: Socket): AsyncGenerator<unknown> {
  let buffer = Buffer.alloc(0)
  for await (const chunk of socket) {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const separator = buffer.indexOf(58)
      if (separator < 0) break
      const length = Number(buffer.subarray(0, separator).toString())
      assert(Number.isSafeInteger(length) && length > 0 && length < 1_000_000)
      if (buffer.length < separator + 1 + length) break
      yield JSON.parse(buffer.subarray(separator + 1, separator + 1 + length).toString())
      buffer = buffer.subarray(separator + 1 + length)
    }
  }
  throw new Error("Marionette disconnected")
}

const listener = createServer()
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
const address = listener.address()
assert(address && typeof address !== "string")
const port = address.port
await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))

// Generous: emulated cross-architecture builds run the browser far slower.
const timeoutMs = 120_000
const profile = await mkdtemp(join(tmpdir(), "trawl-onecrl-"))
let browserProcess: ReturnType<typeof Bun.spawn> | undefined
let socket: Socket | undefined
try {
  // External requests hit a closed loopback port. No cached profile or update service.
  await writeFile(
    join(profile, "user.js"),
    `user_pref("marionette.port", ${port});
user_pref("network.proxy.type", 1);
user_pref("network.proxy.http", "127.0.0.1");
user_pref("network.proxy.http_port", 9);
user_pref("network.proxy.ssl", "127.0.0.1");
user_pref("network.proxy.ssl_port", 9);
user_pref("network.proxy.no_proxies_on", "");
user_pref("security.OCSP.enabled", 0);
`,
  )
  const binary = join(Bun.env.CAMOUFOX_INSTALL_DIR || "/opt/camoufox", "camoufox")
  browserProcess = Bun.spawn(
    [
      binary,
      "--headless",
      "--no-remote",
      "--profile",
      profile,
      "--marionette",
      "--remote-allow-system-access",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "inherit" },
  )
  const deadline = Date.now() + timeoutMs
  while (!socket) {
    try {
      socket = await new Promise<Socket>((resolve, reject) => {
        const connection = createConnection({ host: "127.0.0.1", port })
        connection.once("error", reject)
        connection.once("connect", () => {
          connection.off("error", reject)
          resolve(connection)
        })
      })
    } catch (error) {
      if (Date.now() >= deadline || browserProcess.exitCode !== null) throw error
      await Bun.sleep(100)
    }
  }
  socket.setTimeout(timeoutMs, () => socket?.destroy(new Error("Marionette timed out")))
  const replies = messages(socket)
  await replies.next() // Server greeting.
  let id = 0
  async function call(command: string, parameters: object) {
    const payload = JSON.stringify([0, ++id, command, parameters])
    socket?.write(`${Buffer.byteLength(payload)}:${payload}`)
    while (true) {
      const { value: reply } = await replies.next()
      if (Array.isArray(reply) && reply[0] === 1 && reply[1] === id) {
        assert.equal(reply[2], null, JSON.stringify(reply[2]))
        return reply[3]
      }
    }
  }
  await call("WebDriver:NewSession", { capabilities: {} })
  await call("WebDriver:SetTimeouts", { script: timeoutMs })
  await call("Marionette:SetContext", { value: "chrome" })
  // Mozilla Bug 2083382 issuer/serials, independently checked against cert_storage.
  const result = await call("WebDriver:ExecuteAsyncScript", {
    script: `
const storage = Cc["@mozilla.org/security/certstorage;1"].getService(Ci.nsICertStorage);
const issuer = Array.from(atob("MFYxCzAJBgNVBAYTAklOMSUwIwYDVQQKDBxlTXVkaHJhIFRlY2hub2xvZ2llcyBMaW1pdGVkMSAwHgYDVQQDDBdlbVNpZ24gUm9vdCBUTFMgQ0EgLSBHMw=="), c => c.charCodeAt(0));
const serials = [
  "00a4aee678f23362b4c0e460b772f214", "6cada367fb1c100088120ea202d568",
  "00c7c41efe92d825f05eae841a4a82c1", "588b2e3c2bb8cda13e1a1209254321",
  "296926c227a3a1526392b19482a504", "008009928a64107601af05fa2f19f109",
];
const done = arguments[arguments.length - 1];
const deadline = Date.now() + ${timeoutMs - 10_000};
function check() {
  const revoked = serials.map(serial => storage.getRevocationState(
    issuer, serial.match(/../g).map(byte => parseInt(byte, 16)), [], []
  ) === Ci.nsICertStorage.STATE_ENFORCE);
  if (!revoked.every(Boolean) && Date.now() < deadline) {
    setTimeout(check, 50);
    return;
  }
  // This check opens a window, so idle startup would also pass; pooled browsers have none.
  const module = "resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs";
  const registered = category => {
    try { return Services.catMan.getCategoryEntry(category, module); } catch { return null; }
  };
  done({
    revoked,
    control: storage.getRevocationState(issuer, [1], [], []) === Ci.nsICertStorage.STATE_UNSET,
    beforeUi: registered("browser-before-ui-startup"),
    idle: registered("browser-idle-startup"),
  });
}
check();`,
    args: [],
  })
  assert.deepEqual(result.value, {
    revoked: [true, true, true, true, true, true],
    control: true,
    beforeUi: "RemoteSecuritySettings.init",
    idle: null,
  })
  console.log("PASS: fresh-profile certificate storage enforces all six eMudhra revocations offline")
} finally {
  socket?.destroy()
  if (browserProcess) {
    browserProcess.kill()
    await Promise.race([browserProcess.exited, Bun.sleep(2000)])
    if (browserProcess.exitCode === null) browserProcess.kill("SIGKILL")
    await browserProcess.exited
  }
  await rm(profile, { recursive: true, force: true })
}

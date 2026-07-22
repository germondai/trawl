import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import forge from "node-forge"

// A tiny on-the-fly certificate authority for the MITM forward proxy.
//
// The proxy terminates the client's TLS so it can re-issue each request through the
// browser pool (see server.ts). To do that it must present a certificate the client
// trusts for the *target* host. We generate one long-lived CA (persisted to disk so
// the same CA cert can be installed into the client's trust store once) and mint a
// short per-host leaf certificate on demand, signed by that CA.
//
// The CA private key never leaves this container. Installing the CA cert in a client
// lets THIS proxy impersonate any host to THAT client — so the proxy must only ever be
// reachable by the trusted client (e.g. bound to localhost / a private Docker netns).
export class MitmCa {
  private readonly caCert: forge.pki.Certificate
  private readonly caKey: forge.pki.rsa.PrivateKey
  private readonly leafKeys: forge.pki.rsa.KeyPair
  private readonly certCache = new Map<string, string>()
  readonly caCertPem: string
  readonly caCertPath: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.caCertPath = join(dir, "ca.crt")
    const keyPath = join(dir, "ca.key")

    if (existsSync(this.caCertPath) && existsSync(keyPath)) {
      this.caCertPem = readFileSync(this.caCertPath, "utf8")
      this.caCert = forge.pki.certificateFromPem(this.caCertPem)
      this.caKey = forge.pki.privateKeyFromPem(readFileSync(keyPath, "utf8"))
    } else {
      const { cert, key } = createCaCertificate()
      this.caCert = cert
      this.caKey = key
      this.caCertPem = forge.pki.certificateToPem(cert)
      writeFileSync(this.caCertPath, this.caCertPem)
      writeFileSync(keyPath, forge.pki.privateKeyToPem(key), { mode: 0o600 })
    }

    // One leaf keypair shared across every minted host cert — only the certificate
    // (subject + SAN) differs per host, so there's no need to pay RSA keygen per host.
    this.leafKeys = forge.pki.rsa.generateKeyPair(2048)
  }

  // The shared leaf private key (PEM) — every minted host cert is signed for this key,
  // so one key serves all per-host TLS servers.
  get leafKeyPem(): string {
    return forge.pki.privateKeyToPem(this.leafKeys.privateKey)
  }

  // Returns a leaf certificate (PEM) valid for `host`, minting + caching on first use.
  // Serve the leaf ALONE: the client trusts our CA directly (it's the root), so no chain
  // is needed. (Appending the CA made Bun's TLS stack pick the wrong end-entity cert.)
  leafCertPem(host: string): string {
    const cached = this.certCache.get(host)
    if (cached) return cached
    const pem = forge.pki.certificateToPem(this.mintLeaf(host))
    this.certCache.set(host, pem)
    return pem
  }

  private mintLeaf(host: string): forge.pki.Certificate {
    const cert = forge.pki.createCertificate()
    cert.publicKey = this.leafKeys.publicKey
    cert.serialNumber = randomSerial()
    // Backdate 1h to tolerate mild clock skew between proxy and client containers.
    cert.validity.notBefore = new Date(Date.now() - 3600_000)
    cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 3600_000) // 397d — CA/B leaf max
    const subject = [{ name: "commonName", value: host }]
    cert.setSubject(subject)
    cert.setIssuer(this.caCert.subject.attributes)
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: altNamesFor(host) },
    ])
    cert.sign(this.caKey, forge.md.sha256.create())
    return cert
  }
}

function createCaCertificate(): {
  cert: forge.pki.Certificate
  key: forge.pki.rsa.PrivateKey
} {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = randomSerial()
  cert.validity.notBefore = new Date(Date.now() - 3600_000)
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600_000) // 10y
  const attrs = [
    { name: "commonName", value: "TRAWL MITM Proxy CA" },
    { name: "organizationName", value: "TRAWL" },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert, key: keys.privateKey }
}

// SAN must carry an IP entry (type 7) for literal-IP hosts and a DNS entry (type 2)
// otherwise, or strict clients reject the leaf. node-forge's TypeScript types narrow
// `type` to string at the CertificateField boundary, but the runtime accepts the
// numeric GeneralName tags ("2" / "7") — the cast below bridges the two.
function altNamesFor(host: string): forge.pki.CertificateField[] {
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  const entry = isIp ? { type: "7", value: host } : { type: "2", value: host }
  return [entry]
}

// 16 random hex bytes; leading 0 keeps it a positive integer for strict parsers.
function randomSerial(): string {
  const bytes = forge.random.getBytesSync(16)
  return `00${forge.util.bytesToHex(bytes)}`
}

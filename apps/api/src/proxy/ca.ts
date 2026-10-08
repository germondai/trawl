import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
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
// lets THIS proxy impersonate any host to THAT client - so the proxy must only ever be
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
    const initialized = withCaInitializationLock(dir, () => initializeCa(dir, this.caCertPath, keyPath))
    this.caCert = initialized.cert
    this.caKey = initialized.key
    this.caCertPem = initialized.pem

    // One leaf keypair shared across every minted host cert - only the certificate
    // (subject + SAN) differs per host, so there's no need to pay RSA keygen per host.
    this.leafKeys = forge.pki.rsa.generateKeyPair(2048)
  }

  // The shared leaf private key (PEM) - every minted host cert is signed for this key,
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
    cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 3600_000) // 397d - CA/B leaf max
    const subject = [{ name: "commonName", value: host }]
    cert.setSubject(subject)
    cert.setIssuer(this.caCert.subject.attributes)
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: altNamesFor(host) },
      { name: "subjectKeyIdentifier" },
      {
        name: "authorityKeyIdentifier",
        keyIdentifier: this.caCert.generateSubjectKeyIdentifier().getBytes(),
      },
    ])
    cert.sign(this.caKey, forge.md.sha256.create())
    return cert
  }
}

function initializeCa(
  dir: string,
  certPath: string,
  keyPath: string,
): { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey; pem: string } {
  const certExists = existsSync(certPath)
  const keyExists = existsSync(keyPath)
  if (certExists !== keyExists) {
    throw new Error(
      `[proxy] Incomplete MITM CA in ${dir}: ca.crt and ca.key must either both exist or both be absent; refusing to generate a new identity`,
    )
  }

  if (!certExists) {
    const { cert, key } = createCaCertificate()
    const pem = forge.pki.certificateToPem(cert)
    writeFileSync(certPath, pem)
    writeFileSync(keyPath, forge.pki.privateKeyToPem(key), { mode: 0o600 })
    return { cert, key, pem }
  }

  const loaded = loadCa(certPath, keyPath)
  if (loaded.cert.getExtension({ name: "subjectKeyIdentifier" })) return loaded

  const cert = addSubjectKeyIdentifier(loaded.cert, loaded.key)
  const pem = forge.pki.certificateToPem(cert)
  replaceFileAtomically(certPath, pem)
  console.warn(
    `[proxy] Updated MITM CA certificate at ${certPath} with a Subject Key Identifier. The CA key is unchanged, but clients pinning the certificate fingerprint must re-import ca.crt into their trust store.`,
  )
  return { cert, key: loaded.key, pem }
}

function withCaInitializationLock<T>(dir: string, initialize: () => T): T {
  const lockPath = join(dir, ".ca.lock")
  const deadline = Date.now() + 10_000
  let descriptor: number | undefined

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() >= deadline) {
        throw new Error(
          `[proxy] Timed out waiting for MITM CA initialization lock ${lockPath}; verify that no other instance is starting and remove a stale lock only when it is safe`,
        )
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }

  try {
    return initialize()
  } finally {
    closeSync(descriptor)
    unlinkSync(lockPath)
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
    { name: "subjectKeyIdentifier" },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert, key: keys.privateKey }
}

function loadCa(
  certPath: string,
  keyPath: string,
): { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey; pem: string } {
  try {
    const pem = readFileSync(certPath, "utf8")
    const cert = forge.pki.certificateFromPem(pem)
    const key = forge.pki.privateKeyFromPem(readFileSync(keyPath, "utf8"))
    const basicConstraints = cert.getExtension({ name: "basicConstraints" }) as { cA?: boolean } | undefined
    if (!basicConstraints?.cA || !cert.isIssuer(cert) || !cert.verify(cert)) {
      throw new Error("ca.crt is not a valid self-signed CA certificate")
    }
    if (cert.getExtension({ name: "subjectKeyIdentifier" }) && !cert.verifySubjectKeyIdentifier()) {
      throw new Error("ca.crt contains a Subject Key Identifier that does not match its public key")
    }
    if (!rsaKeysMatch(cert.publicKey as forge.pki.rsa.PublicKey, key)) {
      throw new Error("ca.crt public key does not match ca.key")
    }
    return { cert, key, pem }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`[proxy] Cannot safely load MITM CA from ${certPath}: ${message}`)
  }
}

function rsaKeysMatch(publicKey: forge.pki.rsa.PublicKey, privateKey: forge.pki.rsa.PrivateKey): boolean {
  if (!publicKey?.n || !publicKey.e) return false
  return (
    publicKey.n.toString(16) === privateKey.n.toString(16) && publicKey.e.toString(16) === privateKey.e.toString(16)
  )
}

function addSubjectKeyIdentifier(source: forge.pki.Certificate, key: forge.pki.rsa.PrivateKey): forge.pki.Certificate {
  const cert = forge.pki.createCertificate()
  cert.version = source.version
  cert.publicKey = source.publicKey
  cert.serialNumber = source.serialNumber
  cert.validity.notBefore = new Date(source.validity.notBefore)
  cert.validity.notAfter = new Date(source.validity.notAfter)
  cert.setSubject(source.subject.attributes)
  cert.setIssuer(source.issuer.attributes)
  cert.setExtensions([...source.extensions, { name: "subjectKeyIdentifier" }])
  cert.sign(key, forge.md.sha256.create())
  return cert
}

function replaceFileAtomically(path: string, contents: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${forge.util.bytesToHex(forge.random.getBytesSync(8))}`
  try {
    writeFileSync(temporaryPath, contents, { mode: 0o644, flag: "wx" })
    renameSync(temporaryPath, path)
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    throw error
  }
}

// SAN must carry an IP entry (type 7) for literal-IP hosts and a DNS entry (type 2)
// otherwise, or strict clients reject the leaf. node-forge's TypeScript types narrow
// `type` to string at the CertificateField boundary, but the runtime accepts the
// numeric GeneralName tags ("2" / "7") - the cast below bridges the two.
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

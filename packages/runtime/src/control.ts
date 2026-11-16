import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, unlinkSync } from "node:fs"
import { readFile, rm, stat } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { join } from "node:path"
import { type RuntimePaths, runtimePaths } from "./paths"
import { atomicJson, privateDirectory } from "./store"

export interface InstanceState {
  pid: number
  token: string
  socket: string
  baseURL: string
  owner: "desktop" | "cli" | "foreground"
  startedAt: string
  dashboardToken?: string
  shutdownDrainMs?: number
  listenHost?: string
}
export interface InstanceStatus extends Omit<InstanceState, "token" | "socket" | "dashboardToken"> {
  running: boolean
}
const lineLimit = 16384
export async function instanceState(paths = runtimePaths()): Promise<InstanceState | undefined> {
  try {
    if ((await stat(paths.state)).size > lineLimit) throw new Error("Invalid instance state")
    const raw = await readFile(paths.state, "utf8")
    if (raw.length > lineLimit) throw new Error("Invalid instance state")
    const state = JSON.parse(raw) as InstanceState
    if (
      !Number.isInteger(state.pid) ||
      state.pid < 1 ||
      !/^[a-f0-9]{64}$/.test(state.token) ||
      typeof state.socket !== "string" ||
      typeof state.baseURL !== "string" ||
      !["desktop", "cli", "foreground"].includes(state.owner)
    )
      throw new Error("Invalid instance state")
    const expected =
      process.platform === "win32" ? `\\\\.\\pipe\\trawl-${state.token.slice(0, 24)}` : join(paths.run, "control.sock")
    if (state.socket !== expected) throw new Error("Invalid control socket")
    return state
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}
export async function control(action: "status" | "stop", paths = runtimePaths()): Promise<InstanceStatus | undefined> {
  const state = await instanceState(paths)
  if (!state) return
  return new Promise((resolve, reject) => {
    const socket = createConnection(state.socket)
    let output = ""
    socket.setTimeout(3000)
    socket.on("connect", () => socket.write(`${JSON.stringify({ action, token: state.token })}\n`))
    socket.on("data", (data) => {
      output += data.toString()
      if (output.length > lineLimit) {
        socket.destroy()
        reject(new Error("Invalid control response"))
        return
      }
      if (output.includes("\n")) {
        socket.destroy()
        try {
          const response = JSON.parse(output.split("\n")[0])
          if (response.error) reject(new Error(response.error))
          else resolve(response)
        } catch {
          reject(new Error("Invalid control response"))
        }
      }
    })
    socket.on("timeout", () => {
      socket.destroy()
      reject(new Error("Local control timed out"))
    })
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code || "")) resolve(undefined)
      else reject(error)
    })
    socket.on("end", () => {
      if (!output.includes("\n")) reject(new Error("Incomplete control response"))
    })
  })
}
export async function lockInstance(paths: RuntimePaths) {
  const { default: lockfile } = await import("proper-lockfile")
  const previous = await instanceState(paths)
  let dead = false
  if (previous) {
    try {
      process.kill(previous.pid, 0)
    } catch (error) {
      dead = (error as NodeJS.ErrnoException).code === "ESRCH"
    }
  }
  try {
    return await lockfile.lock(paths.state, {
      realpath: false,
      lockfilePath: join(paths.run, "instance.lock"),
      stale: 5000,
      update: 1000,
      retries: dead ? { retries: 6, minTimeout: 1000, maxTimeout: 1000, factor: 1 } : 0,
    })
  } catch {
    throw new Error("A managed instance is already running or starting; retry after five seconds after a crash")
  }
}
export async function startControl(
  paths: RuntimePaths,
  details: Pick<InstanceState, "baseURL" | "owner" | "dashboardToken" | "shutdownDrainMs" | "listenHost">,
  shutdown: () => void,
) {
  await privateDirectory(paths.run)
  if (await control("status", paths)) throw new Error("A managed TRAWL instance is already running")
  const release = await lockInstance(paths)
  const token = randomBytes(32).toString("hex")
  const socket =
    process.platform === "win32" ? `\\\\.\\pipe\\trawl-${token.slice(0, 24)}` : join(paths.run, "control.sock")
  if (process.platform !== "win32") await rm(socket, { force: true })
  const state: InstanceState = { pid: process.pid, token, socket, ...details, startedAt: new Date().toISOString() }
  const status: InstanceStatus = {
    pid: state.pid,
    baseURL: state.baseURL,
    owner: state.owner,
    startedAt: state.startedAt,
    running: true,
    shutdownDrainMs: state.shutdownDrainMs,
    listenHost: state.listenHost,
  }
  const server = createServer((client) => {
    let input = ""
    let answered = false
    client.setTimeout(1000, () => client.destroy())
    client.on("error", () => {})
    client.on("data", (data) => {
      if (answered) return
      input += data.toString()
      if (input.length > lineLimit) {
        client.destroy()
        return
      }
      if (!input.includes("\n")) return
      answered = true
      try {
        const request = JSON.parse(input.split("\n")[0])
        if (
          typeof request.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(request.token) ||
          !timingSafeEqual(Buffer.from(request.token), Buffer.from(token)) ||
          !["status", "stop"].includes(request.action)
        ) {
          client.end(`${JSON.stringify({ error: "Unauthorized control request" })}\n`)
          return
        }
        client.end(`${JSON.stringify(status)}\n`, () => {
          if (request.action === "stop") shutdown()
        })
      } catch {
        client.destroy()
      }
    })
  })
  server.maxConnections = 8
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socket, () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
    await atomicJson(paths.state, state)
  } catch (error) {
    server.close()
    await release()
    throw error
  }
  const clean = () => {
    try {
      if (JSON.parse(readFileSync(paths.state, "utf8")).token === token) {
        unlinkSync(paths.state)
        if (process.platform !== "win32") unlinkSync(socket)
      }
    } catch {}
  }
  process.once("exit", clean)
  return async () => {
    process.removeListener("exit", clean)
    server.close()
    const current = await instanceState(paths).catch(() => undefined)
    if (current?.token === token) {
      await rm(paths.state, { force: true })
      if (process.platform !== "win32") await rm(socket, { force: true })
    }
    await release()
  }
}

'use client'
// Socket client for the REDLINE agent service.
//
// Two ways to reach the :3003 service, tried in parallel (first to connect
// wins, the loser is closed):
//   gateway — same-origin '/?XTransformPort=3003' (space-z preview gateway
//             rewrites the port; also any reverse proxy that routes on it)
//   direct  — protocol//hostname:3003 with path '/' (localhost dev, LAN, any
//             direct deployment — the agent service sets path: '/')
// The winning strategy is remembered in localStorage for instant connects.
//
// getSocket() returns a stable facade: 'on'/'once'/'off' attach to every
// candidate so listeners survive the race; 'emit' goes to the active socket
// (or is buffered until one connects). No caller needs to know which
// transport won.
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client'

const DIRECT_PORT = 3003
const LS_KEY = 'redline.socketStrategy'
const OPTS: Partial<ManagerOptions & SocketOptions> = {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 20,
  reconnectionDelay: 1200,
  timeout: 12000,
}

type Strategy = 'gateway' | 'direct'

let facade: Socket | null = null
let active: Socket | null = null
let candidates: Socket[] = []
let pendingEmits: unknown[][] = []

function strategyOf(s: Socket): Strategy {
  return (s as unknown as { __strategy: Strategy }).__strategy
}

function build(strategy: Strategy): Socket {
  const s =
    strategy === 'direct'
      ? io(`${window.location.protocol}//${window.location.hostname}:${DIRECT_PORT}`, {
          ...OPTS,
          path: '/', // the agent service listens on '/', not '/socket.io'
        })
      : io('/?XTransformPort=3003', { ...OPTS })
  ;(s as unknown as { __strategy: Strategy }).__strategy = strategy
  return s
}

function initialize(): Socket {
  let order: Strategy[] = ['gateway', 'direct']
  try {
    const remembered = window.localStorage.getItem(LS_KEY)
    if (remembered === 'direct') order = ['direct', 'gateway']
  } catch { /* private mode etc. */ }
  if (!window.location.hostname) order = ['gateway'] // about:srcdoc safety

  candidates = order.map(build)

  for (const s of candidates) {
    s.once('connect', () => {
      if (active && active !== s) {
        s.close()
        return
      }
      active = s
      try { window.localStorage.setItem(LS_KEY, strategyOf(s)) } catch { /* ignore */ }
      for (const other of candidates) if (other !== s) other.close()
      // flush anything emitted before a candidate won the race
      const queued = pendingEmits
      pendingEmits = []
      for (const args of queued) (s as unknown as { emit: (...a: unknown[]) => void }).emit(...args)
    })
  }

  facade = new Proxy({} as Socket, {
    get(_t, prop: string | symbol) {
      if (prop === 'on' || prop === 'once' || prop === 'off') {
        return (...args: unknown[]) => {
          for (const c of candidates) {
            try { (c as unknown as Record<string, (...a: unknown[]) => void>)[prop as string](...args) } catch { /* closed */ }
          }
          return facade
        }
      }
      if (prop === 'emit') {
        return (...args: unknown[]) => {
          if (active) (active as unknown as { emit: (...a: unknown[]) => void }).emit(...args)
          else if (candidates.length) pendingEmits.push(args)
        }
      }
      const target = active ?? candidates[0]
      if (!target) return undefined
      const v = (target as unknown as Record<string | symbol, unknown>)[prop]
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  }) as Socket
  return facade
}

export function getSocket(): Socket | null {
  if (typeof window === 'undefined') return null
  return facade ?? initialize()
}

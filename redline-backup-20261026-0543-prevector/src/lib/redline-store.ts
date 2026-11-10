'use client'
import { create } from 'zustand'
import type { Mode, OSInfo, ThinkingLevel } from '@/core/types'

export type View = 'dashboard' | 'console' | 'terminal' | 'engagements' | 'targets' | 'arsenal' | 'market' | 'knowledge' | 'audit' | 'settings'

export interface SystemState {
  mode: Mode
  thinkingLevel: ThinkingLevel
  killSwitch: boolean
  endurance: boolean
  budgets: { stepsPerTurn: number; turnSeconds: number; commandSeconds: number }
  provider: string
  model: string
  os: OSInfo | null
  charter: {
    hosts: string[]
    networks: string[]
    hosts_map: Record<string, string[]>
    rules: Record<string, unknown>
    exploitation: Record<string, unknown>
    deception: Record<string, unknown>
  } | null
  tools: { id: string; name: string; category: string; availability: string; builtin: boolean }[]
  stats: { actions: number; refusals: number; findings: number; honeypots: number; pendingApprovals: number }
}

interface RedlineState {
  view: View
  system: SystemState | null
  socketConnected: boolean
  setView: (v: View) => void
  setSocketConnected: (b: boolean) => void
  setSystem: (s: SystemState) => void
  setMode: (m: Mode) => void
  setThinkingLevel: (level: ThinkingLevel) => void
  setKillSwitch: (b: boolean) => void
  refreshSystem: () => Promise<void>
  sessionId: string
}

export const useRedline = create<RedlineState>((set, get) => ({
  view: 'dashboard',
  system: null,
  socketConnected: false,
  sessionId: `web-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
  setView: (v) => set({ view: v }),
  setSocketConnected: (b) => set({ socketConnected: b }),
  setSystem: (s) => set({ system: s }),
  setMode: (m) => {
    const cur = get().system
    if (cur) set({ system: { ...cur, mode: m } })
    else set({ system: { mode: m } as SystemState })
  },
  setThinkingLevel: (level) => {
    const cur = get().system
    if (cur) set({ system: { ...cur, thinkingLevel: level } })
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinkingLevel: level }),
    }).catch(() => {})
  },
  setKillSwitch: (b) => {
    const cur = get().system
    if (cur) set({ system: { ...cur, killSwitch: b } })
  },
  refreshSystem: async () => {
    try {
      const r = await fetch('/api/system', { cache: 'no-store' })
      if (r.ok) {
        const data = await r.json()
        set({
          system: {
            mode: data.mode,
            thinkingLevel: data.thinkingLevel ?? 'medium',
            killSwitch: data.killSwitch,
            endurance: data.endurance ?? false,
            budgets: data.budgets,
            provider: data.provider,
            model: data.model,
            os: data.os,
            charter: data.charter,
            tools: data.tools ?? [],
            stats: data.stats,
          },
        })
      }
    } catch { /* transient */ }
  },
}))

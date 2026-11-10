'use client'
import { useEffect, useState } from 'react'
import { useRedline, type View } from '@/lib/redline-store'
import { getSocket } from '@/lib/socket'
import { initFeed } from '@/lib/agent-feed'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import {
  LayoutDashboard, Terminal, SquareTerminal, Crosshair, Radar, Swords, Store, BookOpen, ScrollText, Settings as SettingsIcon,
  Menu, Shield, Cpu,
} from 'lucide-react'
import { GlitchTitle, StatusDot } from '@/components/cyber/primitives'
import { ModeSwitcher, KillSwitchButton, UnrestrictedBanner } from '@/components/cyber/mode-switcher'
import { ThemeToggle } from '@/components/cyber/theme-toggle'
import DashboardView from '@/components/views/dashboard'
import ConsoleView from '@/components/views/console'
import TerminalView from '@/components/views/terminal'
import EngagementsView from '@/components/views/engagements'
import TargetsView from '@/components/views/targets'
import ArsenalView from '@/components/views/arsenal'
import MarketView from '@/components/views/market'
import KnowledgeView from '@/components/views/knowledge'
import AuditView from '@/components/views/audit'
import SettingsView from '@/components/views/settings'

const NAV: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'console', label: 'Console', icon: Terminal },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'engagements', label: 'Engagements', icon: Crosshair },
  { id: 'targets', label: 'Targets', icon: Radar },
  { id: 'arsenal', label: 'Arsenal', icon: Swords },
  { id: 'market', label: 'Market', icon: Store },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'audit', label: 'Audit', icon: ScrollText },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
]

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const view = useRedline((s) => s.view)
  const setView = useRedline((s) => s.setView)
  const connected = useRedline((s) => s.socketConnected)
  const system = useRedline((s) => s.system)
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="px-1 pt-2">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-[var(--neon-cyan)]" aria-hidden />
          <GlitchTitle text="REDLINE" className="text-lg text-[var(--neon-cyan)]" />
        </div>
        <div className="mt-1 text-[9px] uppercase tracking-[0.32em] text-muted-foreground">
          AI red team operations
        </div>
      </div>

      <nav className="mt-2 flex flex-1 flex-col gap-0.5" aria-label="Primary">
        {NAV.map((item) => {
          const Icon = item.icon
          const active = view === item.id
          return (
            <button
              key={item.id}
              onClick={() => { setView(item.id); onNavigate?.() }}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'btn-neon flex items-center gap-2.5 rounded-sm border px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.18em] transition-colors',
                active
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground'
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', active && 'drop-shadow-[0_0_6px_rgba(0,229,255,0.8)]')} aria-hidden />
              {item.label}
            </button>
          )
        })}
      </nav>

      <div className="space-y-2 border-t border-border/60 pt-3">
        <div className="text-[9px] uppercase tracking-[0.28em] text-muted-foreground">Operating mode</div>
        <ModeSwitcher />
        <KillSwitchButton />
        <div className="flex items-center justify-between gap-2 pt-1 text-[9px] text-muted-foreground">
          <StatusDot ok={connected} label={connected ? 'agent link' : 'link down'} />
          <ThemeToggle />
          <span className="inline-flex items-center gap-1">
            <Cpu className="h-3 w-3" aria-hidden />
            {system?.os?.exec.kind === 'wsl-bash' ? 'WSL' : system?.os?.exec.kind === 'native-bash' ? 'LINUX' : system?.os?.exec.kind === 'powershell' ? 'WIN' : '…'}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function RedlineApp() {
  const { refreshSystem, setSocketConnected, setMode, setKillSwitch, sessionId } = useRedline()
  const { toast } = useToast()
  const [mobileNav, setMobileNav] = useState(false)
  const view = useRedline((s) => s.view)

  useEffect(() => {
    void refreshSystem()
    initFeed() // one app-wide agent-event capture (console streams + main terminal)
    const socket = getSocket()
    if (!socket) return

    // (re)join the room on every connect — the socket can win the
    // gateway/direct race late, or reconnect after a service restart
    const onConnect = () => {
      setSocketConnected(true)
      socket.emit('session:join', { sessionId })
    }
    const onDisconnect = () => setSocketConnected(false)
    const onGiveUp = () => {
      toast({
        title: 'AGENT SERVICE UNREACHABLE',
        description: 'Start it in a separate terminal with: bun run service — retrying in the background.',
        variant: 'destructive',
      })
    }
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('reconnect_failed', onGiveUp)
    if (socket.connected) onConnect() // already up (e.g. strategy remembered)
    else socket.emit('session:join', { sessionId }) // buffered until connected

    socket.on('mode:changed', ({ mode }: { mode: any }) => setMode(mode))
    socket.on('kill:changed', ({ enabled }: { enabled: boolean }) => setKillSwitch(enabled))
    socket.on('safety:broadcast', ({ message }: { message: string }) => {
      toast({ title: '[SAFETY] UNRESTRICTED ENGAGED', description: message, variant: 'destructive' })
      void refreshSystem()
    })
    socket.on('tool:registered', ({ name, note }: { name: string; note: string }) => {
      toast({ title: `Tool registered: ${name}`, description: note })
      void refreshSystem()
    })
    socket.on('tool:removed', ({ id }: { id: string }) => {
      toast({ title: `Tool removed: ${id}` })
      void refreshSystem()
    })
    socket.on('engagement:updated', () => { /* views poll/listen independently */ })

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('reconnect_failed', onGiveUp)
      socket.off('mode:changed')
      socket.off('kill:changed')
      socket.off('safety:broadcast')
      socket.off('tool:registered')
      socket.off('tool:removed')
      socket.off('engagement:updated')
    }
  }, [refreshSystem, setSocketConnected, setMode, setKillSwitch, sessionId, toast])

  return (
    <div className="relative z-10 flex min-h-screen w-full">
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 overflow-y-auto border-r border-border/60 bg-sidebar/80 backdrop-blur-sm md:block">
        <SidebarNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <UnrestrictedBanner />

        {/* mobile top bar */}
        <div className="flex items-center gap-3 border-b border-border/60 bg-sidebar/70 px-3 py-2 backdrop-blur-sm md:hidden">
          <Sheet open={mobileNav} onOpenChange={setMobileNav}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="btn-neon h-8 w-8 border-border" aria-label="Open navigation">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 border-border/60 bg-sidebar p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SidebarNav onNavigate={() => setMobileNav(false)} />
            </SheetContent>
          </Sheet>
          <GlitchTitle text="REDLINE" className="text-base text-[var(--neon-cyan)]" />
          <div className="ml-auto pr-1">
            <ThemeToggle />
          </div>
        </div>

        <main className="min-w-0 flex-1">
          {view === 'dashboard' && <DashboardView />}
          {view === 'console' && <ConsoleView />}
          {view === 'terminal' && <TerminalView />}
          {view === 'engagements' && <EngagementsView />}
          {view === 'targets' && <TargetsView />}
          {view === 'arsenal' && <ArsenalView />}
          {view === 'market' && <MarketView />}
          {view === 'knowledge' && <KnowledgeView />}
          {view === 'audit' && <AuditView />}
          {view === 'settings' && <SettingsView />}
        </main>

        <footer className="mt-auto border-t border-border/40 px-4 py-2 text-[9px] uppercase tracking-[0.25em] text-muted-foreground/70">
          redline · charter-scoped by design · every action gated, streamed &amp; audited
        </footer>
      </div>
    </div>
  )
}

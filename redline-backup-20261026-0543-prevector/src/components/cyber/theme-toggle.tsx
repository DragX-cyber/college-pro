'use client'
// Theme toggle — REDLINE light/dark switch.
// Default is dark (the cyberpunk console); the choice persists in
// localStorage ("redline.theme") and toggles the `dark` class on <html>.
// All colors derive from tokens, so the flip is pure CSS — no re-render
// of views is needed; state here only decides the icon.
import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

const KEY = 'redline.theme'

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null)

  useEffect(() => {
    const saved = window.localStorage.getItem(KEY)
    const d = saved ? saved === 'dark' : true
    setDark(d)
    document.documentElement.classList.toggle('dark', d)
  }, [])

  const toggle = () => {
    const d = !(dark ?? true)
    setDark(d)
    try { window.localStorage.setItem(KEY, d ? 'dark' : 'light') } catch { /* private mode */ }
    document.documentElement.classList.toggle('dark', d)
  }

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={toggle}
      title={dark === false ? 'Switch to dark mode' : 'Switch to light mode'}
      aria-label={dark === false ? 'Switch to dark mode' : 'Switch to light mode'}
      className="btn-neon h-8 w-8 shrink-0 border-border bg-card/60"
    >
      {dark === false ? <Moon className="h-4 w-4" aria-hidden /> : <Sun className="h-4 w-4" aria-hidden />}
    </Button>
  )
}

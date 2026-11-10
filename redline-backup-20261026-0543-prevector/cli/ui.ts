// REDLINE CLI — ANSI rendering kit (Claude Code-style TUI aesthetic)
export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  cyan: '\x1b[38;5;51m',
  magenta: '\x1b[38;5;207m',
  green: '\x1b[38;5;85m',
  yellow: '\x1b[38;5;228m',
  red: '\x1b[38;5;203m',
  acid: '\x1b[38;5;227m',
  amber: '\x1b[38;5;215m',
  gray: '\x1b[38;5;245m',
  white: '\x1b[38;5;255m',
}

export function rgb(r: number, g: number, b: number) {
  return `\x1b[38;2;${r};${g};${b}m`
}

// ─── block-letter banner with a cyan→magenta gradient ────────────────────────
const LETTERS: Record<string, string[]> = {
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  L: ['██╗     ', '██║     ', '██║     ', '██║     ', '███████╗', '╚══════╝'],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  N: ['███╗   ██╗', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚████║', '╚═╝  ╚═══╝'],
}

export function banner(text: string): string {
  const rows = ['', '', '', '', '', '']
  for (const ch of text.toUpperCase()) {
    const g = LETTERS[ch]
    if (!g) continue
    for (let i = 0; i < 6; i++) rows[i] += g[i] + ' '
  }
  const lines = rows.map((row, i) => {
    const t = i / 5
    const r = Math.round(0 + (255 - 0) * t)
    const g = Math.round(229 + (42 - 229) * t)
    const b = Math.round(255 + (109 - 255) * t)
    return `${rgb(r, g, b)}${row}${C.reset}`
  })
  return lines.join('\n')
}

// ─── rounded box (Claude Code vibes) ─────────────────────────────────────────
export function box(title: string, lines: string[], color = C.cyan): string {
  const all = [title, ...lines]
  const width = Math.min(100, Math.max(20, ...all.map((l) => stripAnsi(l).length)))
  const top = `${color}╭${'─'.repeat(width + 2)}╮${C.reset}`
  const bottom = `${color}╰${'─'.repeat(width + 2)}╯${C.reset}`
  const body = all
    .map((l, i) => {
      const plain = stripAnsi(l).length
      const pad = ' '.repeat(Math.max(0, width - plain))
      const label = i === 0 ? `${color}│${C.reset} ${C.bold}${l}` : `${color}│${C.reset} ${l}`
      return `${label}${pad} ${color}│${C.reset}`
    })
    .join('\n')
  return [top, body, bottom].join('\n')
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

export function hr(label = '', color = C.dim): string {
  const w = label ? 90 : 92
  const line = '─'.repeat(Math.max(0, w - stripAnsi(label).length - 2))
  return `${color}${label ? ` ${label} ` : ''}${line}${C.reset}`
}

export function truncate(s: string, max: number): string {
  const p = stripAnsi(s)
  return p.length > max ? p.slice(0, max - 1) + '…' : s
}

// ─── spinner ─────────────────────────────────────────────────────────────────
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export class Spinner {
  private timer: NodeJS.Timeout | null = null
  private i = 0
  constructor(private text: string, private color = C.magenta) {}

  start() {
    if (process.stdout.isTTY) {
      this.timer = setInterval(() => {
        const f = FRAMES[this.i++ % FRAMES.length]
        process.stdout.write(`\r${this.color}${f}${C.reset} ${this.text}${C.reset}   `)
      }, 90)
    } else {
      process.stdout.write(`${this.text}\n`)
    }
  }

  setText(t: string) {
    this.text = t
  }

  stop(final = '') {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      process.stdout.write('\r\x1b[2K')
    }
    if (final) process.stdout.write(final + '\n')
  }
}

export function modeBadge(mode: string): string {
  if (mode === 'unrestricted') return `${C.red}${C.bold}● UNRESTRICTED${C.reset}`
  if (mode === 'guarded') return `${C.cyan}● GUARDED${C.reset}`
  return `${C.green}● FREE TERMINAL${C.reset}`
}

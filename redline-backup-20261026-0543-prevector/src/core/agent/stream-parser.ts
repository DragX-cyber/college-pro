// ─────────────────────────────────────────────────────────────────────────────
// Stream parser for RedLine LLM outputs
// Extracts live tokens for thoughts and final responses as they arrive
// from the SSE stream, stripping JSON framing and formatting cleanly.
// ─────────────────────────────────────────────────────────────────────────────

class JsonStreamStringExtractor {
  private inEscape = false
  private unicodeBuf = ''
  private inUnicode = false
  public completed = false

  constructor(private onChunk: (chunk: string) => void) {}

  public feed(char: string): boolean {
    if (this.completed) return false

    if (this.inUnicode) {
      this.unicodeBuf += char
      if (this.unicodeBuf.length === 4) {
        try {
          const code = parseInt(this.unicodeBuf, 16)
          this.onChunk(String.fromCharCode(code))
        } catch {
          this.onChunk('\\u' + this.unicodeBuf)
        }
        this.inUnicode = false
        this.unicodeBuf = ''
      }
      return true
    }

    if (this.inEscape) {
      this.inEscape = false
      switch (char) {
        case '"': this.onChunk('"'); break
        case '\\': this.onChunk('\\'); break
        case '/': this.onChunk('/'); break
        case 'b': this.onChunk('\b'); break
        case 'f': this.onChunk('\f'); break
        case 'n': this.onChunk('\n'); break
        case 'r': this.onChunk('\r'); break
        case 't': this.onChunk('\t'); break
        case 'u':
          this.inUnicode = true
          this.unicodeBuf = ''
          break
        default:
          this.onChunk('\\' + char)
      }
      return true
    }

    if (char === '\\') {
      this.inEscape = true
      return true
    }

    if (char === '"') {
      this.completed = true
      return false
    }

    this.onChunk(char)
    return true
  }
}

export class RedLineStreamParser {
  private raw = ''
  private state: 'detecting' | 'prose' | 'json' = 'detecting'
  private thoughtExtractor: JsonStreamStringExtractor | null = null
  private finalExtractor: JsonStreamStringExtractor | null = null
  private isFinalTool = false
  private pendingFinalChars = ''
  private thoughtDone = false
  private finalDone = false

  constructor(
    private onThoughtChunk: (chunk: string) => void,
    private onFinalChunk: (chunk: string) => void
  ) {}

  public feed(chunk: string) {
    this.raw += chunk

    if (this.state === 'detecting') {
      const trimmed = this.raw.trimStart()
      if (!trimmed) return
      if (trimmed.startsWith('{') || trimmed.startsWith('```')) {
        this.state = 'json'
      } else if (trimmed.length >= 3) {
        // First tokens are plain prose
        this.state = 'prose'
        this.onFinalChunk(this.raw)
        return
      } else {
        return
      }
    }

    if (this.state === 'prose') {
      this.onFinalChunk(chunk)
      return
    }

    // JSON mode: detect tool
    if (!this.isFinalTool) {
      if (/"tool"\s*:\s*"final"/.test(this.raw)) {
        this.isFinalTool = true
      }
    }

    // Stream thought
    if (!this.thoughtDone) {
      if (!this.thoughtExtractor) {
        const thoughtMatch = /"thought"\s*:\s*"/.exec(this.raw)
        if (thoughtMatch) {
          const startIndex = thoughtMatch.index + thoughtMatch[0].length
          this.thoughtExtractor = new JsonStreamStringExtractor((c) => this.onThoughtChunk(c))
          for (let i = startIndex; i < this.raw.length; i++) {
            const cont = this.thoughtExtractor.feed(this.raw[i])
            if (!cont) {
              this.thoughtDone = true
              break
            }
          }
        }
      } else {
        for (let i = 0; i < chunk.length; i++) {
          const cont = this.thoughtExtractor.feed(chunk[i])
          if (!cont) {
            this.thoughtDone = true
            break
          }
        }
      }
    }

    // Stream final text
    if (!this.finalDone) {
      if (!this.finalExtractor) {
        const textMatch = /(?:"text"|"final")\s*:\s*"/.exec(this.raw)
        if (textMatch) {
          const startIndex = textMatch.index + textMatch[0].length
          let buffered = ''
          const targetExtractor = new JsonStreamStringExtractor((c) => {
            if (this.isFinalTool) {
              this.onFinalChunk(c)
            } else {
              buffered += c
            }
          })
          this.finalExtractor = targetExtractor

          for (let i = startIndex; i < this.raw.length; i++) {
            const cont = this.finalExtractor.feed(this.raw[i])
            if (!cont) {
              this.finalDone = true
              break
            }
          }

          if (this.isFinalTool && buffered) {
            this.onFinalChunk(buffered)
            buffered = ''
          }
          this.pendingFinalChars = buffered
        }
      } else {
        for (let i = 0; i < chunk.length; i++) {
          const cont = this.finalExtractor.feed(chunk[i])
          if (!cont) {
            this.finalDone = true
            break
          }
        }
      }

      // If tool became 'final' after 'text' was started, flush pending buffer
      if (this.isFinalTool && this.pendingFinalChars) {
        this.onFinalChunk(this.pendingFinalChars)
        this.pendingFinalChars = ''
      }
    }
  }
}


// puter-auth — one-off operator helper.
//   bun run puter-auth              → opens the browser, you sign in to Puter,
//                                     the token lands in REDLINE's settings
//   bun run puter-auth <TOKEN>      → skip the browser, write the given token
//
// Useless without a Puter account: server-side usage bills the token's
// account (Puter's user-pays model). No Anthropic key involved.
import { createRequire } from 'node:module'
import { getSettings, setSettings } from '../src/core/settings'

const C = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

const mask = (t: string | undefined) => (!t ? '(empty)' : `${t.slice(0, 6)}…${t.slice(-4)}`)

async function main() {
  const argToken = process.argv[2]?.trim()
  const req = createRequire(import.meta.url)
  const { getAuthToken } = req('@heyputer/puter.js/src/init.cjs')

  let token: string
  if (argToken) {
    token = argToken
    console.log(C.dim('using the token passed as an argument'))
  } else {
    console.log(C.cyan('◈ opening your browser to sign in to puter.com…'))
    console.log(C.dim('  (lack an account? sign-up happens in the same flow, free)'))
    try {
      token = await getAuthToken()
    } catch (e) {
      console.error(C.yellow('✕ browser auth failed:'), e instanceof Error ? e.message : e)
      console.error(C.dim('  fallback: copy the token manually from puter.com → your avatar → Dashboard → auth token,'))
      console.error(C.dim(`  then run: ${C.cyan('bun run puter-auth <TOKEN>')}`))
      process.exit(1)
    }
  }

  if (!token || token.length < 10) {
    console.error(C.yellow('✕ the flow returned an empty/short token — nothing written'))
    process.exit(1)
  }

  const before = await getSettings()
  // Keep a claude model selection if one is set; otherwise default to sonnet.
  const model = /^claude/.test(before.model) ? before.model : 'claude-sonnet-5-5'
  await setSettings({ provider: 'puter', apiKey: token, model })
  const after = await getSettings()

  console.log('')
  console.log(C.green('✕→● Puter connected — REDLINE provider updated:'))
  console.log(`   provider  : ${C.cyan(after.provider)}`)
  console.log(`   model     : ${after.model}`)
  console.log(`   token     : ${C.dim(mask(token))}  (stored in Settings, masked in the UI)`)
  console.log('')
  console.log(C.dim('next: if the agent mini-service or dev server is running, restart it so the new provider loads.'))
  console.log(C.dim('to switch back anytime: Settings → provider.'))
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })

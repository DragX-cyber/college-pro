import { NextResponse } from 'next/server'
import { autodetectTools } from '@/core/marketplace/autodetect'

// Operator-triggered scan of the red-team shell for installed catalog tools.
// Registered tools stream to connected consoles via the agent service's
// tool:registered broadcast; the service also runs this automatically at boot.
export async function POST() {
  const r = await autodetectTools()
  return NextResponse.json({
    scanned: r.scanned,
    available: r.available.map((t) => ({ id: t.id, name: t.name, category: t.category, tagline: t.tagline })),
    registered: r.registered,
    alreadyKnown: r.alreadyKnown,
    missing: r.missing,
  })
}

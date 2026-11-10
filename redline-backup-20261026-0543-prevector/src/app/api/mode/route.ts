import { NextResponse } from 'next/server'
import { getMode } from '@/core/settings'

export async function GET() {
  return NextResponse.json({ mode: await getMode() })
}

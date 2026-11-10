import { NextResponse } from 'next/server'
import { getMarketplace } from '@/core/marketplace/manager'
import { TASK_LABELS } from '@/core/marketplace/catalog'
import { selectStrategy } from '@/core/tools/selector'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const compareTask = url.searchParams.get('compare') // e.g. ?compare=port_scan
  const tools = await getMarketplace()
  const comparison = compareTask && TASK_LABELS[compareTask]
    ? {
        task: compareTask,
        label: TASK_LABELS[compareTask],
        strategies: {
          speed: selectStrategy(compareTask, { priority: 'speed' }),
          coverage: selectStrategy(compareTask, { priority: 'coverage' }),
          stealth: selectStrategy(compareTask, { priority: 'stealth' }),
          reliability: selectStrategy(compareTask, { priority: 'reliability' }),
        },
      }
    : null
  return NextResponse.json({ tools, taskLabels: TASK_LABELS, comparison })
}

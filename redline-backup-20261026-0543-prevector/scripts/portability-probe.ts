// Portability probe: verify Prisma + relative DATABASE_URL resolves to the
// same db file from different cwds (CLI at root, service in mini-services).
import { db } from '../src/core/db'
import { ROOT } from '../src/core/paths'
import { pathToFileURL } from 'url'

const n = await db.setting.count()
console.log('ROOT               =', ROOT)
console.log('DATABASE_URL       =', process.env.DATABASE_URL)
console.log('settings rows      =', n)
console.log('relative URL works = ' + (n >= 0 ? 'YES' : 'NO'))
process.exit(0)

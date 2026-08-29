import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { productionConfiguration } from '../services/api/src/lib/productionConfig.js'

const result = productionConfiguration(process.env)
const redirects = readFileSync(resolve('apps/web/public/_redirects'), 'utf8')
if (!/^\/view\/\*\s+\/view\/index\.html\s+200\s*$/m.test(redirects)) {
  result.errors.push('apps/web/public/_redirects must rewrite /view/* to /view/index.html with 200')
  result.ok = false
}

console.log('Arcvia production preflight')
for (const error of result.errors) console.log(`ERROR  ${error}`)
for (const warning of result.warnings) console.log(`WARN   ${warning}`)
if (result.ok) {
  console.log(
    `PASS   ${result.summary.origins} origin(s); ${result.summary.databaseProvider} database; `
      + `${result.summary.storageProvider} storage; ${result.summary.renderMode} renderer; `
      + `${result.summary.smsProvider} SMS; ${result.summary.mailProvider} mail`,
  )
} else {
  console.log(`FAIL   ${result.errors.length} production setting(s) need attention`)
  process.exitCode = 1
}

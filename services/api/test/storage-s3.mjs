/**
 * S3-compatible production storage against a local protocol double.
 *
 * Run: node test/storage-s3.mjs
 */

import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
const ok = (label, condition, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

const objects = new Map()
let puts = 0
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  const key = decodeURIComponent(pathname.replace(/^\/arcvia-test\//, ''))
  if (request.method === 'PUT') {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    objects.set(key, {
      body: Buffer.concat(chunks),
      type: request.headers['content-type'],
    })
    puts++
    response.writeHead(200, { ETag: '"test"' })
    response.end()
    return
  }

  const object = objects.get(key)
  if (!object) {
    response.writeHead(404, { 'content-type': 'application/xml' })
    response.end('<Error><Code>NoSuchKey</Code></Error>')
    return
  }
  if (request.method === 'HEAD') {
    response.writeHead(200, {
      'content-length': object.body.length,
      'content-type': object.type,
    })
    response.end()
    return
  }
  if (request.method === 'GET') {
    response.writeHead(200, {
      'content-length': object.body.length,
      'content-type': object.type,
    })
    response.end(object.body)
    return
  }
  if (request.method === 'DELETE') {
    objects.delete(key)
    response.writeHead(204)
    response.end()
    return
  }
  response.writeHead(405)
  response.end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const dir = await mkdtemp(join(tmpdir(), 'arcvia-s3-stage-'))

Object.assign(process.env, {
  STORAGE_PROVIDER: 's3',
  S3_BUCKET: 'arcvia-test',
  S3_REGION: 'us-east-1',
  S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_PUBLIC_URL: 'https://cdn.example.test',
  UPLOAD_DIR: dir,
})

try {
  const storage = await import('../src/lib/storage.js')
  const bytes = Buffer.from('arcvia-object')
  ok('traversal-shaped object keys are rejected', (await storage.open('../secret.png')) === null)

  const stored = await storage.put(bytes, 'image/png', { prefix: 'plans' })
  ok('put returns the configured CDN URL', stored.url.startsWith('https://cdn.example.test/plans/'))
  ok('put writes the object once', puts === 1 && objects.has(stored.key))

  await storage.put(bytes, 'image/png', { prefix: 'plans' })
  ok('content-addressed duplicate upload is skipped', puts === 1)

  const opened = await storage.open(stored.key)
  const openedBytes = Buffer.from(await opened.stream.transformToByteArray())
  ok('open streams the stored bytes', openedBytes.equals(bytes))
  ok('open preserves content type', opened.contentType === 'image/png')

  const staged = await storage.pathOf(stored.key)
  ok('pathOf stages an S3 object for the CAD subprocess', staged?.path.startsWith(dir))
  ok('the staged CAD file has the original bytes', (await readFile(staged.path)).equals(bytes))
  ok('resolveUrl leaves a CDN URL usable by remote workers', storage.resolveUrl(stored.url) === stored.url)
  ok('CDN URLs are recognised as Arcvia-owned objects', storage.isOwnUpload(stored.url))

  await storage.remove(stored.key)
  ok('remove deletes the S3 object', (await storage.open(stored.key)) === null)
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

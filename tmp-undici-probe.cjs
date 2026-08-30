// Temporary diagnostic: which undici backs the global dispatcher, and does
// maxRedirections survive there? Delete after use.
const http = require('node:http')
const { request } = require('undici')

const srv = http.createServer((req, res) => {
  if (req.url === '/a') { res.writeHead(302, { location: '/b' }); res.end() }
  else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') }
})

srv.listen(0, '127.0.0.1', async () => {
  const { port } = srv.address()
  const s1 = globalThis[Symbol.for('undici.globalDispatcher.1')]
  const s2 = globalThis[Symbol.for('undici.globalDispatcher.2')]
  console.log('npm undici version :', require('undici/package.json').version)
  console.log('node               :', process.versions.node, 'electron:', process.versions.electron ?? '-')
  console.log('symbol .1 dispatcher:', s1 ? s1.constructor.name : '(unset)')
  console.log('symbol .2 dispatcher:', s2 ? s2.constructor.name : '(unset)', '<- set only by undici v7')
  try {
    const res = await request(`http://127.0.0.1:${port}/a`, { maxRedirections: 5 })
    console.log('maxRedirections    : OK, status', res.statusCode, JSON.stringify(await res.body.text()))
  } catch (e) {
    console.log('maxRedirections    : THROWS ->', e.message)
  }
  srv.close()
})

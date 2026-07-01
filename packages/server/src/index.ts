import { buildApp } from './app.js'

// 부팅 엔트리 — 앱을 구성하고 리슨한다. 커버리지에서 제외(배선 코드).
const app = buildApp()
const port = Number(process.env.PORT ?? 3000)

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  app.log.error(`invalid PORT: ${String(process.env.PORT)}`)
  process.exit(1)
}

app
  .listen({ port, host: '0.0.0.0' })
  .then((address) => {
    app.log.info(`server listening at ${address}`)
  })
  .catch((err: unknown) => {
    app.log.error(err)
    process.exit(1)
  })

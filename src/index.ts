import app from "./app.ts"

const port = parseInt(process.env.PORT ?? "3001")
console.log(`Creor API running on http://localhost:${port}`)

export default {
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
}

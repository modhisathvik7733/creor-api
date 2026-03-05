import { test, expect } from "bun:test"
import app from "../src/index"

test("health endpoint returns 200", async () => {
  const res = await app.fetch(new Request("http://localhost/health"))
  expect(res.status).toBe(200)

  const body = await res.json()
  expect(body.status).toBe("ok")
  expect(body.version).toBe("0.1.0")
  expect(body.timestamp).toBeDefined()
})

test("unknown route returns 404", async () => {
  const res = await app.fetch(new Request("http://localhost/nonexistent"))
  expect(res.status).toBe(404)
})

test("models endpoint returns list", async () => {
  const res = await app.fetch(new Request("http://localhost/api/models"))
  expect(res.status).toBe(200)

  const body = (await res.json()) as { models: Array<{ id: string }> }
  expect(body.models).toBeDefined()
  expect(body.models.length).toBeGreaterThan(0)
  expect(body.models[0].id).toBeDefined()
})

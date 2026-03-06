import { test, expect, describe } from "bun:test"
import app from "../src/index"

/**
 * Integration tests for Sprint 1 billing endpoints.
 * Uses app.fetch() to test without running a server.
 * Requires DB env vars (DB_HOST, DB_PASSWORD, etc.)
 */

function req(path: string, opts?: RequestInit) {
  return app.fetch(new Request(`http://localhost${path}`, opts))
}

describe("models endpoint (DB-driven)", () => {
  test("GET /api/models returns models from DB", async () => {
    const res = await req("/api/models")
    expect(res.status).toBe(200)

    const body = (await res.json()) as { models: Array<{ id: string; provider: string; inputCost: number }> }
    expect(body.models.length).toBeGreaterThanOrEqual(6)

    // Verify seed data
    const sonnet = body.models.find((m) => m.id === "anthropic/claude-sonnet-4")
    expect(sonnet).toBeDefined()
    expect(sonnet!.provider).toBe("anthropic")
  })

  test("GET /api/models/:id returns single model", async () => {
    const res = await req("/api/models/anthropic/claude-sonnet-4")
    expect(res.status).toBe(200)

    const body = (await res.json()) as { id: string; inputCost: number; outputCost: number }
    expect(body.id).toBe("anthropic/claude-sonnet-4")
    expect(body.inputCost).toBe(0.003)
    expect(body.outputCost).toBe(0.015)
  })

  test("GET /api/models/:id returns 404 for unknown model", async () => {
    const res = await req("/api/models/unknown/model-xyz")
    expect(res.status).toBe(404)
  })
})

describe("billing endpoints (unauthenticated)", () => {
  test("GET /api/billing/quota returns 401 without auth", async () => {
    const res = await req("/api/billing/quota")
    expect(res.status).toBe(401)
  })

  test("POST /api/billing/add-credits returns 401 without auth", async () => {
    const res = await req("/api/billing/add-credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 500 }),
    })
    expect(res.status).toBe(401)
  })

  test("PATCH /api/billing/currency returns 401 without auth", async () => {
    const res = await req("/api/billing/currency", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currency: "USD" }),
    })
    expect(res.status).toBe(401)
  })

  test("GET /api/billing/payments returns 401 without auth", async () => {
    const res = await req("/api/billing/payments")
    expect(res.status).toBe(401)
  })
})

describe("admin endpoints (unauthenticated)", () => {
  test("GET /api/admin/models returns 401 without auth", async () => {
    const res = await req("/api/admin/models")
    expect(res.status).toBe(401)
  })

  test("GET /api/admin/plans returns 401 without auth", async () => {
    const res = await req("/api/admin/plans")
    expect(res.status).toBe(401)
  })

  test("GET /api/admin/config returns 401 without auth", async () => {
    const res = await req("/api/admin/config")
    expect(res.status).toBe(401)
  })

  test("POST /api/admin/refresh-config returns 401 without auth", async () => {
    const res = await req("/api/admin/refresh-config", { method: "POST" })
    expect(res.status).toBe(401)
  })
})

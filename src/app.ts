import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { rateLimit } from "./middleware/rate-limit.ts"
import { authRoutes } from "./routes/auth.ts"
import { billingRoutes } from "./routes/billing.ts"
import { workspaceRoutes } from "./routes/workspace.ts"
import { keyRoutes } from "./routes/keys.ts"
import { modelRoutes } from "./routes/models.ts"
import { usageRoutes } from "./routes/usage.ts"
import { shareRoutes } from "./routes/share.ts"
import { gatewayRoutes } from "./routes/gateway.ts"
import { googleProxyRoutes } from "./routes/google-proxy.ts"
import { webhookRoutes } from "./routes/webhooks.ts"
import { userRoutes } from "./routes/user.ts"
import { adminRoutes } from "./routes/admin.ts"
import { inviteRoutes } from "./routes/invites.ts"
import { activityRoutes } from "./routes/activity.ts"
import { catalogRoutes } from "./routes/catalog.ts"
import { projectRoutes } from "./routes/projects.ts"
import { providerRoutes } from "./routes/providers.ts"
import { marketplaceRoutes } from "./routes/marketplace.ts"
import { updateRoutes } from "./routes/update.ts"

const app = new Hono()

// Global middleware
app.use("*", logger())
app.use(
  "*",
  cors({
    origin: (origin) => {
      // Allow Creor IDE (Electron renderer) origin
      if (origin === "vscode-file://vscode-app") {
        return origin
      }
      // Allow configured origins (web dashboard, etc.)
      const allowed = (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(",")
      return allowed.includes(origin) ? origin : allowed[0]
    },
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-Creor-Request"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  }),
)

// Prevent proxy/CDN buffering for SSE streaming responses
app.use("*", async (c, next) => {
  await next()
  const ct = c.res.headers.get("content-type") || ""
  if (ct.includes("text/event-stream")) {
    // Force identity encoding to prevent gzip/brotli buffering
    c.res.headers.set("Content-Encoding", "identity")
    c.res.headers.set("X-Content-Type-Options", "nosniff")
  }
})

// Rate limiting (distributed via Upstash Redis, falls back to in-memory)
app.use("*", rateLimit({ prefix: "global", windowSec: 60, max: 300 }))
app.use("/api/auth/*", rateLimit({
  prefix: "auth",
  windowSec: 60,
  max: 20,
  keyFn: (c: any) => c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown",
}))
app.use("/v1/*", rateLimit({
  prefix: "gateway",
  windowSec: 60,
  max: 60,
  keyFn: (c: any) => c.req.header("Authorization")?.replace("Bearer ", "") ?? "unknown",
}))
app.use("/google/*", rateLimit({
  prefix: "gateway",
  windowSec: 60,
  max: 60,
  keyFn: (c: any) => c.req.header("Authorization")?.replace("Bearer ", "") ?? "unknown",
}))

// Health check
app.get("/health", (c) =>
  c.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() }),
)

// Auto-update endpoint (public, no auth — VS Code update service calls this)
app.route("/", updateRoutes)

// API routes
app.route("/api/auth", authRoutes)
app.route("/api/billing", billingRoutes)
app.route("/api/workspaces", workspaceRoutes)
app.route("/api/users", userRoutes)
app.route("/api/keys", keyRoutes)
app.route("/api/models", modelRoutes)
app.route("/api/usage", usageRoutes)
app.route("/api/share", shareRoutes)
app.route("/api/webhooks", webhookRoutes)
app.route("/api/admin", adminRoutes)
app.route("/api/invites", inviteRoutes)
app.route("/api/activity", activityRoutes)
app.route("/api/projects", projectRoutes)
app.route("/api/providers", providerRoutes)
app.route("/api/catalog", catalogRoutes)
app.route("/api/marketplace", marketplaceRoutes)

// LLM Gateway (separate path for AI SDK compatibility)
app.route("/v1", gatewayRoutes)

// Google Native API Proxy (for @ai-sdk/google via gateway)
app.route("/google", googleProxyRoutes)

// 404 fallback
app.notFound((c) => c.json({ error: "Not found" }, 404))

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err)
  return c.json({ error: "Internal server error" }, 500)
})

export default app

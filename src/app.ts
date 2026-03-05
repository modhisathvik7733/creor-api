import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { authRoutes } from "./routes/auth"
import { billingRoutes } from "./routes/billing"
import { workspaceRoutes } from "./routes/workspace"
import { keyRoutes } from "./routes/keys"
import { modelRoutes } from "./routes/models"
import { usageRoutes } from "./routes/usage"
import { shareRoutes } from "./routes/share"
import { gatewayRoutes } from "./routes/gateway"
import { webhookRoutes } from "./routes/webhooks"
import { userRoutes } from "./routes/user"

const app = new Hono()

// Global middleware
app.use("*", logger())
app.use(
  "*",
  cors({
    origin: (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(","),
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-Creor-Request"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  }),
)

// Health check
app.get("/health", (c) =>
  c.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() }),
)

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

// LLM Gateway (separate path for AI SDK compatibility)
app.route("/v1", gatewayRoutes)

// 404 fallback
app.notFound((c) => c.json({ error: "Not found" }, 404))

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err)
  return c.json({ error: "Internal server error" }, 500)
})

export default app

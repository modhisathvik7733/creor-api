import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { models, plans, systemConfig, mcpCatalog } from "../db/schema.ts"
import { eq, sql, count } from "drizzle-orm"
import { createId } from "../lib/id.ts"
import { requireAuth, requireAdmin, type AuthContext } from "../middleware/auth.ts"

export const adminRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

adminRoutes.use("*", requireAuth)
adminRoutes.use("*", requireAdmin)

// ═══════════════════════════════════════
// Models CRUD
// ═══════════════════════════════════════

adminRoutes.get("/models", async (c) => {
  const rows = await db.select().from(models).orderBy(models.sortOrder)
  return c.json({ models: rows })
})

const modelSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  name: z.string().min(1),
  inputCost: z.string(), // NUMERIC as string
  outputCost: z.string(),
  contextWindow: z.number().int().default(200000),
  maxOutput: z.number().int().nullable().optional(),
  capabilities: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  minPlan: z.string().default("free"),
  sortOrder: z.number().int().default(0),
})

adminRoutes.post("/models", zValidator("json", modelSchema), async (c) => {
  const data = c.req.valid("json")

  await db.insert(models).values({
    id: data.id,
    provider: data.provider,
    name: data.name,
    inputCost: data.inputCost,
    outputCost: data.outputCost,
    contextWindow: data.contextWindow,
    maxOutput: data.maxOutput ?? null,
    capabilities: data.capabilities,
    enabled: data.enabled,
    minPlan: data.minPlan,
    sortOrder: data.sortOrder,
  })

  await refreshGatewayConfig()
  return c.json({ success: true, id: data.id }, 201)
})

const modelUpdateSchema = modelSchema.partial().omit({ id: true })

adminRoutes.patch("/models/:id{.+}", zValidator("json", modelUpdateSchema), async (c) => {
  const id = c.req.param("id")
  const data = c.req.valid("json")

  const updates: Record<string, unknown> = { timeUpdated: new Date() }
  if (data.provider !== undefined) updates.provider = data.provider
  if (data.name !== undefined) updates.name = data.name
  if (data.inputCost !== undefined) updates.inputCost = data.inputCost
  if (data.outputCost !== undefined) updates.outputCost = data.outputCost
  if (data.contextWindow !== undefined) updates.contextWindow = data.contextWindow
  if (data.maxOutput !== undefined) updates.maxOutput = data.maxOutput
  if (data.capabilities !== undefined) updates.capabilities = data.capabilities
  if (data.enabled !== undefined) updates.enabled = data.enabled
  if (data.minPlan !== undefined) updates.minPlan = data.minPlan
  if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder

  await db.update(models).set(updates).where(eq(models.id, id))
  await refreshGatewayConfig()

  return c.json({ success: true })
})

adminRoutes.delete("/models/:id{.+}", async (c) => {
  const id = c.req.param("id")
  await db.delete(models).where(eq(models.id, id))
  await refreshGatewayConfig()
  return c.json({ success: true })
})

// ═══════════════════════════════════════
// Plans CRUD
// ═══════════════════════════════════════

adminRoutes.get("/plans", async (c) => {
  const rows = await db.select().from(plans).orderBy(plans.sortOrder)
  return c.json({ plans: rows })
})

const planUpdateSchema = z.object({
  name: z.string().optional(),
  prices: z.record(z.number()).optional(),
  monthlyLimit: z.number().nullable().optional(),
  onboardingCredits: z.number().nullable().optional(),
  features: z.array(z.string()).optional(),
  lsVariantId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

adminRoutes.patch("/plans/:id", zValidator("json", planUpdateSchema), async (c) => {
  const id = c.req.param("id")
  const data = c.req.valid("json")

  const updates: Record<string, unknown> = { timeUpdated: new Date() }
  if (data.name !== undefined) updates.name = data.name
  if (data.prices !== undefined) updates.prices = data.prices
  if (data.monthlyLimit !== undefined) updates.monthlyLimit = data.monthlyLimit
  if (data.onboardingCredits !== undefined) updates.onboardingCredits = data.onboardingCredits
  if (data.features !== undefined) updates.features = data.features
  if (data.lsVariantId !== undefined) updates.lsVariantId = data.lsVariantId
  if (data.enabled !== undefined) updates.enabled = data.enabled
  if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder

  await db.update(plans).set(updates).where(eq(plans.id, id))
  return c.json({ success: true })
})

// ═══════════════════════════════════════
// System Config
// ═══════════════════════════════════════

adminRoutes.get("/config", async (c) => {
  const rows = await db.select().from(systemConfig)
  return c.json({
    config: Object.fromEntries(rows.map((r) => [r.key, { value: r.value, description: r.description }])),
  })
})

const configUpdateSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  description: z.string().optional(),
})

adminRoutes.patch("/config", zValidator("json", configUpdateSchema), async (c) => {
  const { key, value, description } = c.req.valid("json")

  await db
    .insert(systemConfig)
    .values({ key, value, description, timeUpdated: new Date() })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value, description, timeUpdated: new Date() },
    })

  // If exchange rates changed, refresh the materialized view
  if (key === "exchange_rates" || key === "fallback_input_cost" || key === "fallback_output_cost") {
    await refreshGatewayConfig()
  }

  return c.json({ success: true })
})

// ═══════════════════════════════════════
// Manual refresh
// ═══════════════════════════════════════

adminRoutes.post("/refresh-config", async (c) => {
  await refreshGatewayConfig()
  return c.json({ success: true, message: "Materialized view refreshed" })
})

// ═══════════════════════════════════════
// MCP Marketplace Seed
// ═══════════════════════════════════════

adminRoutes.post("/seed-marketplace", async (c) => {
  const SEED: Array<Record<string, unknown>> = [
    { slug: "github", name: "GitHub", description: "Access GitHub repositories, issues, pull requests, and code search.", category: "developer", icon: "Github", author: "Anthropic", sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-github"], environment: { GITHUB_PERSONAL_ACCESS_TOKEN: "" } }, configParams: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub Personal Access Token", placeholder: "ghp_xxxxxxxxxxxxxxxxxxxx", required: true, secret: true }], tags: ["version-control", "code-review", "issues"], featured: true, verified: true },
    { slug: "slack", name: "Slack", description: "Read and send messages in Slack channels. Search conversations and interact with your team.", category: "communication", icon: "MessageSquare", author: "Anthropic", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-slack"], environment: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" } }, configParams: [{ key: "SLACK_BOT_TOKEN", label: "Slack Bot Token", placeholder: "xoxb-...", required: true, secret: true }, { key: "SLACK_TEAM_ID", label: "Slack Team ID", placeholder: "T0123456789", required: true, secret: false }], tags: ["messaging", "team-communication"], featured: true, verified: true },
    { slug: "notion", name: "Notion", description: "Search, read, and create pages in Notion. Manage databases and workspace content.", category: "productivity", icon: "FileText", author: "Anthropic", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@notionhq/notion-mcp-server"], environment: { OPENAPI_MCP_HEADERS: "" } }, configParams: [{ key: "NOTION_API_KEY", label: "Notion Integration Token", placeholder: "ntn_...", required: true, secret: true }], tags: ["notes", "wiki", "project-management"], featured: true, verified: true },
    { slug: "supabase", name: "Supabase", description: "Manage Supabase projects, run SQL queries, manage tables, and deploy edge functions.", category: "database", icon: "Database", author: "Supabase", serverType: "remote", configTemplate: { type: "remote", url: "https://mcp.supabase.com" }, configParams: [], tags: ["database", "postgres", "serverless"], featured: true, verified: true },
    { slug: "linear", name: "Linear", description: "Create and manage Linear issues, projects, and cycles. Track engineering work.", category: "productivity", icon: "CheckSquare", author: "Community", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "mcp-linear"], environment: { LINEAR_API_KEY: "" } }, configParams: [{ key: "LINEAR_API_KEY", label: "Linear API Key", placeholder: "lin_api_...", required: true, secret: true }], tags: ["project-management", "issue-tracking"], featured: false, verified: true },
    { slug: "postgres", name: "PostgreSQL", description: "Connect to PostgreSQL databases. Run queries, inspect schemas, and manage tables.", category: "database", icon: "Database", author: "Anthropic", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-postgres"], environment: { POSTGRES_URL: "" } }, configParams: [{ key: "POSTGRES_URL", label: "PostgreSQL Connection URL", placeholder: "postgresql://user:pass@host:5432/db", required: true, secret: true }], tags: ["database", "sql"], featured: false, verified: true },
    { slug: "filesystem", name: "Filesystem", description: "Read, write, and manage files on the local filesystem.", category: "developer", icon: "FolderOpen", author: "Anthropic", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"] }, configParams: [{ key: "ALLOWED_DIR", label: "Allowed Directory Path", placeholder: "/Users/you/projects", required: true, secret: false }], tags: ["files", "local"], featured: false, verified: true },
    { slug: "brave-search", name: "Brave Search", description: "Search the web using Brave Search API. Get search results and web pages.", category: "ai", icon: "Search", author: "Anthropic", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-brave-search"], environment: { BRAVE_API_KEY: "" } }, configParams: [{ key: "BRAVE_API_KEY", label: "Brave Search API Key", placeholder: "BSA...", required: true, secret: true }], tags: ["search", "web"], featured: false, verified: true },
    { slug: "google-drive", name: "Google Drive", description: "Search and read files from Google Drive. Access documents and spreadsheets.", category: "productivity", icon: "HardDrive", author: "Anthropic", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-gdrive"], environment: { GDRIVE_CLIENT_ID: "", GDRIVE_CLIENT_SECRET: "" } }, configParams: [{ key: "GDRIVE_CLIENT_ID", label: "Google OAuth Client ID", placeholder: "xxxx.apps.googleusercontent.com", required: true, secret: false }, { key: "GDRIVE_CLIENT_SECRET", label: "Google OAuth Client Secret", placeholder: "GOCSPX-...", required: true, secret: true }], tags: ["files", "cloud-storage"], featured: false, verified: true },
    { slug: "sentry", name: "Sentry", description: "Access Sentry error tracking data. View issues, events, and project details.", category: "developer", icon: "Bug", author: "Sentry", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@sentry/mcp-server"], environment: { SENTRY_AUTH_TOKEN: "" } }, configParams: [{ key: "SENTRY_AUTH_TOKEN", label: "Sentry Auth Token", placeholder: "sntrys_...", required: true, secret: true }], tags: ["error-tracking", "monitoring"], featured: false, verified: true },
    { slug: "puppeteer", name: "Puppeteer", description: "Control a headless browser for web scraping, testing, and automation.", category: "developer", icon: "Globe", author: "Anthropic", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-puppeteer"] }, configParams: [], tags: ["browser", "scraping", "automation"], featured: false, verified: true },
    { slug: "sqlite", name: "SQLite", description: "Query and manage SQLite databases. Execute SQL and inspect schemas.", category: "database", icon: "Database", author: "Anthropic", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-sqlite"], environment: { SQLITE_DB_PATH: "" } }, configParams: [{ key: "SQLITE_DB_PATH", label: "SQLite Database Path", placeholder: "/path/to/database.db", required: true, secret: false }], tags: ["database", "sql", "local"], featured: false, verified: true },
    { slug: "memory", name: "Memory (Knowledge Graph)", description: "Persistent memory using a local knowledge graph. Store facts and relationships across sessions.", category: "ai", icon: "Brain", author: "Anthropic", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-memory"] }, configParams: [], tags: ["memory", "knowledge-graph", "persistence"], featured: true, verified: true },
    { slug: "exa", name: "Exa Search", description: "AI-powered web search using Exa. Find relevant content and documentation.", category: "ai", icon: "Sparkles", author: "Exa", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "exa-mcp-server"], environment: { EXA_API_KEY: "" } }, configParams: [{ key: "EXA_API_KEY", label: "Exa API Key", placeholder: "exa-...", required: true, secret: true }], tags: ["search", "ai-search", "research"], featured: false, verified: true },
    { slug: "todoist", name: "Todoist", description: "Manage tasks and projects in Todoist. Create, update, and complete tasks.", category: "productivity", icon: "ListTodo", author: "Community", serverType: "local", configTemplate: { type: "local", command: ["npx", "-y", "todoist-mcp-server"], environment: { TODOIST_API_TOKEN: "" } }, configParams: [{ key: "TODOIST_API_TOKEN", label: "Todoist API Token", placeholder: "your-api-token", required: true, secret: true }], tags: ["tasks", "todo", "project-management"], featured: false, verified: false },
  ]

  let inserted = 0
  for (const item of SEED) {
    const [existing] = await db.select({ id: mcpCatalog.id }).from(mcpCatalog).where(eq(mcpCatalog.slug, item.slug as string))
    if (existing) continue

    await db.insert(mcpCatalog).values({
      id: createId("mcp"),
      ...item,
    } as any)
    inserted++
  }

  return c.json({ success: true, inserted, total: SEED.length })
})

// ── Helper ──

async function refreshGatewayConfig() {
  try {
    await db.execute(sql`SELECT refresh_gateway_config()`)
  } catch (err) {
    console.error("Failed to refresh gateway_config:", err)
    // Non-fatal — gateway falls back to direct table query
  }
}

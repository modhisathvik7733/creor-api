import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { mcpCatalog, mcpInstallations } from "../db/schema.ts"
import { eq, and, isNull, ilike, sql } from "drizzle-orm"
import { requireAuth, requireAdmin, type AuthContext } from "../middleware/auth.ts"
import { createId } from "../lib/id.ts"
import { encrypt, decrypt } from "../lib/crypto.ts"
import { logAudit } from "../lib/audit.ts"
import { getRegistryServers, type CatalogEntry } from "../services/mcp-registry.ts"

export const marketplaceRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

// ── Public: Browse catalog (no auth, cached) ──

let catalogCache: { data: unknown; timestamp: number } | null = null
const CATALOG_CACHE_TTL = 5 * 60 * 1000

marketplaceRoutes.get("/catalog", async (c) => {
  const category = c.req.query("category")
  const search = c.req.query("search")
  const featured = c.req.query("featured")
  const showAll = c.req.query("showAll") === "true"
  const limit = parseInt(c.req.query("limit") ?? "25")
  const offset = parseInt(c.req.query("offset") ?? "0")

  // Skip cache if filtering
  const useCache = !category && !search && !featured && offset === 0
  if (useCache && catalogCache && Date.now() - catalogCache.timestamp < CATALOG_CACHE_TTL) {
    c.header("Cache-Control", "public, max-age=300")
    c.header("X-Cache", "HIT")
    return c.json(catalogCache.data)
  }

  // 1. Fetch local curated servers (always featured)
  const conditions = [eq(mcpCatalog.enabled, true)]
  if (category) conditions.push(eq(mcpCatalog.category, category))
  if (search) {
    conditions.push(
      sql`(${mcpCatalog.name} ILIKE ${"%" + search + "%"} OR ${mcpCatalog.description} ILIKE ${"%" + search + "%"} OR ${mcpCatalog.slug} ILIKE ${"%" + search + "%"})`
    )
  }
  if (featured === "true") conditions.push(eq(mcpCatalog.featured, true))

  const localRows = await db
    .select()
    .from(mcpCatalog)
    .where(and(...conditions))
    .orderBy(sql`sort_order ASC, install_count DESC`)

  // Mark local servers with source="featured" and map logoUrl
  const localMapped = localRows.map((r: any) => ({
    ...r,
    logoUrl: r.logoUrl ?? r.logo_url ?? null,
    githubUrl: r.githubUrl ?? r.github_url ?? null,
    githubStars: r.githubStars ?? r.github_stars ?? 0,
    source: "featured" as const,
  }))

  // 2. Fetch registry servers (community), deduped against local slugs
  const localSlugs = new Set(localMapped.map((r: any) => r.slug))
  let registryResult = { servers: [] as CatalogEntry[], total: 0, hasMore: false }
  if (featured !== "true") {
    registryResult = await getRegistryServers({
      search: search ?? undefined,
      category: category ?? undefined,
      limit,
      offset: Math.max(0, offset - localMapped.length),
      excludeSlugs: localSlugs,
      verifiedOnly: !showAll,
    })
  }

  // On first page, show local first then registry; subsequent pages registry only
  const servers = offset === 0
    ? [...localMapped, ...registryResult.servers]
    : registryResult.servers

  const result = {
    servers,
    total: localMapped.length + registryResult.total,
    hasMore: registryResult.hasMore,
  }

  if (useCache) {
    catalogCache = { data: result, timestamp: Date.now() }
  }

  c.header("Cache-Control", "public, max-age=300")
  c.header("X-Cache", useCache ? "MISS" : "BYPASS")
  return c.json(result)
})

marketplaceRoutes.get("/catalog/:slug", async (c) => {
  const slug = c.req.param("slug")

  const [item] = await db
    .select()
    .from(mcpCatalog)
    .where(and(eq(mcpCatalog.slug, slug), eq(mcpCatalog.enabled, true)))

  if (!item) return c.json({ error: "Not found" }, 404)

  return c.json(item)
})

// ── Authenticated: Installation management ──

marketplaceRoutes.use("/installations/*", requireAuth)
marketplaceRoutes.use("/installations", requireAuth)

// List workspace installations
marketplaceRoutes.get("/installations", async (c) => {
  const auth = c.get("auth")

  const rows = await db
    .select({
      id: mcpInstallations.id,
      mcpName: mcpInstallations.mcpName,
      enabled: mcpInstallations.enabled,
      timeCreated: mcpInstallations.timeCreated,
      catalogName: mcpCatalog.name,
      catalogSlug: mcpCatalog.slug,
      catalogIcon: mcpCatalog.icon,
      catalogLogoUrl: mcpCatalog.logoUrl,
      catalogCategory: mcpCatalog.category,
      catalogAuthor: mcpCatalog.author,
    })
    .from(mcpInstallations)
    .innerJoin(mcpCatalog, eq(mcpInstallations.catalogId, mcpCatalog.id))
    .where(
      and(
        eq(mcpInstallations.workspaceId, auth.workspaceId),
        isNull(mcpInstallations.timeDeleted),
      ),
    )
    .orderBy(sql`${mcpInstallations.timeCreated} DESC`)

  return c.json(
    rows.map((r) => ({
      id: r.id,
      mcpName: r.mcpName,
      enabled: r.enabled,
      timeCreated: r.timeCreated,
      catalog: {
        name: r.catalogName,
        slug: r.catalogSlug,
        icon: r.catalogIcon,
        logoUrl: r.catalogLogoUrl,
        category: r.catalogCategory,
        author: r.catalogAuthor,
      },
    })),
  )
})

// Install an MCP server
const installSchema = z.object({
  catalogSlug: z.string().min(1),
  mcpName: z.string().min(1).max(100).optional(),
  configValues: z.record(z.string()).optional(),
  // Registry server data (sent by frontend for servers not in local DB)
  registryData: z.object({
    name: z.string(),
    description: z.string(),
    category: z.string(),
    serverType: z.string(),
    configTemplate: z.record(z.unknown()),
    configParams: z.array(z.object({
      key: z.string(),
      label: z.string(),
      placeholder: z.string(),
      required: z.boolean(),
      secret: z.boolean(),
    })).optional(),
    logoUrl: z.string().nullable().optional(),
    author: z.string().nullable().optional(),
    githubUrl: z.string().nullable().optional(),
  }).optional(),
})

marketplaceRoutes.post("/installations", zValidator("json", installSchema), async (c) => {
  const auth = c.get("auth")
  const body = c.req.valid("json")

  try {
    // Find catalog item in local DB
    let [catalogItem] = await db
      .select()
      .from(mcpCatalog)
      .where(and(eq(mcpCatalog.slug, body.catalogSlug), eq(mcpCatalog.enabled, true)))

    // If not in local DB but registry data provided, auto-create catalog entry
    if (!catalogItem && body.registryData) {
      const regId = `reg_${body.catalogSlug}`
      await db.insert(mcpCatalog).values({
        id: regId,
        slug: body.catalogSlug,
        name: body.registryData.name,
        description: body.registryData.description,
        category: body.registryData.category,
        serverType: body.registryData.serverType,
        configTemplate: body.registryData.configTemplate,
        configParams: body.registryData.configParams ?? [],
        logoUrl: body.registryData.logoUrl ?? null,
        author: body.registryData.author ?? null,
        githubUrl: body.registryData.githubUrl ?? null,
        tags: [],
        featured: false,
        verified: false,
        enabled: true,
      }).onConflictDoNothing();

      [catalogItem] = await db
        .select()
        .from(mcpCatalog)
        .where(eq(mcpCatalog.slug, body.catalogSlug))
    }

    if (!catalogItem) return c.json({ error: "Catalog item not found" }, 404)

    // Validate required config params
    const params = (catalogItem.configParams as Array<{ key: string; required: boolean }>) ?? []
    for (const param of params) {
      if (param.required && !body.configValues?.[param.key]) {
        return c.json({ error: `Missing required config: ${param.key}` }, 400)
      }
    }

    const mcpName = body.mcpName ?? catalogItem.slug

    // Check for existing installation with same name
    const [existing] = await db
      .select({ id: mcpInstallations.id })
      .from(mcpInstallations)
      .where(
        and(
          eq(mcpInstallations.workspaceId, auth.workspaceId),
          eq(mcpInstallations.mcpName, mcpName),
          isNull(mcpInstallations.timeDeleted),
        ),
      )

    if (existing) {
      return c.json({ error: `MCP server with name "${mcpName}" already installed` }, 409)
    }

    // Build resolved config from template + user values
    const template = catalogItem.configTemplate as Record<string, unknown>
    const resolvedConfig = { ...template }
    if (body.configValues) {
      if (template.environment) {
        resolvedConfig.environment = {
          ...(template.environment as Record<string, string>),
          ...body.configValues,
        }
      }
      if (template.headers) {
        resolvedConfig.headers = {
          ...(template.headers as Record<string, string>),
          ...body.configValues,
        }
      }
    }

    // Encrypt secret values
    let encryptedValues: string | null = null
    if (body.configValues) {
      const secretParams = params.filter((p: any) => p.secret)
      const secrets: Record<string, string> = {}
      for (const sp of secretParams) {
        if (body.configValues[sp.key]) {
          secrets[sp.key] = body.configValues[sp.key]
        }
      }
      if (Object.keys(secrets).length > 0) {
        encryptedValues = await encrypt(JSON.stringify(secrets))
      }
    }

    const id = createId("mcpi")

    await db.insert(mcpInstallations).values({
      id,
      workspaceId: auth.workspaceId,
      catalogId: catalogItem.id,
      userId: auth.userId,
      mcpName,
      config: resolvedConfig,
      configValues: encryptedValues,
      enabled: true,
    })

    // Increment install count
    await db
      .update(mcpCatalog)
      .set({ installCount: sql`COALESCE(${mcpCatalog.installCount}, 0) + 1` })
      .where(eq(mcpCatalog.id, catalogItem.id))

    void logAudit({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      action: "marketplace.install",
      resourceType: "mcp_installation",
      resourceId: id,
      metadata: { catalogSlug: body.catalogSlug, mcpName },
    })

    // Invalidate catalog cache
    catalogCache = null

    return c.json({ id, mcpName }, 201)
  } catch (err) {
    console.error("Marketplace install error:", err)
    return c.json({ error: "Failed to install MCP server" }, 500)
  }
})

// Update installation (enable/disable, config)
const updateInstallSchema = z.object({
  enabled: z.boolean().optional(),
  configValues: z.record(z.string()).optional(),
})

marketplaceRoutes.patch(
  "/installations/:id",
  zValidator("json", updateInstallSchema),
  async (c) => {
    const auth = c.get("auth")
    const installId = c.req.param("id")
    const body = c.req.valid("json")

    const [installation] = await db
      .select()
      .from(mcpInstallations)
      .where(
        and(
          eq(mcpInstallations.id, installId),
          eq(mcpInstallations.workspaceId, auth.workspaceId),
          isNull(mcpInstallations.timeDeleted),
        ),
      )

    if (!installation) return c.json({ error: "Installation not found" }, 404)

    const updates: Record<string, unknown> = { timeUpdated: new Date() }

    if (body.enabled !== undefined) {
      updates.enabled = body.enabled
    }

    if (body.configValues) {
      // Re-validate required config params against catalog schema
      const [catalogItem] = await db
        .select({ configParams: mcpCatalog.configParams })
        .from(mcpCatalog)
        .where(eq(mcpCatalog.id, installation.catalogId))

      if (catalogItem) {
        const params = (catalogItem.configParams as Array<{ key: string; required: boolean }>) ?? []
        // Merge existing values with new values for validation
        let existingValues: Record<string, string> = {}
        if (installation.configValues) {
          try {
            existingValues = JSON.parse(await decrypt(installation.configValues))
          } catch { /* use empty */ }
        }
        const mergedValues = { ...existingValues, ...body.configValues }
        for (const param of params) {
          if (param.required && !mergedValues[param.key]) {
            return c.json({ error: `Missing required config: ${param.key}` }, 400)
          }
        }
      }

      // Re-encrypt values
      updates.configValues = await encrypt(JSON.stringify(body.configValues))

      // Update resolved config
      const config = installation.config as Record<string, unknown>
      if (config.environment) {
        config.environment = {
          ...(config.environment as Record<string, string>),
          ...body.configValues,
        }
      }
      updates.config = config
    }

    await db
      .update(mcpInstallations)
      .set(updates)
      .where(eq(mcpInstallations.id, installId))

    void logAudit({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      action: "marketplace.update",
      resourceType: "mcp_installation",
      resourceId: installId,
      metadata: { enabled: body.enabled },
    })

    return c.json({ success: true })
  },
)

// Uninstall (hard delete)
marketplaceRoutes.delete("/installations/:id", async (c) => {
  const auth = c.get("auth")
  const installId = c.req.param("id")

  const [installation] = await db
    .select({ id: mcpInstallations.id, catalogId: mcpInstallations.catalogId })
    .from(mcpInstallations)
    .where(
      and(
        eq(mcpInstallations.id, installId),
        eq(mcpInstallations.workspaceId, auth.workspaceId),
        isNull(mcpInstallations.timeDeleted),
      ),
    )

  if (!installation) return c.json({ error: "Installation not found" }, 404)

  await db
    .delete(mcpInstallations)
    .where(eq(mcpInstallations.id, installId))

  // Decrement install count
  await db
    .update(mcpCatalog)
    .set({ installCount: sql`GREATEST(COALESCE(${mcpCatalog.installCount}, 0) - 1, 0)` })
    .where(eq(mcpCatalog.id, installation.catalogId))

  void logAudit({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    action: "marketplace.uninstall",
    resourceType: "mcp_installation",
    resourceId: installId,
  })

  catalogCache = null

  return c.json({ success: true })
})

// Engine sync — returns resolved MCP configs
marketplaceRoutes.get("/installations/sync", async (c) => {
  const auth = c.get("auth")

  const rows = await db
    .select({
      id: mcpInstallations.id,
      mcpName: mcpInstallations.mcpName,
      config: mcpInstallations.config,
      configValues: mcpInstallations.configValues,
      enabled: mcpInstallations.enabled,
      catalogSlug: mcpCatalog.slug,
      catalogName: mcpCatalog.name,
    })
    .from(mcpInstallations)
    .leftJoin(mcpCatalog, eq(mcpInstallations.catalogId, mcpCatalog.id))
    .where(
      and(
        eq(mcpInstallations.workspaceId, auth.workspaceId),
        isNull(mcpInstallations.timeDeleted),
      ),
    )

  const result: Record<string, unknown> = {}

  for (const row of rows) {
    const config = row.config as Record<string, unknown>

    // Decrypt and merge secret values into config
    if (row.configValues) {
      try {
        const secrets = JSON.parse(await decrypt(row.configValues)) as Record<string, string>
        if (config.environment) {
          config.environment = {
            ...(config.environment as Record<string, string>),
            ...secrets,
          }
        }
        if (config.headers) {
          config.headers = {
            ...(config.headers as Record<string, string>),
            ...secrets,
          }
        }
      } catch {
        // Skip if decryption fails
      }
    }

    // Always sync the enabled state from the DB column into the config.
    // The config JSON might have a stale `enabled` value from a previous toggle,
    // so we always override it with the authoritative DB column value.
    if (!row.enabled) {
      config.enabled = false
    } else {
      delete config.enabled  // Remove stale enabled:false from config JSON
    }
    // Include installation ID for bidirectional toggle sync
    config._installationId = row.id

    // Use catalog name (kebab-cased) as the key so the IDE shows a readable name
    const displayName = row.catalogName
      ? row.catalogName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
      : row.mcpName
    result[displayName] = config
  }

  return c.json(result)
})

// Realtime config — returns Supabase connection details for engine realtime subscription
marketplaceRoutes.get("/realtime-config", requireAuth, async (c) => {
  const supabaseUrl = process.env.CREOR_SUPABASE_URL || "https://uwhckbpjrpgopduiyeaw.supabase.co"
  const anonKey = process.env.CREOR_SUPABASE_ANON_KEY

  if (!anonKey) {
    return c.json({ error: "Realtime not configured" }, 503)
  }

  const auth = c.get("auth")
  return c.json({
    supabaseUrl,
    anonKey,
    workspaceId: auth.workspaceId,
    table: "mcp_installations",
  })
})

// ── Admin: Catalog management ──

const catalogCreateSchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().min(1),
  category: z.string().min(1),
  icon: z.string().optional(),
  author: z.string().optional(),
  sourceUrl: z.string().optional(),
  docsUrl: z.string().optional(),
  serverType: z.enum(["local", "remote"]),
  configTemplate: z.record(z.unknown()),
  configParams: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      placeholder: z.string(),
      required: z.boolean(),
      secret: z.boolean(),
      helpUrl: z.string().optional(),
    }),
  ).optional(),
  tags: z.array(z.string()).optional(),
  featured: z.boolean().optional(),
  verified: z.boolean().optional(),
})

marketplaceRoutes.post(
  "/catalog",
  requireAuth,
  requireAdmin,
  zValidator("json", catalogCreateSchema),
  async (c) => {
    const body = c.req.valid("json")
    const id = createId("mcp")

    await db.insert(mcpCatalog).values({
      id,
      slug: body.slug,
      name: body.name,
      description: body.description,
      category: body.category,
      icon: body.icon,
      author: body.author,
      sourceUrl: body.sourceUrl,
      docsUrl: body.docsUrl,
      serverType: body.serverType,
      configTemplate: body.configTemplate,
      configParams: body.configParams ?? [],
      tags: body.tags ?? [],
      featured: body.featured ?? false,
      verified: body.verified ?? false,
    })

    catalogCache = null

    return c.json({ id, slug: body.slug }, 201)
  },
)

const catalogUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  icon: z.string().optional(),
  author: z.string().optional(),
  sourceUrl: z.string().optional(),
  docsUrl: z.string().optional(),
  serverType: z.enum(["local", "remote"]).optional(),
  configTemplate: z.record(z.unknown()).optional(),
  configParams: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      placeholder: z.string(),
      required: z.boolean(),
      secret: z.boolean(),
      helpUrl: z.string().optional(),
    }),
  ).optional(),
  tags: z.array(z.string()).optional(),
  featured: z.boolean().optional(),
  verified: z.boolean().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().optional(),
})

marketplaceRoutes.patch(
  "/catalog/:slug",
  requireAuth,
  requireAdmin,
  zValidator("json", catalogUpdateSchema),
  async (c) => {
    const slug = c.req.param("slug")
    const body = c.req.valid("json")

    await db
      .update(mcpCatalog)
      .set({ ...body, timeUpdated: new Date() })
      .where(eq(mcpCatalog.slug, slug))

    catalogCache = null

    return c.json({ success: true })
  },
)

marketplaceRoutes.delete(
  "/catalog/:slug",
  requireAuth,
  requireAdmin,
  async (c) => {
    const slug = c.req.param("slug")

    await db
      .update(mcpCatalog)
      .set({ enabled: false, timeUpdated: new Date() })
      .where(eq(mcpCatalog.slug, slug))

    catalogCache = null

    return c.json({ success: true })
  },
)

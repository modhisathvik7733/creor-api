/**
 * MCP Registry Sync Service
 *
 * Fetches MCP servers from the official MCP Registry at
 * registry.modelcontextprotocol.io and maps them to Creor's catalog format.
 * Uses L1 in-memory + L2 database cache so Edge Function cold starts are fast.
 */

import { db } from "../db/client.ts"
import { mcpRegistryCache } from "../db/schema.ts"
import { eq } from "drizzle-orm"

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0"
const CACHE_TTL = 60 * 60 * 1000 // 1 hour
const PAGE_SIZE = 100

// ── Types ──

interface RegistryServer {
  server: {
    name: string
    title?: string
    description?: string
    version?: string
    websiteUrl?: string
    icons?: Array<{ src: string; mimeType?: string; sizes?: string }>
    repository?: { url: string; source?: string; id?: string; subfolder?: string }
    remotes?: Array<{
      type: "streamable-http" | "sse"
      url: string
      headers?: Array<{
        name: string
        description?: string
        isRequired?: boolean
        isSecret?: boolean
        value?: string
      }>
    }>
    packages?: Array<{
      registryType: string
      identifier: string
      version?: string
      transport?: { type: string }
      runtime?: string
      environmentVariables?: Array<{
        name: string
        description?: string
        isRequired?: boolean
        isSecret?: boolean
      }>
      arguments?: string[]
    }>
  }
  _meta?: {
    "io.modelcontextprotocol.registry/official"?: {
      status: string
      publishedAt?: string
      updatedAt?: string
      isLatest?: boolean
    }
  }
}

interface RegistryResponse {
  servers: RegistryServer[]
  metadata: {
    nextCursor?: string | null
    count: number
  }
}

export interface CatalogEntry {
  id: string
  slug: string
  name: string
  description: string
  category: string
  icon: string | null
  logoUrl: string | null
  author: string | null
  sourceUrl: string | null
  githubUrl: string | null
  serverType: string
  configTemplate: Record<string, unknown>
  configParams: Array<{
    key: string
    label: string
    placeholder: string
    required: boolean
    secret: boolean
  }>
  tags: string[]
  featured: boolean
  verified: boolean
  official: boolean
  installCount: number
  version: string | null
  source: "registry"
}

// ── Official MCP orgs ──

const OFFICIAL_ORGS = new Set([
  "modelcontextprotocol",
  "awslabs",
  "microsoft",
  "github",
  "cloudflare",
  "stripe",
  "makenotion",
  "supabase-community",
  "googleapis",
  "sveltejs",
  "anthropics",
  "neondatabase",
  "browserbase",
  "mendableai",
  "qdrant",
  "executeautomation",
  "elevenlabs",
  "motherduckdb",
  "postmanlabs",
  "auth0",
  "paypal",
  "posthog",
])

export function isOfficialMcp(githubUrl: string | null | undefined): boolean {
  if (!githubUrl) return false
  const match = githubUrl.match(/github\.com\/([^/]+)/)
  return match ? OFFICIAL_ORGS.has(match[1].toLowerCase()) : false
}

// ── L1 In-Memory Cache (within same Edge Function invocation) ──

let memCache: { entries: CatalogEntry[]; timestamp: number } | null = null

// ── GitHub URL normalizer ──

function normalizeGithubUrl(url: string | null | undefined): string | null {
  if (!url) return null
  return url
    .toLowerCase()
    .replace('http://', 'https://')
    .replace('www.github.com', 'github.com')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .split('/tree/')[0]
    .split('/blob/')[0]
}

// ── Fetch all pages from registry ──

async function fetchAllServers(): Promise<RegistryServer[]> {
  const allServers: RegistryServer[] = []
  let cursor: string | null = null

  for (let page = 0; page < 50; page++) {
    const url = new URL(`${REGISTRY_BASE}/servers`)
    url.searchParams.set("limit", String(PAGE_SIZE))
    if (cursor) url.searchParams.set("cursor", cursor)

    const res = await fetch(url.toString(), {
      headers: { "Accept": "application/json", "User-Agent": "creor-marketplace/1.0" },
    })

    if (!res.ok) {
      console.error(`Registry fetch failed: ${res.status}`)
      break
    }

    const data: RegistryResponse = await res.json()
    allServers.push(...data.servers)

    if (!data.metadata.nextCursor) break
    cursor = data.metadata.nextCursor
  }

  return allServers
}

// ── Name formatting ──

const GENERIC_TITLES = new Set(["mcp", "server", "mcp server", "mcp-server", "tool", "tools"])

function isGenericTitle(title: string | undefined): boolean {
  if (!title) return true
  return GENERIC_TITLES.has(title.toLowerCase().trim())
}

function formatServerName(rawName: string): string {
  let base = rawName.includes("/") ? rawName.split("/").pop()! : rawName
  // Strip reverse-domain prefixes (com.notion → notion, io.github.foo → foo)
  base = base.replace(/^(com|io|org|net|dev)\./i, "").replace(/^github\./i, "")
  return base
    .replace(/[-_]/g, " ")
    .replace(/\bmcp\b/gi, "MCP")
    .replace(/\bai\b/gi, "AI")
    .replace(/\bapi\b/gi, "API")
    .replace(/\bdb\b/gi, "DB")
    .replace(/\bsdk\b/gi, "SDK")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim()
}

// ── Map registry server to Creor catalog format ──

function deriveSlug(name: string): string {
  // Use full name to avoid collisions (e.g., many servers are named "<org>/mcp")
  // Strip common domain prefixes (com., ai., io., org., dev., net.)
  const stripped = name
    .replace(/^(com|ai|io|org|dev|net)\./i, "")
    .replace(/^github\./i, "")
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function deriveCategory(server: RegistryServer["server"]): string {
  const desc = (server.description ?? "").toLowerCase()
  const name = (server.name + " " + (server.title ?? "")).toLowerCase()
  const combined = name + " " + desc

  if (/database|sql|postgres|mysql|mongo|redis|supabase/.test(combined)) return "database"
  if (/search|brave|exa|google|web search/.test(combined)) return "ai"
  if (/slack|discord|email|messaging|communication/.test(combined)) return "communication"
  if (/notion|todoist|linear|jira|project|task|calendar/.test(combined)) return "productivity"
  if (/file|filesystem|git|github|code|dev|docker|kubernetes/.test(combined)) return "developer"
  return "developer"
}

function deriveAuthor(server: RegistryServer["server"]): string | null {
  if (server.repository?.url) {
    const match = server.repository.url.match(/github\.com\/([^/]+)/)
    if (match) return match[1]
  }
  const parts = server.name.split("/")
  if (parts.length > 1) return parts[0]
  return null
}

function deriveEnvParams(envVars: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean }> | undefined): CatalogEntry["configParams"] {
  return (envVars ?? []).map(e => ({
    key: e.name,
    label: e.description ?? e.name,
    placeholder: "",
    required: e.isRequired ?? false,
    secret: e.isSecret ?? false,
  }))
}

function mapToEntry(reg: RegistryServer): CatalogEntry | null {
  const srv = reg.server
  const meta = reg._meta?.["io.modelcontextprotocol.registry/official"]
  const slug = deriveSlug(srv.name)

  // Derive config template from packages or remotes
  let serverType = "remote"
  let configTemplate: Record<string, unknown> = {}
  let configParams: CatalogEntry["configParams"] = []

  const remote = srv.remotes?.[0]
  const npmPkg = srv.packages?.find(p => p.registryType === "npm" && p.transport?.type === "stdio")
  const pypiPkg = srv.packages?.find(p => p.registryType === "pypi")
  const dockerPkg = srv.packages?.find(p => p.registryType === "oci")

  if (npmPkg) {
    serverType = "local"
    const envDefaults: Record<string, string> = {}
    npmPkg.environmentVariables?.forEach(e => { envDefaults[e.name] = "" })
    configTemplate = {
      type: "local",
      command: ["npx", "-y", npmPkg.identifier, ...(npmPkg.arguments ?? [])],
      ...(Object.keys(envDefaults).length > 0 ? { environment: envDefaults } : {}),
    }
    configParams = deriveEnvParams(npmPkg.environmentVariables)
  } else if (pypiPkg) {
    serverType = "local"
    const envDefaults: Record<string, string> = {}
    pypiPkg.environmentVariables?.forEach(e => { envDefaults[e.name] = "" })
    configTemplate = {
      type: "local",
      command: ["uvx", pypiPkg.identifier, ...(pypiPkg.arguments ?? [])],
      ...(Object.keys(envDefaults).length > 0 ? { environment: envDefaults } : {}),
    }
    configParams = deriveEnvParams(pypiPkg.environmentVariables)
  } else if (dockerPkg) {
    serverType = "local"
    configTemplate = {
      type: "local",
      command: ["docker", "run", "-i", "--rm", dockerPkg.identifier],
    }
  } else if (remote) {
    serverType = "remote"
    configTemplate = { type: "remote", url: remote.url }

    const allHeaders = remote.headers ?? []
    if (allHeaders.length > 0) {
      const headerDefaults: Record<string, string> = {}
      allHeaders.forEach(h => { headerDefaults[h.name] = "" })
      configTemplate = { ...configTemplate, headers: headerDefaults }
    }

    configParams = allHeaders.map(h => ({
      key: h.name,
      label: h.description ?? h.name,
      placeholder: h.value ?? "",
      required: h.isRequired ?? false,
      secret: h.isSecret ?? false,
    }))
  } else {
    // No packages and no remotes — server can't be installed
    return null
  }

  return {
    id: `reg_${slug}`,
    slug,
    name: isGenericTitle(srv.title) ? formatServerName(srv.name) : srv.title!,
    description: srv.description ?? "",
    category: deriveCategory(srv),
    icon: null,
    logoUrl: srv.icons?.[0]?.src ?? null,
    author: deriveAuthor(srv),
    sourceUrl: srv.websiteUrl ?? srv.repository?.url ?? null,
    githubUrl: srv.repository?.url ?? null,
    serverType,
    configTemplate,
    configParams,
    tags: [],
    featured: false,
    verified: meta?.status === "active",
    official: isOfficialMcp(srv.repository?.url),
    installCount: 0,
    version: srv.version ?? null,
    source: "registry",
  }
}

// ── Dedupe: keep only latest version of each server ──

function dedupeLatest(servers: RegistryServer[]): RegistryServer[] {
  const latest = new Map<string, RegistryServer>()
  for (const s of servers) {
    const meta = s._meta?.["io.modelcontextprotocol.registry/official"]
    if (meta?.isLatest) {
      latest.set(s.server.name, s)
    } else if (!latest.has(s.server.name)) {
      latest.set(s.server.name, s)
    }
  }
  return [...latest.values()]
}

// ── L2 Database Cache ──

async function loadFromDb(): Promise<{ entries: CatalogEntry[]; timestamp: number } | null> {
  try {
    const [row] = await db
      .select()
      .from(mcpRegistryCache)
      .where(eq(mcpRegistryCache.id, "singleton"))

    if (!row || !row.refreshedAt || row.serverCount === 0) return null

    return {
      entries: row.entries as CatalogEntry[],
      timestamp: new Date(row.refreshedAt).getTime(),
    }
  } catch (err) {
    console.error("Failed to read registry cache from DB:", err)
    return null
  }
}

async function saveToDb(entries: CatalogEntry[]): Promise<void> {
  try {
    await db
      .update(mcpRegistryCache)
      .set({
        entries: entries as unknown as Record<string, unknown>,
        serverCount: entries.length,
        refreshedAt: new Date(),
      })
      .where(eq(mcpRegistryCache.id, "singleton"))
  } catch (err) {
    console.error("Failed to write registry cache to DB:", err)
  }
}

// ── Refresh: fetch from registry, process, cache ──

async function refreshEntries(): Promise<CatalogEntry[]> {
  const raw = await fetchAllServers()
  const unique = dedupeLatest(raw)
  const entries = unique
    .map(mapToEntry)
    .filter((e): e is CatalogEntry => e !== null && e.description.length > 0)
  return entries
}

async function ensureCache(): Promise<CatalogEntry[]> {
  // L1: in-memory (same invocation)
  if (memCache && Date.now() - memCache.timestamp < CACHE_TTL) {
    return memCache.entries
  }

  // L2: database (survives cold starts)
  const dbCache = await loadFromDb()
  if (dbCache && Date.now() - dbCache.timestamp < CACHE_TTL) {
    memCache = dbCache
    return dbCache.entries
  }

  // L3: fetch from registry
  try {
    const entries = await refreshEntries()
    memCache = { entries, timestamp: Date.now() }
    await saveToDb(entries)
    return entries
  } catch (err) {
    console.error("Failed to fetch MCP registry:", err)
    // Fall back to stale DB data or stale memory data
    if (dbCache) {
      memCache = dbCache
      return dbCache.entries
    }
    if (memCache) return memCache.entries
    return []
  }
}

// ── Public API ──

export async function getRegistryServers(opts?: {
  search?: string
  category?: string
  limit?: number
  offset?: number
  excludeSlugs?: Set<string>
  excludeGithubUrls?: Set<string>
  verifiedOnly?: boolean
}): Promise<{ servers: CatalogEntry[]; total: number; hasMore: boolean }> {
  const allEntries = await ensureCache()
  let filtered = allEntries

  // Exclude slugs already in local catalog (dedup)
  if (opts?.excludeSlugs?.size) {
    filtered = filtered.filter(s => !opts.excludeSlugs!.has(s.slug))
  }

  // Exclude by normalized GitHub URL (catches same repo with different slugs)
  if (opts?.excludeGithubUrls?.size) {
    filtered = filtered.filter(s => {
      const n = normalizeGithubUrl(s.githubUrl)
      return !n || !opts.excludeGithubUrls!.has(n)
    })
  }

  // Show all registry items by default — the registry itself is a quality source.
  // verifiedOnly=true restricts to registry-verified (active status) servers only.
  if (opts?.verifiedOnly === true) {
    filtered = filtered.filter(s => s.verified)
  }

  // Filter by search
  if (opts?.search) {
    const q = opts.search.toLowerCase()
    filtered = filtered.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.slug.toLowerCase().includes(q) ||
      (s.author ?? "").toLowerCase().includes(q)
    )
  }

  // Filter by category
  if (opts?.category) {
    filtered = filtered.filter(s => s.category === opts.category!.toLowerCase())
  }

  const total = filtered.length
  const offset = opts?.offset ?? 0
  const limit = opts?.limit ?? 25
  const page = filtered.slice(offset, offset + limit)

  return {
    servers: page,
    total,
    hasMore: offset + limit < total,
  }
}

export function invalidateRegistryCache(): void {
  memCache = null
}

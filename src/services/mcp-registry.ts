/**
 * MCP Registry Sync Service
 *
 * Fetches MCP servers from the official MCP Registry at
 * registry.modelcontextprotocol.io and maps them to Creor's catalog format.
 * Uses in-memory caching with 1-hour TTL.
 */

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
  installCount: number
  version: string | null
  source: "registry"
}

// ── Cache ──

let cache: { entries: CatalogEntry[]; timestamp: number } | null = null

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

// ── Map registry server to Creor catalog format ──

function deriveSlug(name: string): string {
  // "com.example/my-server" → "my-server"
  const parts = name.split("/")
  return parts[parts.length - 1]
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

function mapToEntry(reg: RegistryServer): CatalogEntry {
  const srv = reg.server
  const meta = reg._meta?.["io.modelcontextprotocol.registry/official"]
  const slug = deriveSlug(srv.name)

  // Derive config template from remotes or packages
  let serverType = "remote"
  let configTemplate: Record<string, unknown> = {}
  let configParams: CatalogEntry["configParams"] = []

  const remote = srv.remotes?.[0]
  const pkg = srv.packages?.find(p => p.registryType === "npm" && p.transport?.type === "stdio")

  if (pkg) {
    // Local stdio server via npm
    serverType = "local"
    const envDefaults: Record<string, string> = {}
    pkg.environmentVariables?.forEach(e => { envDefaults[e.name] = "" })
    configTemplate = {
      type: "local",
      command: ["npx", "-y", pkg.identifier, ...(pkg.arguments ?? [])],
      ...(Object.keys(envDefaults).length > 0 ? { environment: envDefaults } : {}),
    }
    configParams = (pkg.environmentVariables ?? [])
      .filter(e => e.isRequired)
      .map(e => ({
        key: e.name,
        label: e.description ?? e.name,
        placeholder: "",
        required: true,
        secret: e.isSecret ?? false,
      }))
  } else if (remote) {
    // Remote server
    serverType = "remote"
    configTemplate = { type: "remote", url: remote.url }

    const requiredHeaders = (remote.headers ?? []).filter(h => h.isRequired)
    if (requiredHeaders.length > 0) {
      const headerDefaults: Record<string, string> = {}
      requiredHeaders.forEach(h => { headerDefaults[h.name] = "" })
      configTemplate = { ...configTemplate, headers: headerDefaults }
    }

    configParams = (remote.headers ?? [])
      .filter(h => h.isRequired)
      .map(h => ({
        key: h.name,
        label: h.description ?? h.name,
        placeholder: h.value ?? "",
        required: true,
        secret: h.isSecret ?? false,
      }))
  }

  return {
    id: `reg_${slug}`,
    slug,
    name: srv.title ?? slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
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

// ── Public API ──

export async function getRegistryServers(opts?: {
  search?: string
  category?: string
  limit?: number
  offset?: number
}): Promise<{ servers: CatalogEntry[]; total: number; hasMore: boolean }> {
  // Refresh cache if stale
  if (!cache || Date.now() - cache.timestamp > CACHE_TTL) {
    try {
      const raw = await fetchAllServers()
      const unique = dedupeLatest(raw)
      const entries = unique
        .map(mapToEntry)
        .filter(e => e.description.length > 0) // skip entries with no description
      cache = { entries, timestamp: Date.now() }
    } catch (err) {
      console.error("Failed to fetch MCP registry:", err)
      // Return stale cache or empty
      if (!cache) return { servers: [], total: 0, hasMore: false }
    }
  }

  let filtered = cache.entries

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
  const limit = opts?.limit ?? 50
  const page = filtered.slice(offset, offset + limit)

  return {
    servers: page,
    total,
    hasMore: offset + limit < total,
  }
}

export function invalidateRegistryCache(): void {
  cache = null
}

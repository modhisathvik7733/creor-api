import { Hono } from "hono"

const GITHUB_REPO = "modhisathvik7733/creor-app"

// Map VS Code platform IDs to GitHub Release asset names
const PLATFORM_ASSET_MAP: Record<string, string> = {
  "darwin-arm64": "Creor-darwin-arm64.zip",
  "darwin": "Creor-darwin-x64.zip",
  "darwin-x64": "Creor-darwin-x64.zip",
  "linux-x64": "Creor-linux-x64.tar.gz",
  "win32-x64": "Creor-win32-x64.zip",
  "win32-x64-user": "Creor-win32-x64.zip",
}

// Cache latest release + checksums for 5 minutes
let releaseCache: {
  data: any
  checksums: Record<string, string>
  timestamp: number
} | null = null
const CACHE_TTL = 5 * 60 * 1000

async function getLatestRelease() {
  if (releaseCache && Date.now() - releaseCache.timestamp < CACHE_TTL) {
    return releaseCache
  }

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    { headers: { "User-Agent": "creor-update-server" } },
  )
  if (!res.ok) return null
  const data = await res.json()

  // Fetch checksums.txt if present in the release assets
  const checksums: Record<string, string> = {}
  const checksumAsset = data.assets?.find(
    (a: any) => a.name === "checksums.txt",
  )
  if (checksumAsset) {
    try {
      const checksumRes = await fetch(checksumAsset.browser_download_url, {
        headers: { "User-Agent": "creor-update-server" },
      })
      if (checksumRes.ok) {
        const text = await checksumRes.text()
        for (const line of text.trim().split("\n")) {
          const parts = line.trim().split(/\s+/)
          if (parts.length >= 2) {
            const [hash, filename] = parts
            checksums[filename] = hash
          }
        }
      }
    } catch {
      // Checksums are optional — don't fail the update check
    }
  }

  releaseCache = { data, checksums, timestamp: Date.now() }
  return releaseCache
}

export const updateRoutes = new Hono()

// VS Code update endpoint
// Format: GET /api/update/:platform/:quality/:commit
// Returns 200 + JSON if update available, 204 if not
updateRoutes.get("/api/update/:platform/:quality/:commit", async (c) => {
  const { platform, commit } = c.req.param()

  const cached = await getLatestRelease()
  if (!cached || cached.data.draft) {
    return c.body(null, 204)
  }

  const release = cached.data
  const releaseTag = release.tag_name as string // e.g. "v0.2.0"

  // Client's "commit" field is the build tag (e.g. "v0.1.0")
  // Same tag = no update needed
  if (commit === releaseTag) {
    return c.body(null, 204)
  }

  // Find matching asset for this platform
  const assetName = PLATFORM_ASSET_MAP[platform]
  if (!assetName) {
    return c.body(null, 204)
  }

  const asset = release.assets?.find((a: any) => a.name === assetName)
  if (!asset) {
    return c.body(null, 204)
  }

  const releaseVersion = releaseTag.replace(/^v/, "")
  const sha256 = cached.checksums[assetName] || ""

  return c.json({
    url: asset.browser_download_url,
    name: releaseVersion,
    version: releaseTag,
    productVersion: releaseVersion,
    notes: release.body || "",
    pub_date: release.published_at,
    sha256hash: sha256,
  })
})

/** Context set by gateway API key authentication */
export interface GatewayAuth {
  keyId: string
  workspaceId: string
  userId: string
}

/** Resolved upstream provider config for proxying */
export interface ProviderConfig {
  provider: string
  baseUrl: string
  path: string
  upstreamModel: string
  setAuth: (headers: Headers) => void
}

/** Context passed through the usage tracking pipeline */
export interface CostContext {
  requestId: string
  keyData: GatewayAuth
  model: string
  provider: string
  inputCost: number // USD per 1K tokens
  outputCost: number // USD per 1K tokens
  planLimit: number | null // plan limit in USD micro-units
}

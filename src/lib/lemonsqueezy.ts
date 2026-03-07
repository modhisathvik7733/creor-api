import { createHmac } from "node:crypto"

const LS_BASE = "https://api.lemonsqueezy.com/v1"

function getApiKey(): string {
  const key = process.env.LEMON_SQUEEZY_API_KEY
  if (!key) throw new Error("LEMON_SQUEEZY_API_KEY not configured")
  return key
}

async function lsFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${LS_BASE}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      Authorization: `Bearer ${getApiKey()}`,
      ...(options.headers as Record<string, string>),
    },
  })

  const body = await res.json()

  if (!res.ok) {
    const errMsg = body?.errors?.[0]?.detail ?? body?.message ?? JSON.stringify(body)
    throw new Error(`Lemon Squeezy API error (${res.status}): ${errMsg}`)
  }

  return body as T
}

// ── Types ──

export interface LSCheckoutResponse {
  data: {
    type: "checkouts"
    id: string
    attributes: {
      store_id: number
      variant_id: number
      url: string
      created_at: string
      updated_at: string
      test_mode: boolean
      expires_at: string | null
    }
  }
}

export interface LSSubscription {
  data: {
    type: "subscriptions"
    id: string
    attributes: {
      store_id: number
      customer_id: number
      product_id: number
      variant_id: number
      status: "on_trial" | "active" | "paused" | "past_due" | "unpaid" | "cancelled" | "expired"
      cancelled: boolean
      pause: { mode: string; resumes_at: string | null } | null
      trial_ends_at: string | null
      billing_anchor: number
      renews_at: string | null
      ends_at: string | null
      created_at: string
      updated_at: string
      currency: string
      urls: {
        update_payment_method: string
      }
      card_brand: string | null
      card_last_four: string | null
      product_name: string
      variant_name: string
      user_name: string
      user_email: string
    }
  }
}

export interface LSWebhookEvent {
  meta: {
    event_name: string
    custom_data?: Record<string, string>
  }
  data: {
    type: string
    id: string
    attributes: Record<string, unknown>
  }
}

// ── Create Checkout ──

export async function createCheckout(params: {
  storeId: string
  variantId: string
  customPrice?: number // cents — overrides variant price
  email?: string
  custom?: Record<string, string> // metadata → flows to webhook meta.custom_data
  redirectUrl?: string
}): Promise<{ url: string; id: string }> {
  const res = await lsFetch<LSCheckoutResponse>("/checkouts", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "checkouts",
        attributes: {
          ...(params.customPrice !== undefined && { custom_price: params.customPrice }),
          checkout_options: {
            embed: false,
            dark: true,
            media: false,
            desc: false,
            button_color: "#e5530a",
          },
          checkout_data: {
            email: params.email ?? undefined,
            custom: params.custom ?? {},
          },
          product_options: {
            redirect_url: params.redirectUrl ?? undefined,
          },
        },
        relationships: {
          store: {
            data: { type: "stores", id: params.storeId },
          },
          variant: {
            data: { type: "variants", id: params.variantId },
          },
        },
      },
    }),
  })

  return { url: res.data.attributes.url, id: res.data.id }
}

// ── Get Subscription ──

export async function getSubscription(subscriptionId: string): Promise<LSSubscription> {
  return lsFetch<LSSubscription>(`/subscriptions/${subscriptionId}`)
}

// ── Update Subscription (change plan, resume, pause) ──

export async function updateSubscription(
  subscriptionId: string,
  params: {
    variantId?: string
    cancelled?: boolean // false = resume a cancelled subscription
    pause?: { mode: "free"; resumes_at?: string } | null // null = unpause
    invoiceImmediately?: boolean // charge prorated diff now (upgrades)
    disableProrations?: boolean  // skip proration calc (scheduled downgrades)
  },
): Promise<LSSubscription> {
  const attributes: Record<string, unknown> = {}

  if (params.variantId !== undefined) {
    attributes.variant_id = Number(params.variantId)
  }
  if (params.cancelled !== undefined) {
    attributes.cancelled = params.cancelled
  }
  if (params.pause !== undefined) {
    attributes.pause = params.pause
  }
  if (params.invoiceImmediately !== undefined) {
    attributes.invoice_immediately = params.invoiceImmediately
  }
  if (params.disableProrations !== undefined) {
    attributes.disable_prorations = params.disableProrations
  }

  return lsFetch<LSSubscription>(`/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        type: "subscriptions",
        id: subscriptionId,
        attributes,
      },
    }),
  })
}

// ── Cancel Subscription ──

export async function cancelSubscription(subscriptionId: string): Promise<LSSubscription> {
  return lsFetch<LSSubscription>(`/subscriptions/${subscriptionId}`, {
    method: "DELETE",
  })
}

// ── Verify Webhook Signature (HMAC-SHA256) ──

export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET
  if (!secret) throw new Error("LEMON_SQUEEZY_WEBHOOK_SECRET not configured")

  const hash = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  return hash === signature
}

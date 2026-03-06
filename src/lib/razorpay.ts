const RAZORPAY_BASE = "https://api.razorpay.com/v1"

function getAuth(): string {
  const keyId = process.env.RAZORPAY_KEY_ID
  const keySecret = process.env.RAZORPAY_KEY_SECRET
  if (!keyId || !keySecret) throw new Error("Razorpay credentials not configured")
  return btoa(`${keyId}:${keySecret}`)
}

async function rzFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${RAZORPAY_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${getAuth()}`,
      ...(options.headers as Record<string, string>),
    },
  })

  const body = await res.json()

  if (!res.ok) {
    const errMsg = body?.error?.description ?? body?.error ?? JSON.stringify(body)
    throw new Error(`Razorpay API error (${res.status}): ${errMsg}`)
  }

  return body as T
}

/** Create a one-time payment order */
export async function createRazorpayOrder(params: {
  amount: number // in paise
  currency: string
  receipt: string
  notes?: Record<string, string>
}) {
  return rzFetch<{ id: string; amount: number; currency: string; status: string }>(
    "/orders",
    {
      method: "POST",
      body: JSON.stringify({
        amount: params.amount,
        currency: params.currency,
        receipt: params.receipt,
        notes: params.notes,
      }),
    },
  )
}

/** Create a subscription plan in Razorpay */
export async function createRazorpayPlan(params: {
  name: string
  amount: number // in paise
  currency: string
  description?: string
  period?: "monthly" | "yearly"
}) {
  return rzFetch<{ id: string; item: { name: string; amount: number } }>(
    "/plans",
    {
      method: "POST",
      body: JSON.stringify({
        period: params.period ?? "monthly",
        interval: 1,
        item: {
          name: params.name,
          amount: params.amount,
          currency: params.currency,
          description: params.description ?? params.name,
        },
      }),
    },
  )
}

/** Create a recurring subscription */
export async function createRazorpaySubscription(params: {
  planId: string
  totalCount: number
  notes?: Record<string, string>
}) {
  if (!params.planId) {
    throw new Error("Razorpay plan ID is not configured for this plan")
  }
  return rzFetch<{ id: string; short_url: string; status: string }>(
    "/subscriptions",
    {
      method: "POST",
      body: JSON.stringify({
        plan_id: params.planId,
        total_count: params.totalCount,
        notes: params.notes,
      }),
    },
  )
}

/** Fetch a subscription's current status from Razorpay */
export async function fetchRazorpaySubscription(subscriptionId: string) {
  return rzFetch<{
    id: string
    plan_id: string
    status: string
    notes: Record<string, string>
    current_start: number | null
    current_end: number | null
  }>(`/subscriptions/${subscriptionId}`)
}

/** Cancel a subscription immediately */
export async function cancelRazorpaySubscription(subscriptionId: string) {
  return rzFetch<{ id: string; status: string }>(
    `/subscriptions/${subscriptionId}/cancel`,
    { method: "POST" },
  )
}

/** Cancel a subscription at end of current billing cycle */
export async function cancelRazorpaySubscriptionAtCycleEnd(subscriptionId: string) {
  return rzFetch<{ id: string; status: string }>(
    `/subscriptions/${subscriptionId}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({ cancel_at_cycle_end: true }),
    },
  )
}

/** Update subscription plan (upgrade/downgrade) */
export async function updateRazorpaySubscription(params: {
  subscriptionId: string
  planId: string
  scheduleChangeAt: "now" | "cycle_end"
}) {
  return rzFetch<{ id: string; plan_id: string; status: string }>(
    `/subscriptions/${params.subscriptionId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        plan_id: params.planId,
        schedule_change_at: params.scheduleChangeAt,
      }),
    },
  )
}

/** Verify webhook signature using Web Crypto API (Deno-compatible) */
export async function verifyRazorpaySignature(body: string, signature: string): Promise<boolean> {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET
  if (!secret) throw new Error("RAZORPAY_WEBHOOK_SECRET not configured")

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  const expectedSignature = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

  return expectedSignature === signature
}

/** Verify payment signature using Web Crypto API (Deno-compatible) */
export async function verifyPaymentSignature(params: {
  orderId: string
  paymentId: string
  signature: string
}): Promise<boolean> {
  const secret = process.env.RAZORPAY_KEY_SECRET
  if (!secret) throw new Error("RAZORPAY_KEY_SECRET not configured")

  const data = `${params.orderId}|${params.paymentId}`
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))
  const expectedSignature = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

  return expectedSignature === params.signature
}

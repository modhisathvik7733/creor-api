const CASHFREE_SANDBOX = "https://sandbox.cashfree.com/pg"
const CASHFREE_PRODUCTION = "https://api.cashfree.com/pg"

function getBaseUrl(): string {
  return process.env.CASHFREE_ENV === "production" ? CASHFREE_PRODUCTION : CASHFREE_SANDBOX
}

function getHeaders(): Record<string, string> {
  const clientId = process.env.CASHFREE_CLIENT_ID
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error("Cashfree credentials not configured")
  return {
    "Content-Type": "application/json",
    "x-api-version": "2025-01-01",
    "x-client-id": clientId,
    "x-client-secret": clientSecret,
  }
}

async function cfFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...options,
    headers: {
      ...getHeaders(),
      ...(options.headers as Record<string, string>),
    },
  })

  const body = await res.json()

  if (!res.ok) {
    const errMsg = body?.message ?? body?.error ?? JSON.stringify(body)
    throw new Error(`Cashfree API error (${res.status}): ${errMsg}`)
  }

  return body as T
}

/** Create a one-time payment order */
export async function createCashfreeOrder(params: {
  orderId: string
  amount: number // in display currency units (decimal, e.g. 10.50)
  currency: string
  customerEmail: string
  customerPhone: string
  customerId: string
  returnUrl?: string
  notifyUrl?: string
  notes?: Record<string, string>
}) {
  return cfFetch<{
    cf_order_id: string
    order_id: string
    payment_session_id: string
    order_status: string
  }>("/orders", {
    method: "POST",
    body: JSON.stringify({
      order_id: params.orderId,
      order_amount: params.amount,
      order_currency: params.currency,
      customer_details: {
        customer_id: params.customerId,
        customer_email: params.customerEmail,
        customer_phone: params.customerPhone,
      },
      order_meta: {
        return_url: params.returnUrl ?? null,
        notify_url: params.notifyUrl ?? null,
      },
      order_tags: params.notes ?? {},
    }),
  })
}

/** Get order status (replaces client-side signature verification) */
export async function getCashfreeOrderStatus(orderId: string) {
  return cfFetch<{
    cf_order_id: string
    order_id: string
    order_status: "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED"
    order_amount: number
    order_currency: string
  }>(`/orders/${orderId}`)
}

/** Create a subscription plan */
export async function createCashfreePlan(params: {
  planId: string
  name: string
  amount: number // in display currency units (decimal)
  currency: string
  intervalType?: "MONTH" | "YEAR"
  intervals?: number
  maxCycles?: number
}) {
  return cfFetch<{
    plan_id: string
    plan_name: string
    plan_type: string
    plan_status: string
    plan_recurring_amount: number
  }>("/plans", {
    method: "POST",
    body: JSON.stringify({
      plan_id: params.planId,
      plan_name: params.name,
      plan_type: "PERIODIC",
      plan_currency: params.currency,
      plan_recurring_amount: params.amount,
      plan_max_amount: params.amount * 2, // allow some headroom
      plan_max_cycles: params.maxCycles ?? 120,
      plan_intervals: params.intervals ?? 1,
      plan_interval_type: params.intervalType ?? "MONTH",
    }),
  })
}

/**
 * Create a recurring subscription — charges full plan price upfront.
 *
 * Flow:
 * 1. Checkout collects payment via UPI/card and sets up auto-pay mandate
 * 2. authorization_amount = full plan price (kept, not refunded) — this IS the first month's payment
 * 3. subscription_first_charge_time = 1 month later — recurring charges start after the prepaid month
 *
 * payment_methods explicitly set to ["card", "upi"] so checkout shows both options.
 */
export async function createCashfreeSubscription(params: {
  subscriptionId: string
  planId: string
  customerEmail: string
  customerPhone: string
  planAmount: number // full plan price in display units (e.g. 23.99)
  returnUrl?: string
  currency?: string
  tags?: Record<string, string>
}) {
  // Charge the full plan price as the authorization amount (covers first month).
  // Explicitly list payment methods so checkout shows card + UPI options.
  // Valid values: "card" (standing instructions), "upi" (autopay), "enach", "pnach"
  const authDetails = {
    authorization_amount: params.planAmount,
    authorization_amount_refund: false,
    payment_methods: ["card", "upi"],
  }

  // First recurring charge = 1 month from now (upfront auth covers the first month).
  // Cap day-of-month to avoid overflow (e.g. Jan 31 → Feb 28, not Mar 3).
  const now = new Date()
  const nextMonth = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    Math.min(now.getUTCDate(), daysInMonth(now.getUTCFullYear(), now.getUTCMonth() + 1)),
    now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(),
  ))
  const firstChargeTime = nextMonth.toISOString()

  return cfFetch<{
    cf_subscription_id: string
    subscription_id: string
    subscription_status: string
    subscription_session_id: string
  }>("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      subscription_id: params.subscriptionId,
      customer_details: {
        customer_email: params.customerEmail,
        customer_phone: params.customerPhone,
      },
      plan_details: {
        plan_id: params.planId,
      },
      authorization_details: authDetails,
      subscription_first_charge_time: firstChargeTime,
      subscription_meta: {
        return_url: params.returnUrl ?? null,
      },
      subscription_tags: params.tags ?? {},
    }),
  })
}

/** Days in a given month (0-indexed month, e.g. 0=Jan, 11=Dec) */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/** Fetch a subscription's current status */
export async function fetchCashfreeSubscription(subscriptionId: string) {
  return cfFetch<{
    cf_subscription_id: string
    subscription_id: string
    subscription_status: string
    plan_details: { plan_id: string }
    subscription_tags: Record<string, string>
    next_schedule_date: string | null
    subscription_expiry_time: string | null
  }>(`/subscriptions/${subscriptionId}`)
}

/** Manage subscription: cancel, pause, activate, or change plan */
export async function manageCashfreeSubscription(params: {
  subscriptionId: string
  action: "CANCEL" | "PAUSE" | "ACTIVATE" | "CHANGE_PLAN"
  actionDetails?: { planId?: string }
}) {
  const body: Record<string, unknown> = {
    subscription_id: params.subscriptionId,
    action: params.action,
  }
  if (params.action === "CHANGE_PLAN" && params.actionDetails?.planId) {
    body.action_details = { plan_id: params.actionDetails.planId }
  }

  return cfFetch<{
    cf_subscription_id: string
    subscription_id: string
    subscription_status: string
  }>(`/subscriptions/${params.subscriptionId}/manage`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** Verify webhook signature using HMAC-SHA256 (timestamp + rawBody, Base64 encoded) */
export async function verifyCashfreeWebhookSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
): Promise<boolean> {
  const secret = process.env.CASHFREE_WEBHOOK_SECRET
  if (!secret) throw new Error("CASHFREE_WEBHOOK_SECRET not configured")

  const signedPayload = timestamp + rawBody
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload))
  const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(sig)))

  return expectedSignature === signature
}

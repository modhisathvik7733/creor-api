import Razorpay from "razorpay"
import crypto from "crypto"

let instance: Razorpay | null = null

function getRazorpay(): Razorpay {
  if (!instance) {
    instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    })
  }
  return instance
}

/** Create a one-time payment order */
export async function createRazorpayOrder(params: {
  amount: number // in paise
  currency: string
  receipt: string
  notes?: Record<string, string>
}) {
  const rz = getRazorpay()
  return rz.orders.create({
    amount: params.amount,
    currency: params.currency,
    receipt: params.receipt,
    notes: params.notes,
  })
}

/** Create a recurring subscription */
export async function createRazorpaySubscription(params: {
  planId: string
  totalCount: number
  notes?: Record<string, string>
}) {
  const rz = getRazorpay()
  return rz.subscriptions.create({
    plan_id: params.planId,
    total_count: params.totalCount,
    notes: params.notes,
  })
}

/** Cancel a subscription */
export async function cancelRazorpaySubscription(subscriptionId: string) {
  const rz = getRazorpay()
  return rz.subscriptions.cancel(subscriptionId)
}

/** Verify webhook signature */
export function verifyRazorpaySignature(body: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET!
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex")
  return expectedSignature === signature
}

/** Verify payment signature (for checkout validation) */
export function verifyPaymentSignature(params: {
  orderId: string
  paymentId: string
  signature: string
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET!
  const body = `${params.orderId}|${params.paymentId}`
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex")
  return expectedSignature === params.signature
}

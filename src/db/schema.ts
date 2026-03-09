import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  numeric,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core"
import { relations } from "drizzle-orm"

// ── Workspaces ──

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timeCreated: timestamp("time_created").defaultNow().notNull(),
  timeUpdated: timestamp("time_updated").defaultNow().notNull(),
  timeDeleted: timestamp("time_deleted"),
})

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  users: many(users),
  keys: many(keys),
  billing: many(billing),
}))

// ── Users ──

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
    authProvider: text("auth_provider", { enum: ["github", "google"] }).notNull(),
    authProviderId: text("auth_provider_id").notNull(),
    avatarUrl: text("avatar_url"),
    monthlyLimit: integer("monthly_limit"), // in USD (cents)
    monthlyUsage: bigint("monthly_usage", { mode: "number" }).default(0), // in micro-units
    timeMonthlyUsageUpdated: timestamp("time_monthly_usage_updated"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeUpdated: timestamp("time_updated").defaultNow().notNull(),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => [
    uniqueIndex("users_email_workspace_idx").on(table.email, table.workspaceId),
    index("users_auth_provider_idx").on(table.authProvider, table.authProviderId),
  ],
)

export const usersRelations = relations(users, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [users.workspaceId],
    references: [workspaces.id],
  }),
}))

// ── API Keys ──

export const keys = pgTable(
  "keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    key: text("key").notNull().unique(),
    timeUsed: timestamp("time_used"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => [index("keys_workspace_idx").on(table.workspaceId)],
)

export const keysRelations = relations(keys, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [keys.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [keys.userId],
    references: [users.id],
  }),
}))

// ── Billing ──

export const billing = pgTable("billing", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id)
    .unique(),
  balance: bigint("balance", { mode: "number" }).notNull().default(0), // micro-units (1 currency unit = 1,000,000)
  currency: text("currency").notNull().default("USD"),
  monthlyLimit: integer("monthly_limit"),
  monthlyUsage: bigint("monthly_usage", { mode: "number" }).default(0), // micro-units
  timeMonthlyReset: timestamp("time_monthly_reset").defaultNow(), // lazy reset at month boundary
  timeMonthlyUsageUpdated: timestamp("time_monthly_usage_updated"),
  lsCustomerId: text("ls_customer_id"),
  lsSubscriptionId: text("ls_subscription_id"),
  timeCreated: timestamp("time_created").defaultNow().notNull(),
  timeUpdated: timestamp("time_updated").defaultNow().notNull(),
})

export const billingRelations = relations(billing, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [billing.workspaceId],
    references: [workspaces.id],
  }),
}))

// ── Subscriptions (Creor Pro) ──

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    plan: text("plan", { enum: ["starter", "pro", "team"] }).notNull(),
    status: text("status", { enum: ["active", "past_due", "cancelled", "expired"] })
      .notNull()
      .default("active"),
    lsSubscriptionId: text("ls_subscription_id"),
    rollingUsage: bigint("rolling_usage", { mode: "number" }).default(0),
    fixedUsage: bigint("fixed_usage", { mode: "number" }).default(0),
    timeRollingUpdated: timestamp("time_rolling_updated"),
    timeFixedUpdated: timestamp("time_fixed_updated"),
    graceUntil: timestamp("grace_until"),
    pendingPlan: text("pending_plan"),
    pendingPlanEffectiveAt: timestamp("pending_plan_effective_at"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => [
    index("subscriptions_workspace_user_idx").on(table.workspaceId, table.userId),
  ],
)

// ── Usage Tracking ──

export const usage = pgTable(
  "usage",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").unique(), // idempotency key — prevents double-counting on retries
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    keyId: text("key_id").references(() => keys.id),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cost: bigint("cost", { mode: "number" }).notNull().default(0), // micro-units (workspace currency)
    costUsd: bigint("cost_usd", { mode: "number" }), // micro-units (always USD, for analytics)
    timeCreated: timestamp("time_created").defaultNow().notNull(),
  },
  (table) => [
    index("usage_workspace_idx").on(table.workspaceId),
    index("usage_time_idx").on(table.timeCreated),
    index("idx_usage_workspace_time").on(table.workspaceId, table.timeCreated),
  ],
)

// ── Billing Ledger (append-only audit trail for all balance changes) ──

export const billingLedger = pgTable(
  "billing_ledger",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    type: text("type", {
      enum: ["credit_purchase", "usage_deduction", "subscription_renewal", "refund", "adjustment", "onboarding"],
    }).notNull(),
    amountMicro: bigint("amount_micro", { mode: "number" }).notNull(), // positive = credit, negative = debit
    balanceAfterMicro: bigint("balance_after_micro", { mode: "number" }).notNull(),
    referenceId: text("reference_id"), // usage.id, payment.id, etc.
    metadata: jsonb("metadata"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
  },
  (table) => [
    index("idx_ledger_workspace_time").on(table.workspaceId, table.timeCreated),
  ],
)

export const billingLedgerRelations = relations(billingLedger, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [billingLedger.workspaceId],
    references: [workspaces.id],
  }),
}))

// ── Usage Daily Rollup (populated by pg_cron) ──

export const usageDaily = pgTable(
  "usage_daily",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    model: text("model").notNull(),
    day: timestamp("day", { mode: "date" }).notNull(),
    requestCount: integer("request_count").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costMicro: bigint("cost_micro", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    // Primary key is (workspace_id, model, day) — defined in SQL migration
  ],
)

// ── Model Visibility (per workspace) ──

export const modelSettings = pgTable(
  "model_settings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    model: text("model").notNull(),
    disabled: boolean("disabled").default(false),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("model_settings_workspace_model_idx").on(
      table.workspaceId,
      table.model,
    ),
  ],
)

// ── Provider Credentials (BYOK) ──

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    provider: text("provider").notNull(),
    credentials: text("credentials").notNull(), // encrypted API key
    timeCreated: timestamp("time_created").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("provider_credentials_workspace_provider_idx").on(
      table.workspaceId,
      table.provider,
    ),
  ],
)

// ── Session Shares ──

export const shares = pgTable("shares", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  secret: text("secret"),
  data: jsonb("data").notNull(), // session + messages + parts JSON
  timeCreated: timestamp("time_created").defaultNow().notNull(),
  timeDeleted: timestamp("time_deleted"),
})

// ── Webhook Events (idempotency) ──

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  timeCreated: timestamp("time_created").defaultNow().notNull(),
})

// ── Device Codes (IDE ↔ Web auth) ──

export const deviceCodes = pgTable(
  "device_codes",
  {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull().unique(),
    userCode: text("user_code").notNull(),
    status: text("status", { enum: ["pending", "approved", "completed"] })
      .notNull()
      .default("pending"),
    userId: text("user_id").references(() => users.id),
    workspaceId: text("workspace_id").references(() => workspaces.id),
    token: text("token"),
    expiresAt: timestamp("expires_at").notNull(),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("device_codes_user_code_idx").on(table.userCode),
  ],
)

// ── Model Catalog (server-driven pricing) ──

export const models = pgTable("models", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  inputCost: numeric("input_cost", { precision: 10, scale: 6 }).notNull(), // USD per 1K tokens
  outputCost: numeric("output_cost", { precision: 10, scale: 6 }).notNull(),
  contextWindow: integer("context_window").notNull().default(200000),
  maxOutput: integer("max_output"),
  capabilities: jsonb("capabilities").default([]),
  enabled: boolean("enabled").notNull().default(true),
  minPlan: text("min_plan").default("free"),
  sortOrder: integer("sort_order").default(0),
  timeCreated: timestamp("time_created").defaultNow().notNull(),
  timeUpdated: timestamp("time_updated").defaultNow().notNull(),
})

// ── Plan Catalog ──

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  prices: jsonb("prices").notNull().default({}), // {"USD": 999} smallest unit (cents)
  monthlyLimit: bigint("monthly_limit", { mode: "number" }), // micro-units (USD-equivalent)
  onboardingCredits: bigint("onboarding_credits", { mode: "number" }).default(0),
  features: jsonb("features").default([]),
  lsVariantId: text("ls_variant_id"), // Lemon Squeezy variant ID
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").default(0),
  timeCreated: timestamp("time_created").defaultNow().notNull(),
  timeUpdated: timestamp("time_updated").defaultNow().notNull(),
})

// ── System Config (key-value) ──

export const systemConfig = pgTable("system_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description"),
  timeUpdated: timestamp("time_updated").defaultNow().notNull(),
})

// ── Payments ──

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type", { enum: ["credits", "subscription", "onboarding", "refund"] }).notNull(),
    amountSmallest: integer("amount_smallest").notNull(), // cents/paise
    currency: text("currency").notNull().default("USD"),
    lsOrderId: text("ls_order_id"),
    lsSubscriptionPaymentId: text("ls_subscription_payment_id"),
    status: text("status", { enum: ["created", "captured", "failed", "refunded"] })
      .notNull()
      .default("created"),
    metadata: jsonb("metadata"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
  },
  (table) => [
    index("payments_workspace_idx").on(table.workspaceId),
    index("payments_ls_order_idx").on(table.lsOrderId),
  ],
)

export const paymentsRelations = relations(payments, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [payments.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [payments.userId],
    references: [users.id],
  }),
}))

// ── Invites ──

// ── Sessions (JWT revocation) ──

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    tokenHash: text("token_hash").notNull(),
    device: text("device"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeExpires: timestamp("time_expires").notNull(),
    timeRevoked: timestamp("time_revoked"),
  },
  (table) => [
    index("idx_sessions_user").on(table.userId),
    index("idx_sessions_token_hash").on(table.tokenHash),
  ],
)

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
  workspace: one(workspaces, {
    fields: [sessions.workspaceId],
    references: [workspaces.id],
  }),
}))

// ── Invites ──

export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeAccepted: timestamp("time_accepted"),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => [
    uniqueIndex("invites_workspace_email_idx").on(table.workspaceId, table.email),
  ],
)

// ── Audit Log ──

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id").references(() => users.id),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata").default({}),
    ipAddress: text("ip_address"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
  },
  (table) => [
    index("idx_audit_log_workspace_time").on(table.workspaceId, table.timeCreated),
  ],
)

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [auditLog.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [auditLog.userId],
    references: [users.id],
  }),
}))

// ── Projects ──

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    path: text("path"),
    repoUrl: text("repo_url"),
    description: text("description"),
    language: text("language"),
    branch: text("branch").default("main"),
    status: text("status").default("active"),
    sessionCount: integer("session_count").default(0),
    timeLastActive: timestamp("time_last_active"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeUpdated: timestamp("time_updated").defaultNow().notNull(),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => [
    index("idx_projects_workspace").on(table.workspaceId),
  ],
)

export const projectsRelations = relations(projects, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [projects.workspaceId],
    references: [workspaces.id],
  }),
}))

// ── MCP Catalog ──

export const mcpCatalog = pgTable("mcp_catalog", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  icon: text("icon"),
  author: text("author"),
  sourceUrl: text("source_url"),
  docsUrl: text("docs_url"),
  serverType: text("server_type").notNull(),
  configTemplate: jsonb("config_template").notNull(),
  configParams: jsonb("config_params").notNull().default([]),
  tags: jsonb("tags").default([]),
  featured: boolean("featured").default(false),
  verified: boolean("verified").default(false),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").default(0),
  installCount: integer("install_count").default(0),
  timeCreated: timestamp("time_created").defaultNow().notNull(),
  timeUpdated: timestamp("time_updated").defaultNow().notNull(),
})

// ── MCP Installations ──

export const mcpInstallations = pgTable(
  "mcp_installations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    catalogId: text("catalog_id")
      .notNull()
      .references(() => mcpCatalog.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    mcpName: text("mcp_name").notNull(),
    config: jsonb("config").notNull(),
    configValues: text("config_values"),
    enabled: boolean("enabled").notNull().default(true),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeUpdated: timestamp("time_updated").defaultNow().notNull(),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => [
    index("idx_mcp_installations_workspace").on(table.workspaceId),
  ],
)

export const mcpInstallationsRelations = relations(mcpInstallations, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [mcpInstallations.workspaceId],
    references: [workspaces.id],
  }),
  catalog: one(mcpCatalog, {
    fields: [mcpInstallations.catalogId],
    references: [mcpCatalog.id],
  }),
  user: one(users, {
    fields: [mcpInstallations.userId],
    references: [users.id],
  }),
}))

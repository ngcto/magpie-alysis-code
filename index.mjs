// Alysis Code for magpie.
//
// Alysis Code (alysiscode.com) is a desktop app that sells a credit-metered
// plan and serves it through its own OpenAI-compatible gateway. This plugin
// signs in the way the app does and hands magpie that gateway, so its models
// reach every agent and its credits reach magpie's quota display and Smart
// routing.
//
// Everything here follows AlysisAi/AlysisCode (Apache-2.0):
//   src/alysis_code/alysis_cloud.py      — the cloud, gateway and function URLs
//   src/alysis_code/account_login.py     — the device flow, /account-status and
//                                          its credit fields
//   src/alysis_code/llm/openai_compat.py — the headers a request carries
//   src/alysis_code/device_identity.py   — the per-installation id
//   src/alysis_code/model_registry.py    — the hosted catalog's capacities
//
// Sign-in is a device code approved on the website: no browser plumbing on this
// machine, so it works in a container. The key it returns (``slk_…``) is
// long-lived: the vendor issues no refresh token and no expiry, so there is
// nothing for the plugin to renew.

const PROVIDER_ID = "alysis-code"
const PROVIDER_NAME = "Alysis Code"

const DEFAULT_SITE = "https://alysiscode.com"
const DEFAULT_CLOUD = "https://vzigujbcjjmpntxhmyvr.supabase.co/functions/v1"

// The user agent the app's own requests carry (llm/openai_compat.py, chat).
const APP_USER_AGENT = "alysis-code/0.1.0"
// The app asks for an unencoded body, so a streamed reply is never held behind
// a compressor (llm/openai_compat.py: _DEFAULT_ACCEPT_ENCODING).
const APP_ACCEPT_ENCODING = "identity"

// Credits are ledger units: balance_microusd / 10_000 is "credits", 10_000
// being the vendor's own default ledger unit
// (account_login.py: ledger_microusd_per_base_credit).
const MICROUSD_PER_CREDIT = 10_000

const DEVICE_TIMEOUT_MS = 15 * 60 * 1000
const MODELS_TIMEOUT_MS = 10_000
const STATUS_TIMEOUT_MS = 10_000
const SIGN_IN_TIMEOUT_MS = 20_000

// The gateway serves three wire APIs from one base URL, and the app picks one by
// model id rather than by family (llm/factory.py:390-400): Responses for the
// OpenAI trio, Anthropic Messages for the two Claude ids, chat completions for
// everything else. The AI SDK package named on a model is what makes magpie
// speak that dialect, so it is part of each model rather than of the provider.
const CHAT = "@ai-sdk/openai-compatible"
const RESPONSES = "@ai-sdk/openai"
const MESSAGES = "@ai-sdk/anthropic"

// A reviewed snapshot of the hosted catalog's capacities, kept so magpie has
// models before anyone signs in and so a live model id carries the right
// window. The account's own listing decides membership; this only describes
// the models it names (src/alysis_code/model_registry.py). Reasoning levels are
// deliberately left out: the effort values differ per model
// (src/alysis_code/reasoning_contracts.py), and a wrong set breaks requests.
const CATALOG = {
  "gpt-6-luna": { name: "GPT-6 Luna", context: 1_050_000, output: 128_000, vision: true, wire: RESPONSES },
  "gpt-6.1-terra": { name: "GPT-6.1 Terra", context: 1_050_000, output: 128_000, vision: true, wire: RESPONSES },
  "gpt-6.1-sol": { name: "GPT-6.1 Sol", context: 1_050_000, output: 128_000, vision: true, wire: RESPONSES },
  "claude-sonnet-5-5": { name: "Claude Sonnet 5.5", context: 1_000_000, output: 128_000, vision: true, wire: MESSAGES },
  "claude-haiku-5-5": { name: "Claude Haiku 5.5", context: 1_000_000, output: 128_000, vision: true, wire: MESSAGES },
  "deepseek-flash": { name: "DeepSeek Flash", context: 1_048_576, output: 393_216, vision: true },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", context: 1_000_000, output: 384_000, vision: true },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", context: 1_048_576, output: 384_000, vision: true },
  "glm-5.3": { name: "GLM-5.3", context: 1_000_000, output: 16_384 },
  "glm-5.3-flash": { name: "GLM-5.3 Flash", context: 1_000_000, output: 131_072, vision: true },
  "minimax-m3": { name: "MiniMax M3", context: 524_288, output: 131_072 },
  "minimax-m3.1-flash": { name: "MiniMax M3.1 Flash", context: 1_000_000, output: 16_384 },
  "kimi-k3": { name: "Kimi K3", context: 1_000_000, output: 16_384, vision: true },
  "kimi-k3.1-pro": { name: "Kimi K3.1 Pro", context: 1_000_000, output: 16_384 },
  "qwen3.8-flash": { name: "Qwen3.8 Flash", context: 1_000_000, output: 16_384 },
  "qwen3.8-2.4t": { name: "Qwen3.8 2.4T", context: 1_000_000, output: 16_384 },
  "mistral-large-4": { name: "Mistral Large 4", context: 1_000_000, output: 131_072, vision: true },
  "mistral-small-4": { name: "Mistral Small 4", context: 256_000, output: 16_384 },
  "gemini-4-carbon": { name: "Gemini 4 Carbon", context: 1_000_000, output: 16_384 },
  "nemotron-3.5-super-vl": { name: "Nemotron 3.5 Super VL", context: 262_144, output: 16_384, vision: true },
  "reflection-beam": { name: "Reflection Beam", context: 1_000_000, output: 16_384, vision: true },
  "muse-spark-open": { name: "Muse Spark Open", context: 1_000_000, output: 16_384 },
  "gpt-oss-120b": { name: "GPT-OSS 120B", context: 131_072, output: 16_384 },
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
function trimUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "")
}

// Where this plugin talks to. The plugin's own options (plugins.json) win, then
// the vendor's own environment overrides, then the vendor's defaults — the
// order the app itself uses (alysis_cloud.py: cloud_api_url, gateway_base_url).
function endpoints(options) {
  const opted = trimUrl(options?.baseUrl ?? options?.cloudApiUrl)
  const env = typeof process !== "undefined" ? process.env : undefined
  const fromEnv = trimUrl(env?.ALYSIS_CLOUD_API_URL)
  const cloud = opted || fromEnv || DEFAULT_CLOUD
  const gateway =
    opted || fromEnv ? `${cloud}/llm/v1` : trimUrl(env?.ALYSIS_GATEWAY_URL) || `${cloud}/llm/v1`
  return {
    site: trimUrl(options?.siteUrl) || trimUrl(env?.ALYSIS_SITE_URL) || DEFAULT_SITE,
    cloud,
    gateway,
  }
}

// ---------------------------------------------------------------------------
// The app identity a request carries
// ---------------------------------------------------------------------------
// A recognized installation id: a version-4 UUID, which the vendor's own
// reader insists on (device_identity.py: _read_identity).
function newInstallationId() {
  return globalThis.crypto.randomUUID()
}

// The name the account's Devices page shows; the vendor caps it at 80
// characters (account_login.py: _client_identity). The suffix is this
// account's own installation id, so two accounts on one machine read as two
// devices rather than one device signing in twice.
function clientName(host, installationId) {
  const name = String(host || (typeof process !== "undefined" ? process.env?.HOSTNAME : "") || "").trim()
  const tag = String(installationId || "").slice(0, 6)
  const base = `alysis-cli @ ${name || "unknown-host"}`
  return (tag ? `${base} #${tag}` : base).slice(0, 80)
}

// The headers every request to the gateway or the account functions carries.
// The app sends exactly these and the gateway is strict about them, so they are
// built in one place: a provider call, a usage read and a model listing cannot
// drift apart.
function appHeaders(key, extra) {
  const headers = {
    "user-agent": APP_USER_AGENT,
    "accept-encoding": APP_ACCEPT_ENCODING,
  }
  if (key) headers.authorization = `Bearer ${key}`
  return { ...headers, ...extra }
}

// A fresh installation identity for one account: a new UUIDv4 and the name the
// account page shows beside it. Nothing else in the protocol is install-scoped
// (device_identity.py), so this is what keeps two accounts from looking linked.
function newIdentity(host) {
  const installationId = newInstallationId()
  return { installationId, clientName: clientName(host, installationId) }
}

// ---------------------------------------------------------------------------
// Sign-in state
// ---------------------------------------------------------------------------
// What magpie keeps of a sign-in that returns a key is the key and its
// metadata, nothing else (internal/plugin/host.js: save), so that is all an
// account's requests are built from. The installation id is a sign-in-only
// value: the vendor never reads it again (device_identity.py).
function accountState(auth) {
  if (!auth || typeof auth !== "object") return null
  const key = typeof auth.key === "string" ? auth.key.trim() : ""
  return key ? { key } : null
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function withTimeout(ms, signal) {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout
}

async function postJson(url, body, { key, headers, signal, timeout = SIGN_IN_TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: appHeaders(key, { "content-type": "application/json", ...headers }),
    body: JSON.stringify(body),
    signal: withTimeout(timeout, signal),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  return { status: res.status, ok: res.ok, body: parsed, text }
}

async function getJson(url, { key, headers, timeout } = {}) {
  const res = await fetch(url, {
    method: "GET",
    headers: appHeaders(key, { accept: "application/json", ...headers }),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  return { status: res.status, ok: res.ok, body: parsed, text }
}

function errorText(res, what) {
  const message = res.body?.error?.message ?? res.body?.error ?? res.body?.message
  if (typeof message === "string" && message.trim()) return `${what}: ${message.trim()}`
  const tail = String(res.text || "").trim().slice(0, 200)
  return `${what} answered HTTP ${res.status}${tail ? `: ${tail}` : ""}`
}

// ---------------------------------------------------------------------------
// Sign-in: the device flow
// ---------------------------------------------------------------------------
// POST device-code, approve the code on the website's /activate page, poll
// device-token until the key lands (alysis_cloud.py: device_code_url,
// device_token_url; account_login.py: _request_device_code, _poll_for_key).
async function startDeviceGrant(ctx, identity) {
  const res = await postJson(`${ctx.cloud}/device-code`, {
    client_name: identity.clientName,
    installation_id: identity.installationId,
  })
  if (!res.ok) throw new Error(errorText(res, "Starting the sign-in failed"))
  const deviceCode = String(res.body?.device_code || "").trim()
  const userCode = String(res.body?.user_code || "").trim()
  if (!deviceCode || !userCode) {
    throw new Error("The Alysis Code login service did not return a device code.")
  }
  return {
    deviceCode,
    userCode,
    // The page is always the site this plugin trusts, whatever the answer says,
    // so a misconfigured backend cannot send the person elsewhere
    // (account_login.py: _approval_url).
    url: `${ctx.site}/activate?code=${encodeURIComponent(userCode)}`,
    intervalMs: Math.max(Number(res.body?.interval) || 5, 0.05) * 1000,
    expiresInMs: Math.max(Number(res.body?.expires_in) || 900, 1) * 1000,
  }
}

async function pollDeviceKey(ctx, grant, { signal } = {}) {
  const interval = Math.min(grant.intervalMs, 5000)
  const deadline = Date.now() + Math.min(grant.expiresInMs, DEVICE_TIMEOUT_MS)
  for (;;) {
    if (signal?.aborted) throw new Error("The sign-in was given up.")
    const res = await postJson(
      `${ctx.cloud}/device-token`,
      { device_code: grant.deviceCode },
      { signal },
    )
    const status = String(res.body?.status || "").trim().toLowerCase()
    if (status === "approved") {
      const key = String(res.body?.key || "").trim()
      if (!key) throw new Error("The Alysis Code login service did not return a key.")
      return key
    }
    if (status === "denied") {
      throw new Error("The sign-in was rejected on the Alysis Code website.")
    }
    if (status === "expired" || status === "not_found" || status === "already_claimed") {
      throw new Error("This sign-in code expired. Sign in again.")
    }
    if (!res.ok && res.status !== 429) {
      throw new Error(errorText(res, "Waiting for the sign-in failed"))
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the sign-in to be approved. Sign in again.")
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

async function deviceSignIn(ctx, identity) {
  const grant = await startDeviceGrant(ctx, identity)
  return {
    url: grant.url,
    instructions: `Approve the code ${grant.userCode} on the Alysis Code website. magpie finishes on its own once you do.`,
    method: "auto",
    async callback(_code, { signal } = {}) {
      return completeSignIn(ctx, await pollDeviceKey(ctx, grant, { signal }))
    },
  }
}

// ---------------------------------------------------------------------------
// Finishing a sign-in
// ---------------------------------------------------------------------------
// The key is checked before it is kept, and the account's email goes in the
// metadata, which is what magpie names an account by (host.js: whoOf reads
// metadata.email). Signing in again on the same account then replaces that
// account instead of adding a second row for it.
async function completeSignIn(ctx, key) {
  const record = { type: "success", key }
  let email = ""
  try {
    const res = await getJson(`${ctx.cloud}/account-status`, {
      key,
      timeout: STATUS_TIMEOUT_MS,
    })
    if (res.ok && typeof res.body?.email === "string") email = res.body.email.trim()
  } catch {
    email = ""
  }
  if (email) record.metadata = { email }
  return record
}

// ---------------------------------------------------------------------------
// Allowance
// ---------------------------------------------------------------------------
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function credits(microusd) {
  const micro = numberOrNull(microusd)
  return micro === null ? null : micro / MICROUSD_PER_CREDIT
}

function creditText(value) {
  const n = numberOrNull(value)
  if (n === null) return ""
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 })
}

// The account's own summary of its plan, turned into magpie's windows
// (/account-status; account_login.py: _account_billing, _account_paid).
//
// Three windows, because three things stop an Alysis Code account: the rolling
// five-hour cap, the rolling weekly cap, and the credited period. The first two
// are rolling, and the vendor publishes no reset moment for them — so they
// carry their span and no resetsAt rather than an invented timestamp. The
// period is the window with a real reset (credits_reset_at on a paid plan,
// free_next_refill_at on the free tier), which is what Smart routing orders
// accounts by, and the remaining credits ride on it.
function usageFromStatus(payload) {
  const billing = payload?.billing
  if (!billing || typeof billing !== "object") {
    return { error: "The Alysis Code account page did not describe a plan.", windows: [] }
  }
  const paid = billing.paid && typeof billing.paid === "object" ? billing.paid : null
  const unlimited = billing.unlimited_credits === true
  const free = String(billing.tier || "") === "free"
  const windows = []

  if (unlimited) {
    // Set aside: nothing stops an unlimited account, so routing must not weigh
    // it ever closer to the edge.
    windows.push({ name: "Credits", display: "Unlimited credits", aside: true })
  }

  // The caps the plan enforces over the trailing five hours and week, per plan
  // (paid.cap_5h_microusd on a paid plan, billing.cap_5h_microusd otherwise).
  for (const [name, span, capKey, burnKey] of [
    ["5 hours", 5 * 3600, "cap_5h_microusd", "burn_5h_microusd"],
    ["7 days", 7 * 24 * 3600, "cap_7d_microusd", "burn_7d_microusd"],
  ]) {
    if (unlimited) break
    const cap = numberOrNull(paid?.[capKey] ?? billing[capKey])
    const burn = numberOrNull(paid?.[burnKey] ?? billing[burnKey])
    if (cap === null || cap <= 0 || burn === null) continue
    const amount = credits(burn)
    const limit = credits(cap)
    windows.push({
      name,
      used: Math.round((burn / cap) * 10000) / 100,
      span,
      amount,
      limit,
      unit: "credits",
      display: `${creditText(amount)} / ${creditText(limit)} credits`,
    })
  }

  const resetAt = resetMoment(billing, paid)
  if (!unlimited) {
    // The credited period: the grant on the free tier, the plan's monthly
    // credits otherwise, spent so far in this cycle.
    const limitMicro = numberOrNull(
      free ? billing.free_allowance_microusd : paid?.monthly_credits_microusd,
    )
    const burnMicro =
      numberOrNull(billing.cycle_burn_microusd) ?? numberOrNull(billing.month_burn_microusd)
    if (limitMicro !== null && limitMicro > 0) {
      const days = numberOrNull(paid?.credit_period_days) ?? 30
      const amount = credits(burnMicro)
      const limit = credits(limitMicro)
      windows.push({
        name: `${days} days`,
        ...(amount !== null && amount >= 0
          ? { used: Math.round((amount / limit) * 10000) / 100, amount }
          : {}),
        limit,
        unit: "credits",
        span: days * 24 * 3600,
        display: `${creditText(amount ?? 0)} / ${creditText(limit)} credits`,
        ...(resetAt ? { resetsAt: resetAt } : {}),
      })
    }

    // What is left to spend, in the same period. A wallet: routing reads it for
    // the credits left, and a wallet at nothing is an account at its cap.
    const leftMicro = numberOrNull(billing.balance_microusd)
    if (leftMicro !== null) {
      const balance = Math.max(credits(leftMicro), 0)
      windows.push({
        name: "Balance",
        balance,
        unit: "credits",
        display: `${creditText(balance)} credits left`,
        ...(resetAt ? { resetsAt: resetAt } : {}),
      })
    }
  }

  if (!windows.length) return { error: "The Alysis Code account reported no credits.", windows: [] }

  return {
    plan: paid?.plan_name || billing.tier || undefined,
    user: typeof payload.email === "string" ? payload.email : undefined,
    ...(resetAt ? { until: resetAt } : {}),
    renew: billing.cancel_at_period_end === true ? "off" : "auto",
    windows,
  }
}

// When the credited period renews, as the vendor states it: the plan's own
// reset first, then the subscription's end, then the free grant's refill.
function resetMoment(billing, paid) {
  const value =
    paid?.credits_reset_at ||
    billing.credits_reset_at ||
    billing.current_period_end ||
    billing.free_next_refill_at
  return typeof value === "string" && value.trim() ? value.trim() : ""
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
// A model's facts come from the snapshot whatever hook asks for it, but the two
// hooks spell a model differently and only one of them decides the wire.
function modelFacts(id) {
  const known = CATALOG[id] || {}
  return {
    name: known.name || id,
    context: known.context || 128_000,
    output: known.output || 32_768,
    vision: known.vision === true,
    wire: known.wire || CHAT,
  }
}

// The config hook's model, where OpenCode puts the dialect on the model's
// `provider`. This is the list magpie has before anyone signs in.
function configModel(id, gateway) {
  const facts = modelFacts(id)
  const model = {
    name: facts.name,
    limit: { context: facts.context, output: facts.output },
    reasoning: true,
    tool_call: true,
  }
  if (facts.vision) model.modalities = { input: ["text", "image"] }
  if (facts.wire !== CHAT) model.provider = { npm: facts.wire, api: gateway }
  return model
}

// The models hook's model, in OpenCode's Model shape, where the dialect is the
// model's own `api.npm`. This is the one that decides the wire: the host
// replaces the provider's models with what this hook returns
// (internal/plugin/host.js: out.models = …), so the dialect is read from
// `m.api.npm` (host.js) and lands in plugin.Model.NPM for the gateway's
// pluginProtocol switch (internal/provider/plugins.go). A dialect left only on
// the config hook is lost the moment an account signs in.
function accountModel(id, gateway) {
  const facts = modelFacts(id)
  return {
    id,
    name: facts.name,
    api: { id, npm: facts.wire, url: gateway },
    limit: { context: facts.context, output: facts.output },
    capabilities: {
      reasoning: true,
      toolcall: true,
      input: facts.vision ? { text: true, image: true } : { text: true },
    },
  }
}

function configModels(gateway) {
  const out = {}
  for (const id of Object.keys(CATALOG)) out[id] = configModel(id, gateway)
  return out
}

function accountModels(ids, gateway) {
  const out = {}
  for (const id of ids) out[id] = accountModel(id, gateway)
  return out
}

// The gateway's OpenAI-shaped listing: {"data": [{"id": …}]}
// (account_login.py: gateway_models).
function modelIds(body) {
  const rows = body?.data
  if (!Array.isArray(rows)) return null
  const ids = []
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : ""
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------
export default {
  id: "magpie-alysis-code",
  async server(_input, options) {
    const ctx = endpoints(options)
    const baseModels = configModels(ctx.gateway)

    return {
      config: async (config) => {
        config.provider ??= {}
        config.provider[PROVIDER_ID] ??= {
          name: PROVIDER_NAME,
          // Most hosted models speak chat completions; the catalog marks the
          // ones that don't on the model itself.
          npm: CHAT,
          api: ctx.gateway,
          models: baseModels,
        }
      },

      auth: {
        provider: PROVIDER_ID,
        methods: [
          {
            type: "oauth",
            label: `Sign in with ${PROVIDER_NAME}`,
            authorize: async () => deviceSignIn(ctx, newIdentity()),
          },
        ],

        // Every request of this account, carrying the app's own header set.
        async loader(getAuth) {
          const auth = await getAuth()
          const state = accountState(auth)
          if (!state) return {}
          return {
            baseURL: ctx.gateway,
            async fetch(url, init = {}) {
              const headers = new Headers(init.headers || {})
              for (const [name, value] of Object.entries(appHeaders(state.key, {}))) {
                headers.set(name, value)
              }
              if (!headers.has("content-type") && init.body != null) {
                headers.set("content-type", "application/json")
              }
              // The app never sends a key as x-api-key: the gateway ignores
              // that header and answers as if anonymous, so a request carrying
              // it reads as signed out. Anthropic's AI SDK package adds it on
              // the Messages route; it is dropped again here.
              headers.delete("x-api-key")
              // The two Claude models are served on Anthropic Messages, which
              // wants its version pin (anthropic_messages.py:78).
              if (String(url).includes("/messages")) headers.set("anthropic-version", "2023-06-01")
              return fetch(url, { ...init, headers })
            },
          }
        },

        // The credits allowance: what magpie shows, and what Smart routing weighs.
        async usage(getAuth) {
          const state = accountState(await getAuth())
          if (!state) return { error: "No Alysis Code sign-in on this account.", windows: [] }
          let res
          try {
            res = await getJson(`${ctx.cloud}/account-status`, {
              key: state.key,
              timeout: STATUS_TIMEOUT_MS,
            })
          } catch (error) {
            return {
              error: `Could not read the Alysis Code allowance: ${error.message}`,
              windows: [],
            }
          }
          // 401 is the vendor's invalid_key, and the only answer that means the
          // sign-in is dead (account_login.py:513-521). Anything else is read as
          // the account page's own trouble, so the account is not marked for it.
          if (res.status === 401) {
            return { error: "The Alysis Code sign-in was refused. Sign in again.", windows: [] }
          }
          if (!res.ok) {
            return { error: `The Alysis Code account page answered HTTP ${res.status}.`, windows: [] }
          }
          if (res.body?.schema_version !== 1) {
            return {
              error: "The Alysis Code account page answered in a shape this plugin doesn't know.",
              windows: [],
            }
          }
          return usageFromStatus(res.body)
        },
      },

      provider: {
        id: PROVIDER_ID,
        // The models this account may use, from the gateway's own listing.
        // magpie keeps the list it had when this can't be read.
        async models(provider, { auth } = {}) {
          const state = accountState(auth)
          if (!state) return provider.models
          let res
          try {
            res = await getJson(`${ctx.gateway}/models`, {
              key: state.key,
              timeout: MODELS_TIMEOUT_MS,
            })
          } catch {
            return provider.models
          }
          if (!res.ok) return provider.models
          const ids = modelIds(res.body)
          if (!ids || !ids.length) return provider.models
          return accountModels(ids, ctx.gateway)
        },
      },
    }
  },
}

// What the tests drive. magpie calls nothing here.
export const _internal = {
  PROVIDER_ID,
  CATALOG,
  MICROUSD_PER_CREDIT,
  APP_USER_AGENT,
  APP_ACCEPT_ENCODING,
  endpoints,
  newInstallationId,
  newIdentity,
  clientName,
  appHeaders,
  accountState,
  usageFromStatus,
  modelIds,
  configModel,
  accountModel,
  configModels,
  accountModels,
}

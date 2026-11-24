// The credits allowance magpie shows and Smart routing weighs. Three things
// stop an Alysis Code account: the rolling five-hour cap, the rolling weekly
// cap, and the credited period. Only the period has a reset the vendor states,
// so that is the window routing can order by.
import { afterEach, expect, test } from "bun:test"

import plugin, { _internal } from "../index.mjs"
import { freeBilling, paidBilling, startMock } from "./mock-server.mjs"

let mock
afterEach(() => mock?.close())

const unchanged = (billing) => _internal.usageFromStatus({ billing, email: "ada@example.com" })
const named = (usage) => Object.fromEntries(usage.windows.map((w) => [w.name, w]))

test("a paid plan reports its five hours, its week, its period and what is left", () => {
  const usage = unchanged(paidBilling())

  expect(usage.plan).toBe("Pro")
  expect(usage.user).toBe("ada@example.com")
  expect(usage.renew).toBe("auto")
  // The plan's own reset, not the subscription's end.
  expect(usage.until).toBe("2026-11-28T09:00:00Z")

  const windows = named(usage)
  // 370 000 of 1 000 000 micro-dollars inside the five-hour cap.
  expect(windows["5 hours"]).toMatchObject({ used: 37, span: 18_000, amount: 37, limit: 100, unit: "credits" })
  expect(windows["5 hours"].display).toBe("37 / 100 credits")
  // 2 000 000 of 8 000 000 over the week.
  expect(windows["7 days"]).toMatchObject({ used: 25, span: 604_800, amount: 200, limit: 800 })
  // 1 200 of the period's 6 000 credits, with the reset routing reads.
  expect(windows["30 days"]).toMatchObject({
    used: 20,
    amount: 1_200,
    limit: 6_000,
    span: 2_592_000,
    resetsAt: "2026-11-28T09:00:00Z",
  })
  expect(windows["30 days"].display).toBe("1,200 / 6,000 credits")
  // 12 400 000 micro-dollars is 1 240 credits left — a wallet, with no share.
  expect(windows.Balance).toMatchObject({ balance: 1_240, unit: "credits", resetsAt: "2026-11-28T09:00:00Z" })
  expect(windows.Balance.used).toBeUndefined()
  expect(windows.Balance.display).toBe("1,240 credits left")
})

test("a rolling cap carries its span and no invented reset", () => {
  // The vendor publishes no reset moment for a rolling window, so neither do
  // we: routing weighs the share, and by a reset it cannot name it ranks after
  // an account whose reset it can.
  const windows = named(unchanged(paidBilling()))
  expect(windows["5 hours"].resetsAt).toBeUndefined()
  expect(windows["5 hours"].resetSecs).toBeUndefined()
  expect(windows["7 days"].resetsAt).toBeUndefined()
  // The period is the only window with one.
  expect(windows["30 days"].resetsAt).toBe("2026-11-28T09:00:00Z")
})

test("the free tier's grant is its period, refilled on the vendor's schedule", () => {
  const usage = unchanged(freeBilling())
  expect(usage.plan).toBe("free")
  expect(usage.until).toBe("2026-12-05T00:00:00Z")

  const windows = named(usage)
  // 10 credits a rolling five hours, 20 a rolling week.
  expect(windows["5 hours"]).toMatchObject({ used: 60, amount: 6, limit: 10 })
  expect(windows["7 days"]).toMatchObject({ used: 60, amount: 12, limit: 20 })
  // 50 credits a 30-day grant, 18.5 spent, refilled on the vendor's date.
  expect(windows["30 days"]).toMatchObject({ used: 37, amount: 18.5, limit: 50, resetsAt: "2026-12-05T00:00:00Z" })
  expect(windows.Balance).toMatchObject({ balance: 31.5, resetsAt: "2026-12-05T00:00:00Z" })
  expect(windows.Balance.display).toBe("31.5 credits left")
})

test("a paid plan's own reset wins over the subscription's end", () => {
  const usage = unchanged(
    paidBilling({
      current_period_end: "2026-12-31T00:00:00Z",
      credits_reset_at: "2026-11-28T09:00:00Z",
      paid: { ...paidBilling().paid, credits_reset_at: "2026-11-20T00:00:00Z" },
    }),
  )
  expect(named(usage)["30 days"].resetsAt).toBe("2026-11-20T00:00:00Z")
  expect(usage.until).toBe("2026-11-20T00:00:00Z")
})

test("with no stated reset the period keeps its share and says nothing of a reset", () => {
  const usage = unchanged(
    freeBilling({ free_next_refill_at: null, current_period_end: null, credits_reset_at: null }),
  )
  expect(named(usage)["30 days"].resetsAt).toBeUndefined()
  expect(usage.until).toBeUndefined()
})

test("unlimited credits say so and stay out of routing", () => {
  const usage = unchanged(
    paidBilling({ balance_microusd: null, unlimited_credits: true, paid: null }),
  )
  // Set aside: using one up never stops an unlimited account, so routing leaves
  // it alone whatever it says (internal/provider/plugin_usage.go: aside).
  expect(usage.windows).toEqual([{ name: "Credits", display: "Unlimited credits", aside: true }])
})

test("a cancelled plan renews off", () => {
  expect(unchanged(paidBilling({ cancel_at_period_end: true })).renew).toBe("off")
})

test("a plan that reports nothing is an error, never an invented zero", () => {
  expect(
    unchanged(
      paidBilling({
        balance_microusd: null,
        cap_5h_microusd: 0,
        cap_7d_microusd: 0,
        cycle_burn_microusd: 0,
        month_burn_microusd: 0,
        paid: { plan: "plan_15", plan_name: "Pro", monthly_credits_microusd: 0 },
      }),
    ),
  ).toEqual({ error: "The Alysis Code account reported no credits.", windows: [] })
  expect(_internal.usageFromStatus({})).toMatchObject({ windows: [] })
  expect(_internal.usageFromStatus({ billing: null })).toMatchObject({ windows: [] })
})

test("a cap the vendor doesn't state is left out, not sent as zero", () => {
  const usage = unchanged(
    paidBilling({ cap_5h_microusd: 0, burn_5h_microusd: 0, cap_7d_microusd: null, burn_7d_microusd: null }),
  )
  expect(usage.windows.map((w) => w.name)).toEqual(["30 days", "Balance"])
})

test("an overdrawn balance is a wallet at nothing, not a negative", () => {
  expect(named(unchanged(paidBilling({ balance_microusd: -50_000 }))).Balance.balance).toBe(0)
})

test("the usage hook reads the account page with the account's key", async () => {
  mock = startMock()
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })
  const usage = await hooks.auth.usage(async () => ({ type: "api", key: "slk_test_key" }))

  expect(usage.plan).toBe("Pro")
  const [call] = mock.requests("/account-status")
  expect(call.method).toBe("GET")
  expect(call.headers.authorization).toBe("Bearer slk_test_key")
  expect(call.headers.accept).toBe("application/json")
  expect(call.headers["user-agent"]).toBe("alysis-code/0.1.0")
})

test("a refused sign-in and a broken account page are told apart", async () => {
  mock = startMock()
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })
  // 401 is the vendor's invalid_key: the account must sign in again.
  expect(await hooks.auth.usage(async () => ({ type: "api", key: "slk_revoked" }))).toMatchObject({
    error: "The Alysis Code sign-in was refused. Sign in again.",
  })

  // Anything else is the account page's own trouble, and must not mark the
  // account dead (the plugin's fetch answers model refusals with 403/404, which
  // magpie must read as the model refusing, not the sign-in failing).
  mock.state.statusCode = 502
  expect(await hooks.auth.usage(async () => ({ type: "api", key: "slk_test_key" }))).toMatchObject({
    error: "The Alysis Code account page answered HTTP 502.",
  })

  mock.state.statusCode = 200
  mock.state.schemaVersion = 2
  expect(await hooks.auth.usage(async () => ({ type: "api", key: "slk_test_key" }))).toMatchObject({
    error: "The Alysis Code account page answered in a shape this plugin doesn't know.",
  })
})

test("an unreachable account page is an error on the card, not a crash", async () => {
  mock = startMock()
  mock.close()
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })
  const usage = await hooks.auth.usage(async () => ({ type: "api", key: "slk_test_key" }))
  expect(usage.error).toContain("Could not read the Alysis Code allowance")
  expect(usage.windows).toEqual([])
})

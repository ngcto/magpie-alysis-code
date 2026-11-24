// Signing in with a device code: magpie shows the website and the code, then
// the callback polls until the key lands.
import { afterEach, expect, test } from "bun:test"

import plugin from "../index.mjs"
import { startMock } from "./mock-server.mjs"

let mock
afterEach(() => mock?.close())

async function hooksFor(plan) {
  mock = startMock(plan)
  return plugin.server({}, { baseUrl: mock.baseUrl })
}

test("the device code is the only way in", async () => {
  const hooks = await plugin.server({}, undefined)
  const methods = hooks.auth.methods
  expect(methods).toHaveLength(1)
  expect(methods[0].type).toBe("oauth")
  expect(methods[0].label).toBe("Sign in with Alysis Code")
})

test("the device sign-in shows the activation page and waits on its own", async () => {
  const hooks = await hooksFor({ pendingPolls: ["pending", "pending", "approved"] })

  const started = await hooks.auth.methods[0].authorize()
  expect(started.method).toBe("auto")
  // The page is always the vendor site, never a URL the backend hands over
  // (account_login.py: _approval_url).
  expect(started.url).toBe("https://alysiscode.com/activate?code=WXYZ-1234")
  expect(started.instructions).toContain("WXYZ-1234")

  const record = await started.callback()
  expect(record.type).toBe("success")
  expect(record.key).toBe("slk_test_key")
  // magpie keeps a key sign-in as {type, key, metadata} and nothing else
  // (internal/plugin/host.js: save), and names the account by metadata.email —
  // so the email goes there, and signing in again replaces the same account
  // instead of adding a second one.
  expect(record.metadata).toEqual({ email: "ada@example.com" })
  expect(mock.state.polls).toBe(3)
})

test("the device request carries what the app sends", async () => {
  const hooks = await hooksFor({ pendingPolls: [] })
  await (await hooks.auth.methods[0].authorize()).callback()

  const [grant] = mock.requests("/device-code")
  expect(grant.method).toBe("POST")
  expect(Object.keys(grant.body).sort()).toEqual(["client_name", "installation_id"])
  expect(grant.body.client_name.startsWith("alysis-cli @ ")).toBe(true)

  const [poll] = mock.requests("/device-token")
  expect(poll.body).toEqual({ device_code: "dev_1" })
})

test("a rejected, expired or unreachable sign-in says why", async () => {
  const denied = await hooksFor({ deviceStatus: "denied" })
  await expect((await denied.auth.methods[0].authorize()).callback()).rejects.toThrow(
    /rejected/,
  )
  mock.close()

  const expired = await hooksFor({ deviceStatus: "expired" })
  await expect((await expired.auth.methods[0].authorize()).callback()).rejects.toThrow(
    /expired/,
  )
  mock.close()

  const gone = await hooksFor({ deviceStatus: "not_found" })
  await expect((await gone.auth.methods[0].authorize()).callback()).rejects.toThrow(/expired/)
})

test("a sign-in that is given up stops polling", async () => {
  const hooks = await hooksFor({ pendingPolls: Array(200).fill("pending") })
  const started = await hooks.auth.methods[0].authorize()
  const controller = new AbortController()
  controller.abort()
  await expect(started.callback(undefined, { signal: controller.signal })).rejects.toThrow(
    /given up/,
  )
  expect(mock.state.polls).toBe(0)
})

test("a login service that is down fails the sign-in, not the plugin", async () => {
  mock = startMock({})
  mock.close()
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })
  await expect(hooks.auth.methods[0].authorize()).rejects.toThrow()
})

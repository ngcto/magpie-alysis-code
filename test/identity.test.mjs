// The identity a request carries: the app's own headers, and an installation
// id that is fresh per account so two accounts never look like one device.
import { afterEach, expect, test } from "bun:test"

import plugin, { _internal } from "../index.mjs"
import { startMock } from "./mock-server.mjs"

let mock
afterEach(() => mock?.close())

// The vendor's own reader insists on a version-4 UUID and nothing else
// (src/alysis_code/device_identity.py: _read_identity).
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test("an installation id is a version-4 UUID, the only shape the vendor reads", () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) {
    const id = _internal.newInstallationId()
    expect(id).toMatch(V4)
    seen.add(id)
  }
  expect(seen.size).toBe(200)
})

test("two sign-ins never share an identity", async () => {
  mock = startMock({ pendingPolls: [] })
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })

  const first = await hooks.auth.methods[0].authorize()
  await first.callback()
  const second = await hooks.auth.methods[0].authorize()
  await second.callback()

  const ids = mock.requests("/device-code").map((r) => r.body.installation_id)
  expect(ids).toHaveLength(2)
  expect(ids[0]).not.toBe(ids[1])
  for (const id of ids) expect(id).toMatch(V4)
})

test("the client name is the app's own, capped at eighty characters, one per account", () => {
  expect(_internal.clientName("mac-studio", "abcdef12-3456-4000-8000-000000000000")).toBe(
    "alysis-cli @ mac-studio #abcdef",
  )
  expect(_internal.clientName("x".repeat(200), "abcdef12").length).toBe(80)
  expect(_internal.clientName("", "abcdef12").startsWith("alysis-cli @ ")).toBe(true)

  // Two accounts on one machine are two devices on the vendor's page.
  const first = _internal.newIdentity("mac-studio")
  const second = _internal.newIdentity("mac-studio")
  expect(first.clientName).not.toBe(second.clientName)
  expect(first.installationId).not.toBe(second.installationId)
})

test("every account request carries the same strict header set", async () => {
  mock = startMock({ pendingPolls: [] })
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })

  const started = await hooks.auth.methods[0].authorize()
  const record = await started.callback()

  // A provider request, through the loader magpie builds for the account.
  const loader = await hooks.auth.loader(async () => record)
  await loader.fetch(`${mock.baseUrl}/llm/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-caller-agent": "claude" },
    body: JSON.stringify({ model: "gpt-6-luna", messages: [] }),
  })
  await hooks.auth.usage(async () => record)
  await hooks.provider.models(
    { models: {} },
    { auth: record },
  )

  const sent = mock
    .requests()
    .filter((r) => r.path.endsWith("/chat/completions"))
    .at(-1)
  expect(sent.headers["user-agent"]).toBe("alysis-code/0.1.0")
  expect(sent.headers["accept-encoding"]).toBe("identity")
  expect(sent.headers.authorization).toBe("Bearer slk_test_key")
  expect(sent.headers["content-type"]).toBe("application/json")

  // The identity the app sends is not invented or dropped on the other calls.
  for (const call of [mock.requests("/account-status").at(-1), mock.requests("/llm/v1/models").at(-1)]) {
    expect(call.headers["user-agent"]).toBe("alysis-code/0.1.0")
    expect(call.headers["accept-encoding"]).toBe("identity")
    expect(call.headers.authorization).toBe("Bearer slk_test_key")
  }
})

test("the loader never lets a caller's headers replace the app identity", async () => {
  mock = startMock({ pendingPolls: [] })
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })
  const started = await hooks.auth.methods[0].authorize()
  const record = await started.callback()

  const loader = await hooks.auth.loader(async () => record)
  const answer = await loader.fetch(`${mock.baseUrl}/llm/v1/chat/completions`, {
    method: "POST",
    headers: { "user-agent": "curl/8", "accept-encoding": "gzip", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-luna", messages: [{ role: "user", content: "ping" }] }),
  })
  expect(answer.status).toBe(200)
  expect(await answer.json()).toMatchObject({ choices: [{ message: { content: "pong" } }] })

  const sent = mock.requests("/chat/completions").at(-1)
  expect(sent.headers["user-agent"]).toBe("alysis-code/0.1.0")
  expect(sent.headers["accept-encoding"]).toBe("identity")
})

test("a key the AI SDK would put in x-api-key is dropped, never sent", async () => {
  mock = startMock({ pendingPolls: [] })
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })
  const record = await (await hooks.auth.methods[0].authorize()).callback()
  const loader = await hooks.auth.loader(async () => record)

  await loader.fetch(`${mock.baseUrl}/llm/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "slk_test_key" },
    body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
  })
  const sent = mock.requests("/chat/completions").at(-1)
  // The gateway ignores x-api-key and reads such a request as anonymous, so it
  // must not travel at all: the key goes in Authorization, as the app sends it.
  expect(sent.headers["x-api-key"]).toBeUndefined()
  expect(sent.headers.authorization).toBe("Bearer slk_test_key")
})

test("an account with no key gets no loader and no usage", async () => {
  const hooks = await plugin.server({}, undefined)
  expect(await hooks.auth.loader(async () => null)).toEqual({})
  expect(await hooks.auth.usage(async () => ({ type: "oauth" }))).toMatchObject({
    windows: [],
  })
  expect(await hooks.provider.models({ models: { keep: 1 } }, { auth: null })).toEqual({ keep: 1 })
})

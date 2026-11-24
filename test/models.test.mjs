// The models one account has: the gateway's own listing decides which, the
// plugin's snapshot gives each its window.
import { afterEach, expect, test } from "bun:test"

import plugin, { _internal } from "../index.mjs"
import { startMock } from "./mock-server.mjs"

let mock
afterEach(() => mock?.close())

const account = { type: "api", key: "slk_test_key" }

test("the gateway's listing is the account's model list", async () => {
  mock = startMock({ models: ["gpt-6-luna", "deepseek-flash", "some-new-model"] })
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })
  const models = await hooks.provider.models({ models: {} }, { auth: account })

  expect(Object.keys(models)).toEqual(["gpt-6-luna", "deepseek-flash", "some-new-model"])
  // OpenCode's Model shape: the dialect on api.npm and the capabilities where
  // magpie reads them, because this return replaces the provider's models.
  expect(models["gpt-6-luna"]).toMatchObject({
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    api: { id: "gpt-6-luna", npm: "@ai-sdk/openai", url: `${mock.baseUrl}/llm/v1` },
    limit: { context: 1_050_000, output: 128_000 },
    capabilities: { reasoning: true, toolcall: true, input: { text: true, image: true } },
  })
  expect(models["deepseek-flash"].api.npm).toBe("@ai-sdk/openai-compatible")
  // A model the snapshot doesn't describe still works, with a conservative
  // window, on the default dialect.
  expect(models["some-new-model"]).toMatchObject({
    name: "some-new-model",
    api: { npm: "@ai-sdk/openai-compatible" },
    limit: { context: 128_000, output: 32_768 },
    capabilities: { input: { text: true } },
  })

  const [call] = mock.requests("/llm/v1/models")
  expect(call.method).toBe("GET")
  expect(call.headers.authorization).toBe("Bearer slk_test_key")
  expect(call.headers["user-agent"]).toBe("alysis-code/0.1.0")
})

test("a listing magpie can't read keeps the list it had", async () => {
  mock = startMock({ models: [] })
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })
  const kept = { models: { "gpt-6-luna": { name: "kept" } } }
  expect(await hooks.provider.models(kept, { auth: account })).toBe(kept.models)

  mock.state.models = ["gpt-6-luna"]
  mock.state.statusCode = 200
  // A body that isn't the OpenAI shape is a failed read too.
  const notAList = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => new Response(JSON.stringify({ nope: true }), { headers: { "content-type": "application/json" } }),
  })
  const other = await plugin.server({}, { baseUrl: `http://127.0.0.1:${notAList.port}/functions/v1` })
  expect(await other.provider.models(kept, { auth: account })).toBe(kept.models)
  notAList.stop(true)
})

test("an unreachable gateway keeps the list it had", async () => {
  mock = startMock()
  mock.close()
  const hooks = await plugin.server({}, { baseUrl: mock.baseUrl })
  const kept = { models: { keep: {} } }
  expect(await hooks.provider.models(kept, { auth: account })).toBe(kept.models)
})

test("a duplicate id in the listing is listed once", () => {
  expect(_internal.modelIds({ data: [{ id: "a" }, { id: "a" }, { id: " b " }, { id: 3 }] })).toEqual([
    "a",
    "b",
  ])
  expect(_internal.modelIds({})).toBeNull()
  expect(_internal.modelIds(null)).toBeNull()
})

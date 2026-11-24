// The provider the plugin declares, and the package magpie reads around it.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import plugin, { _internal } from "../index.mjs"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

test("the package is named and declared for magpie", () => {
  expect(pkg.name).toBe("magpie-alysis-code")
  expect(pkg.type).toBe("module")
  expect(pkg.main).toBe("./index.mjs")
  expect(pkg.keywords).toContain("magpie")
  expect(pkg.license).toBe("MIT")
  // magpie gives each provider of the plugin the package's picture when the
  // provider gives none of its own (internal/provider/plugin_icon.go).
  expect(pkg.magpie.icon).toBe("https://alysiscode.com/black-logo.png")
  expect(pkg.magpie.name).toBe("Alysis Code")
  expect(pkg.magpie.maxConcurrency).toBeGreaterThan(0)
})

test("the provider is declared with the id Ng asked for", async () => {
  const hooks = await plugin.server({}, undefined)
  expect(hooks.auth.provider).toBe("alysis-code")

  const config = {}
  await hooks.config(config)
  const provider = config.provider["alysis-code"]
  expect(provider.name).toBe("Alysis Code")
  // The hosted gateway is an OpenAI-compatible chat-completions endpoint
  // (src/alysis_code/alysis_cloud.py: gateway_base_url).
  expect(provider.npm).toBe("@ai-sdk/openai-compatible")
  expect(provider.api).toBe("https://vzigujbcjjmpntxhmyvr.supabase.co/functions/v1/llm/v1")
})

test("a provider the user configured already is left alone", async () => {
  const hooks = await plugin.server({}, undefined)
  const config = { provider: { "alysis-code": { name: "mine" } } }
  await hooks.config(config)
  expect(config.provider["alysis-code"]).toEqual({ name: "mine" })
})

test("every declared model carries a window and what it can do", async () => {
  const hooks = await plugin.server({}, undefined)
  const config = {}
  await hooks.config(config)
  const models = config.provider["alysis-code"].models
  expect(Object.keys(models).length).toBeGreaterThanOrEqual(20)

  for (const [id, model] of Object.entries(models)) {
    expect(model.name).toBeTruthy()
    expect(model.limit.context).toBeGreaterThan(0)
    expect(model.limit.output).toBeGreaterThan(0)
    expect(model.tool_call).toBe(true)
    expect(model.reasoning).toBe(true)
    // No effort levels: the vendor's values differ per model, and a set it
    // doesn't take breaks requests (src/alysis_code/reasoning_contracts.py).
    expect(model.variants).toBeUndefined()
    expect(id in _internal.CATALOG).toBe(true)
  }

  expect(models["gpt-6-luna"].modalities.input).toContain("image")
  expect(models["deepseek-flash"].limit.context).toBe(1_048_576)
  expect(models["glm-5.3"].modalities).toBeUndefined()
})

test("each model speaks the dialect the gateway serves it on", () => {
  // The gateway is one base URL over three wire APIs, and the app picks one by
  // model id (src/alysis_code/llm/factory.py:390-400). magpie chooses by the AI
  // SDK package named on the model.
  const usage = (id) => _internal.modelEntry(id, "https://gateway.test/llm/v1").provider

  for (const id of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra"]) {
    expect(usage(id)).toEqual({ npm: "@ai-sdk/openai", api: "https://gateway.test/llm/v1" })
  }
  for (const id of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
    expect(usage(id)).toEqual({ npm: "@ai-sdk/anthropic", api: "https://gateway.test/llm/v1" })
  }
  // Everything else is chat completions, which the provider already declares.
  for (const id of ["deepseek-flash", "glm-5.3-flash", "kimi-k3", "gemini-4-carbon"]) {
    expect(usage(id)).toBeUndefined()
  }
})

test("the gateway's own base can be pointed elsewhere for a staging deployment", () => {
  expect(_internal.endpoints({ baseUrl: "http://127.0.0.1:9/functions/v1/" })).toEqual({
    site: "https://alysiscode.com",
    cloud: "http://127.0.0.1:9/functions/v1",
    gateway: "http://127.0.0.1:9/functions/v1/llm/v1",
  })
})

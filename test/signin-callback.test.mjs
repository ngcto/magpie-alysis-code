// Signing in through the website's /connect page, when the browser can't
// reach this computer: the user pastes the callback URL back.
import { afterEach, expect, test } from "bun:test"

import plugin, { _internal } from "../index.mjs"
import { startMock } from "./mock-server.mjs"

let mock
afterEach(() => mock?.close())

async function hooksFor(plan) {
  mock = startMock(plan)
  return plugin.server({}, { baseUrl: mock.baseUrl })
}

test("a pasted callback URL, a bare code or a full address bar all yield the code", () => {
  const code = "one_time_code_from_the_browser"
  expect(_internal.pastedCode(`http://127.0.0.1:52143/callback?code=${code}&state=abc`)).toBe(code)
  expect(_internal.pastedCode(`http://127.0.0.1:52143/callback?state=abc&code=${code}`)).toBe(code)
  expect(_internal.pastedCode(`  ${code}  `)).toBe(code)
  expect(_internal.pastedCode(`?code=${code}`)).toBe(code)
  // A code that is percent-encoded is decoded once, and nothing else is.
  expect(_internal.pastedCode("http://127.0.0.1/callback?code=a%41b")).toBe("aAb")
  expect(_internal.pastedCode("")).toBe("")
  expect(_internal.pastedCode(undefined)).toBe("")
})

test("the PKCE pair is the shape RFC 7636 asks for", () => {
  for (let i = 0; i < 20; i++) {
    const { verifier, challenge } = _internal.pkcePair()
    expect(verifier).toHaveLength(64)
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/)
    expect(challenge).toBe(_internal.s256(verifier))
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/)
  }
  // The published test vector (RFC 7636 appendix B).
  expect(_internal.s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  )
})

test("the website sign-in names a session and asks for the code", async () => {
  const hooks = await hooksFor({})
  const started = await hooks.auth.methods[1].authorize()

  expect(started.method).toBe("code")
  expect(started.url.startsWith("https://alysiscode.com/connect?session=")).toBe(true)
  expect(started.instructions.toLowerCase()).toContain("callback url")

  const record = await started.callback("http://127.0.0.1:52143/callback?code=one_time_code_from_the_browser&state=abc")
  expect(record.key).toBe("slk_test_key")
  expect(record.metadata).toEqual({ email: "ada@example.com" })
})

test("the start carries a challenge that matches the verifier redeemed", async () => {
  const hooks = await hooksFor({})
  const started = await hooks.auth.methods[1].authorize()
  await started.callback("one_time_code_from_the_browser")

  const [start] = mock.requests("/desktop-sign-in")
  expect(start.body.action).toBe("start")
  expect(start.body.code_challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/)
  expect(start.body.redirect_port).toBeGreaterThanOrEqual(49152)
  expect(start.body.redirect_port).toBeLessThan(65536)
  expect(start.body.state).toMatch(/^[A-Za-z0-9\-_]{32}$/)
  expect(mock.state.lastCodeChallenge).toBe(start.body.code_challenge)
  expect(_internal.s256(mock.state.lastVerifier)).toBe(start.body.code_challenge)

  const redeem = mock.requests("/desktop-sign-in").at(-1)
  expect(redeem.body).toEqual({
    action: "token",
    code: "one_time_code_from_the_browser",
    code_verifier: mock.state.lastVerifier,
  })
})

test("a stale or refused code fails with words the person can act on", async () => {
  const hooks = await hooksFor({})
  const started = await hooks.auth.methods[1].authorize()
  await expect(started.callback("a_code_the_backend_never_issued")).rejects.toThrow(/expired/)
  await expect(started.callback("")).rejects.toThrow(/No callback code/)
})

test("a login service with no session says to use the other method", async () => {
  mock = startMock({})
  // The vendor answers 200 with no session id when it has no such function.
  mock.server.stop(true)
  const offline = startMock({})
  offline.state.requests.length = 0
  mock = offline
  const broken = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } }),
  })
  const hooks = await plugin.server({}, { baseUrl: `http://127.0.0.1:${broken.port}/functions/v1` })
  await expect(hooks.auth.methods[1].authorize()).rejects.toThrow(/other sign-in method/)
  broken.stop(true)
})

// Drives the plugin through a real magpie in a throwaway HOME, against the
// stand-in Alysis cloud. This is the check the unit tests can't make: that
// magpie itself loads the package, signs an account in through the plugin's
// oauth method, keeps the sign-in, and sends a provider request through the
// loader the plugin returns.
//
//   bun test/sandbox/sandbox.mjs [path-to-magpie-binary]
//
// Nothing here touches a real ~/.config/magpie: every magpie call runs with its
// own HOME.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { paidBilling, startMock } from "../mock-server.mjs"

const repo = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const magpie = process.argv[2] || join(process.env.HOME || "", ".capy/work/magpie-bin")

const mock = startMock({
  pendingPolls: ["pending", "pending", "approved"],
  billing: paidBilling(),
  models: ["gpt-6-luna", "claude-haiku-5-5", "deepseek-flash", "glm-5.3-flash"],
})

const home = mkdtempSync(join(tmpdir(), "alysis-sandbox-"))
mkdirSync(join(home, ".config/magpie"), { recursive: true })

// Async on purpose: the stand-in serves from this same process, and a blocking
// spawn would hold the event loop it needs to answer magpie's requests.
async function run(args, { quiet = false } = {}) {
  return runWith(home, args, { quiet })
}

async function runWith(where, args, { quiet = false } = {}) {
  const proc = Bun.spawn([magpie, ...args], {
    env: {
      ...process.env,
      HOME: where,
      XDG_CONFIG_HOME: join(where, ".config"),
      XDG_CACHE_HOME: join(where, ".cache"),
      MAGPIE_ADDR: "127.0.0.1:3499",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`.trim()
  await proc.exited
  if (!quiet) console.log(`\n$ magpie ${args.join(" ")}\n${out}`)
  return out
}

// magpie logs on stderr around the JSON it prints, sometimes interleaved with
// it, so the log lines are dropped before the document is read.
function jsonOf(text) {
  const lines = text
    .split("\n")
    .filter((line) => !/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d/.test(line) && !line.startsWith("plugin: "))
  const body = lines.join("\n")
  return JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1))
}

const failed = []
const expect = (ok, what) => {
  if (!ok) failed.push(what)
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`)
}

try {
  expect((await run(["plugin", "add", repo])).includes("alysis-code"), "magpie loads the plugin")
  // `plugin add` writes plugins.json itself, so the stand-in's address is put
  // in after it — the same place a person's options live.
  const pluginsJson = join(home, ".config/magpie/plugins.json")
  const added = JSON.parse(readFileSync(pluginsJson, "utf8"))
  added.plugins[0].options = { baseUrl: mock.baseUrl }
  writeFileSync(pluginsJson, JSON.stringify(added, null, 2))
  const listed = await run(["plugin", "--json"])
  const provider = jsonOf(listed).providers.find((p) => p.id === "alysis-code")
  expect(provider?.name === "Alysis Code", "the provider is named Alysis Code")
  expect(provider?.methods?.length === 1, "the device code is the only sign-in method offered")
  expect(
    provider?.methods?.[0]?.label === "Sign in with Alysis Code",
    "that method reads as the one way in",
  )
  expect(provider?.icon === "https://alysiscode.com/black-logo.png", "the icon URL reaches magpie")
  expect(provider?.usage === true, "magpie sees the usage hook")
  expect(provider?.signedIn === false, "nothing is signed in yet")

  // The only method needs no number: magpie asks only when a plugin offers more
  // than one (internal/cli/plugins_cli.go: pluginLogin).
  const login = await run(["plugin", "login", "alysis-code"])
  expect(/signed in|Signed in|✓/.test(login), "magpie signs the account in through the device flow")

  const after = await run(["plugin", "--json"])
  const signed = jsonOf(after).providers.find((p) => p.id === "alysis-code")
  expect(signed?.signedIn === true, "magpie keeps the sign-in")
  expect(signed?.accountId === "ada@example.com", "the account is named by its email")
  // The account's own listing is the model list, not the plugin's snapshot.
  expect(
    signed?.models?.map((m) => m.id).join(",") ===
      "gpt-6-luna,claude-haiku-5-5,deepseek-flash,glm-5.3-flash",
    "the account's listing decides the models",
  )

  // Each model keeps the wire its vendor serves it on. The models hook's list
  // replaces the provider's, so a dialect left only on the config hook is lost
  // here — which is exactly the bug this check exists for.
  const npmOf = Object.fromEntries(signed.models.map((m) => [m.id, m.npm]))
  expect(npmOf["gpt-6-luna"] === "@ai-sdk/openai", "gpt-6-luna keeps the Responses dialect")
  expect(npmOf["claude-haiku-5-5"] === "@ai-sdk/anthropic", "claude-haiku-5-5 keeps the Anthropic dialect")
  expect(npmOf["deepseek-flash"] === "@ai-sdk/openai-compatible", "deepseek-flash is chat completions")
  expect(npmOf["glm-5.3-flash"] === "@ai-sdk/openai-compatible", "glm-5.3-flash is chat completions")
  // And what the model can do, which the same replacement would have dropped.
  const luna = signed.models.find((m) => m.id === "gpt-6-luna")
  expect(luna?.reasoning === true && luna?.image === true, "gpt-6-luna keeps its capabilities")
  expect(luna?.context === 1_050_000, "gpt-6-luna keeps its context window")

  const test = await run(["provider", "test", "alysis-code"])
  expect(/✓|ok|passed/i.test(test) && !/✗|failed/i.test(test), "magpie sends a request through the loader")

  const quota = await run(["quota"])
  expect(/37%|37\s*\/\s*100|credits/.test(quota), "magpie reads the credits allowance")

  // The editor and `magpie model api` read the provider's bases per API; all
  // three show once the models carry their own dialects.
  const lunaApi = await run(["model", "api", "alysis-code/gpt-6-luna"])
  const haikuApi = await run(["model", "api", "alysis-code/claude-haiku-5-5"])
  expect(lunaApi.includes("vendor's list says, responses"), "magpie model api reports responses for gpt-6-luna")
  expect(haikuApi.includes("vendor's list says, anthropic"), "magpie model api reports anthropic for claude-haiku-5-5")
  expect(lunaApi.includes("chat, responses, anthropic"), "the provider offers all three APIs")

  const chat = mock.requests("/chat/completions").at(-1)
  expect(chat?.headers["user-agent"] === "alysis-code/0.1.0", "the request carried the app's user agent")
  expect(chat?.headers["accept-encoding"] === "identity", "the request carried the app's accept-encoding")
  expect(chat?.headers.authorization === "Bearer slk_test_key", "the request carried the account's key")
  const status = mock.requests("/account-status").at(-1)
  expect(status?.headers["user-agent"] === "alysis-code/0.1.0", "the usage read carried the app's user agent")

  // Every dialect magpie speaks on this provider carries the same app identity,
  // and the Anthropic one carries its version pin.
  for (const [route, what] of [
    ["/llm/v1/responses", "the Responses request"],
    ["/llm/v1/messages", "the Anthropic request"],
  ]) {
    const call = mock.requests(route).at(-1)
    expect(call?.headers["user-agent"] === "alysis-code/0.1.0", `${what} carried the app's user agent`)
    expect(call?.headers["accept-encoding"] === "identity", `${what} asked for no encoding`)
    expect(call?.headers.authorization === "Bearer slk_test_key", `${what} carried the account's key`)
  }
  expect(mock.state.sawAnthropicVersion === "2023-06-01", "the Anthropic request carried its version pin")
  expect(!mock.requests("/llm/v1/messages").at(-1)?.headers["x-api-key"], "the key is never sent as x-api-key")

  const authFile = join(home, ".config/magpie/plugin-auth.json")
  const saved = JSON.parse(readFileSync(authFile, "utf8"))
  const record = saved["alysis-code"]
  expect(record?.type === "api" && record?.key === "slk_test_key", "the sign-in is kept as the key")
  expect(record?.metadata?.email === "ada@example.com", "the account is named by its email in metadata")

  // The same, from the file magpie caches so it can start without asking the
  // plugin — the record the Captain inspected.
  const cached = JSON.parse(readFileSync(join(home, ".config/magpie/plugin-providers.json"), "utf8"))
  const rows = JSON.stringify(cached)
  expect(rows.includes("@ai-sdk/openai") && rows.includes("@ai-sdk/anthropic"), "the cache keeps both dialects")
  // A sign-in kept by the earlier build must go on working: the record shape is
  // untouched, so a home with auth and no login run still sends and reads.
  const carried = mkdtempSync(join(tmpdir(), "alysis-carried-"))
  await runWith(carried, ["plugin", "add", repo], { quiet: true })
  const carriedJson = join(carried, ".config/magpie/plugins.json")
  const carriedPlugins = JSON.parse(readFileSync(carriedJson, "utf8"))
  carriedPlugins.plugins[0].options = { baseUrl: mock.baseUrl }
  writeFileSync(carriedJson, JSON.stringify(carriedPlugins, null, 2))
  // exactly what the plugin returned and magpie saved before this change
  writeFileSync(
    join(carried, ".config/magpie/plugin-auth.json"),
    JSON.stringify({
      "alysis-code": { type: "api", key: "slk_test_key", metadata: { email: "ada@example.com" } },
    }),
    { mode: 0o600 },
  )
  const carriedTest = await runWith(carried, ["provider", "test", "alysis-code"])
  expect(/✓ chat/.test(carriedTest) && !/not signed in/.test(carriedTest), "a kept sign-in still works, with no re-login")
  const carriedQuota = await runWith(carried, ["quota"])
  expect(/credits/.test(carriedQuota), "a kept sign-in still reports its allowance")
} finally {
  mock.close()
  console.log(`\nsandbox HOME: ${home}`)
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}
console.log("\nall sandbox checks passed")

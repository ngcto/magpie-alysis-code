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
  models: ["gpt-6-luna", "deepseek-flash"],
})

const home = mkdtempSync(join(tmpdir(), "alysis-sandbox-"))
mkdirSync(join(home, ".config/magpie"), { recursive: true })

// Async on purpose: the stand-in serves from this same process, and a blocking
// spawn would hold the event loop it needs to answer magpie's requests.
async function run(args, { quiet = false } = {}) {
  const proc = Bun.spawn([magpie, ...args], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
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
  expect(provider?.methods?.length === 2, "both sign-in methods reach magpie")
  expect(provider?.icon === "https://alysiscode.com/black-logo.png", "the icon URL reaches magpie")
  expect(provider?.usage === true, "magpie sees the usage hook")
  expect(provider?.signedIn === false, "nothing is signed in yet")

  // Method 1 is the device flow; magpie numbers its methods in the order the
  // plugin lists them (internal/cli/plugins_cli.go: pluginLogin).
  const login = await run(["plugin", "login", "alysis-code", "1"])
  expect(/signed in|Signed in|✓/.test(login), "magpie signs the account in through the device flow")

  const after = await run(["plugin", "--json"])
  const signed = jsonOf(after).providers.find((p) => p.id === "alysis-code")
  expect(signed?.signedIn === true, "magpie keeps the sign-in")
  expect(signed?.accountId === "ada@example.com", "the account is named by its email")
  // The account's own listing is the model list, not the plugin's snapshot.
  expect(
    signed?.models?.map((m) => m.id).join(",") === "gpt-6-luna,deepseek-flash",
    "the account's listing decides the models",
  )

  const test = await run(["provider", "test", "alysis-code"])
  expect(/✓|ok|passed/i.test(test) && !/✗|failed/i.test(test), "magpie sends a request through the loader")

  const quota = await run(["quota"])
  expect(/37%|37\s*\/\s*100|credits/.test(quota), "magpie reads the credits allowance")

  const chat = mock.requests("/chat/completions").at(-1)
  expect(chat?.headers["user-agent"] === "alysis-code/0.1.0", "the request carried the app's user agent")
  expect(chat?.headers["accept-encoding"] === "identity", "the request carried the app's accept-encoding")
  expect(chat?.headers.authorization === "Bearer slk_test_key", "the request carried the account's key")
  const status = mock.requests("/account-status").at(-1)
  expect(status?.headers["user-agent"] === "alysis-code/0.1.0", "the usage read carried the app's user agent")

  const authFile = join(home, ".config/magpie/plugin-auth.json")
  const saved = JSON.parse(readFileSync(authFile, "utf8"))
  const record = saved["alysis-code"]
  expect(record?.type === "api" && record?.key === "slk_test_key", "the sign-in is kept as the key")
  expect(record?.metadata?.email === "ada@example.com", "the account is named by its email in metadata")
} finally {
  mock.close()
  console.log(`\nsandbox HOME: ${home}`)
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}
console.log("\nall sandbox checks passed")

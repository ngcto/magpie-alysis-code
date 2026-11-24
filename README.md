# Alysis Code for magpie

A [magpie](https://usemagpie.ai) provider plugin for **Alysis Code**
(alysiscode.com): sign in with an Alysis Code account and its hosted models
reach every agent, with the account's credits as the allowance magpie shows and
routes by.

```sh
magpie plugin add ./magpie-alysis-code   # or: magpie plugin add <this repo>
magpie plugin login alysis-code
magpie provider test alysis-code
magpie quota
```

Agents then name a model as `alysis-code/gpt-6-luna`.

## Signing in

A device code, and nothing else. magpie shows a code, you approve it at
`https://alysiscode.com/activate`, and the sign-in finishes on its own. It needs
no browser on the machine magpie runs on, so it works in a container:

```sh
magpie plugin login alysis-code
```

**What is kept.** The plugin returns the `slk_…` gateway key and the account's
email; magpie stores `{type: "api", key, metadata: {email}}` in
`plugin-auth.json` (mode 600) and names the account by that email, so signing in
again replaces the same account instead of adding a second one.

**There is no refresh, by design.** Alysis Code issues no refresh token and no
expiry: the key lives until it is revoked. The plugin therefore has no
`auth.refresh` hook, and a `401` from the gateway means the account must sign in
again — magpie's own rule, which marks the account and stops sending to it.

**Two accounts are two devices.** The only install-scoped value in the whole
protocol is `installation_id`, sent only at sign-in. The plugin generates a
fresh UUIDv4 per account and a `client_name` carrying its first six characters,
so the account page shows two unrelated devices rather than one device signing
in twice. Nothing else in a request is install-scoped, and **nothing is signed**
— there is no HMAC, no timestamp, no nonce to reproduce.

## The headers, exactly

Every inference and account request carries this set and nothing invented:

| Header | Value | Where |
| --- | --- | --- |
| `authorization` | `Bearer slk_…` | every call that needs the account |
| `content-type` | `application/json` | POSTs |
| `user-agent` | `alysis-code/0.1.0` | every call |
| `accept-encoding` | `identity` | every call |
| `anthropic-version` | `2023-06-01` | the two Claude models, on `/messages` |

These are the literals the app itself sends (`llm/openai_compat.py:2518`,
`:178`, `:357-361`; `anthropic_messages.py:78`, `:1634`). `accept-encoding:
identity` is not cosmetic: a compressed stream moves chunk boundaries, and a
`data:` frame split across a decode boundary breaks streaming.

`x-api-key` does **not** authenticate here — the gateway ignores it and answers
as if anonymous — so the key goes in `Authorization` even on the Anthropic route.
Anthropic's AI SDK package adds `x-api-key` on its own, so the loader **deletes
that header** before the request leaves; a request carrying it would read as
signed out.

## Models and wire dialects

The gateway is one base URL serving three wire APIs, and the app picks one by
model id (`llm/factory.py:390-400`). magpie picks by the AI SDK package named on
the model, so each model declares its own:

| Models | Dialect | Package | Path |
| --- | --- | --- | --- |
| `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6.1-terra` | OpenAI Responses | `@ai-sdk/openai` | `/responses` |
| `claude-sonnet-5-5`, `claude-haiku-5-5` | Anthropic Messages | `@ai-sdk/anthropic` | `/messages` |
| everything else | OpenAI Chat Completions | `@ai-sdk/openai-compatible` | `/chat/completions` |

Which models an account may use is the gateway's authenticated listing
(`GET {gateway}/models`), not the plugin's snapshot; the snapshot only supplies
each model's context window, output window and image support. A model the
listing names that the snapshot doesn't describe still works, with a
conservative 128K/32K window.

**Where the dialect has to be written, and why it is easy to get wrong.** The
two hooks spell a model differently, and only one of them decides the wire:

- the `config` hook puts the dialect on `provider.npm` — this is what magpie
  shows before anyone signs in;
- the `models` hook returns OpenCode's `Model`, where it is `api.npm`.

The host **replaces** a provider's model map with what the `models` hook returns
(`internal/plugin/host.js:2274`), and takes each model's package from
`m.api.npm` (`:2669`), which becomes `plugin.Model.NPM` and drives the gateway's
dialect switch (`internal/provider/plugins.go`, `pluginProtocol`). So a dialect
set only in the `config` hook is silently lost the moment an account signs in,
and every model falls back to chat completions — which the vendor refuses for
those five with `400 · Luna uses /v1/responses for reasoning and tools.` Both
spellings are set here, and the sandbox check reads the cached
`plugin-providers.json` to confirm the per-model `npm` survives sign-in.

**Reasoning levels are not offered.** The effort values differ per model
(`low/high/max` for DeepSeek, `low/medium/high` for Gemini, `low` alone for
several others — `reasoning_contracts.py:518-660`), and a set the vendor doesn't
take breaks requests. Models report `reasoning: true` and no `variants`, so the
gateway uses its own default. Adding variants needs the per-model values
verified against a live account.

## The allowance

`auth.usage` reads `GET {cloud}/account-status` and reports the three things that
actually stop an account:

| Window | Share | Reset | Why |
| --- | --- | --- | --- |
| `5 hours` | `burn_5h_microusd / cap_5h_microusd` | none | the rolling five-hour cap |
| `7 days` | `burn_7d_microusd / cap_7d_microusd` | none | the rolling weekly cap |
| `30 days` | `cycle_burn_microusd / monthly_credits_microusd` (free: `/ free_allowance_microusd`) | `credits_reset_at`, else `current_period_end`, else `free_next_refill_at` | the credited period |
| `Balance` | — | same | credits left, as a wallet |

The first two are rolling and **the vendor publishes no reset moment for them**,
so they carry their span and no `resetsAt` rather than an invented timestamp.
Smart routing orders accounts by the reset it can name, and the period is the
window that has one. A window whose cap the vendor doesn't state is left out
rather than sent as zero, and an account that reports nothing is an error on the
card — never an invented 0%.

Because these windows carry `used` and a real reset, the account takes part in
magpie's Smart routing ("of those with quota to spare, the one whose allowance
renews soonest") instead of being a provider routing can't see.

## What is verified, and what is not

Verified, with the evidence in this repository:

- `bun test` — 37 tests against a stand-in Alysis cloud (`test/mock-server.mjs`)
  that records the exact headers each call carries.
- `bun test/sandbox/sandbox.mjs <magpie-binary>` — 39 checks against a real
  magpie in a throwaway `HOME`: it loads the plugin, offers one sign-in method,
  signs an account in through the device flow, keeps the sign-in, lists the
  account's models, sends a request through the loader and reads the allowance.
  All three dialects are exercised, the cached provider record is read per
  model, and a home holding a sign-in but no login run is checked to still
  work:

  ```
  $ magpie provider test alysis-code
  ✓ chat       2 ms · deepseek-flash
    ✓ responses  0 ms · gpt-6-luna
    ✓ anthropic  0 ms · claude-haiku-5-5

  $ magpie model api alysis-code/gpt-6-luna
  alysis-code/gpt-6-luna · auto: as its vendor's list says, responses
    · alysis-code has chat, responses, anthropic
  ```

  and `magpie quota` prints
  `alysis-code · Pro · renews Nov 28 · ada@example.com  subscription  5h 37% (37 / 100 credits)  7d 25% (200 / 800 credits)  30d 20% (1,200 / 6,000 credits) ↻4d4h  Balance 1,240 credits left`.
- The icon URL (`https://alysiscode.com/black-logo.png`) answers 200 with a
  512×512 PNG, and magpie reports it as the provider's icon
  (`magpie plugin --json`).

Also verified live, with a real Alysis Code account in magpie v0.1.4738 — every
model on its own dialect, with real credits spent:

```
magpie provider test alysis-code
  ✓ chat       1708 ms · deepseek-flash
  ✓ responses  2081 ms · gpt-6-luna
  ✓ anthropic  2321 ms · claude-haiku-5-5
```

The free-tier allowance read `5h 0/10 · 7d 0/20 · 30d 0/50 · renews Dec 24`,
which is the vendor's published free tier, and the balance moved 50 → 49.99
credits. So the sign-in, the `/account-status` field contract, and the
`/responses` and `/messages` bodies magpie translates are all confirmed against
the real service.

**Open, and not a defect:** with a single account there is nothing to order, so
how the two rolling caps (which carry no `resetsAt` by design) weigh against
another account is untested. Worth a look once two accounts are signed in.

## The most likely thing to break

The vendor moving a model to another dialect. The gateway serves three wire APIs
from one base and picks between them by model id
(`llm/factory.py:390-400`), so a model the vendor moves to Responses or Messages
— or a new one it releases there — will fail with a `400` naming the path until
its `CATALOG` entry carries the matching `wire`. That failure is loud and
self-describing, and the fix is one word per model.

## Development

```sh
bun test                              # unit tests against the stand-in
bun test/sandbox/sandbox.mjs <magpie> # a real magpie, in a sandbox HOME
```

`test/mock-server.mjs` answers all three wire APIs the vendor's client reads
(`src/alysis_code/account_login.py`, `alysis_cloud.py`, `llm/factory.py`) and
records every request, so both the header set and the dialect each model is sent
on are asserted rather than assumed.

Nothing here touches a real `~/.config/magpie`: the sandbox script gives every
magpie call its own `HOME`.

## Licence

MIT. The protocol facts above are read from
[AlysisAi/AlysisCode](https://github.com/AlysisAi/AlysisCode) (Apache-2.0); the
file and line citations point there.

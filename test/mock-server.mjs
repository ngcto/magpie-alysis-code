// A stand-in for the Alysis Code cloud functions and its model gateway, so the
// plugin can be driven end to end without an account. It answers the shapes
// the vendor's own client reads (AlysisAi/AlysisCode: src/alysis_code/
// account_login.py and alysis_cloud.py) and records every request it gets, so
// a test can check the headers that reached it.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const sse = (frames) =>
  new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  })

/**
 * Start the stand-in.
 *
 * @param {object} [plan] what the endpoints answer
 * @param {string[]} [plan.pendingPolls] statuses device-token gives before it approves
 * @param {object} [plan.billing] the /account-status billing object
 * @param {string[]} [plan.models] ids the gateway's /models lists
 */
export function startMock(plan = {}) {
  const state = {
    requests: [],
    polls: 0,
    pending: plan.pendingPolls ?? ["pending", "pending"],
    deviceGrants: new Map(),
    billing: plan.billing ?? paidBilling(),
    models: plan.models ?? ["gpt-6-luna", "deepseek-flash", "some-new-model"],
    schemaVersion: plan.schemaVersion ?? 1,
    email: plan.email ?? "ada@example.com",
    statusCode: plan.statusCode ?? 200,
    deviceStatus: plan.deviceStatus,
    chatAnswer: plan.chatAnswer ?? "pong",
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json().catch(() => null) : null
      state.requests.push({
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers),
        body,
      })

      if (url.pathname.endsWith("/device-code")) {
        const grant = {
          device_code: `dev_${state.deviceGrants.size + 1}`,
          user_code: "WXYZ-1234",
          verification_url: "_not used_",
          verification_url_complete: `${url.origin}/activate?code=WXYZ-1234`,
          interval: 0.05,
          expires_in: 60,
        }
        state.deviceGrants.set(grant.device_code, body)
        return json(grant)
      }

      if (url.pathname.endsWith("/device-token")) {
        const grant = state.deviceGrants.get(body?.device_code)
        if (!grant) return json({ status: "not_found" })
        state.polls += 1
        const next = state.deviceStatus ?? state.pending.shift() ?? "approved"
        if (next === "approved") return json({ status: "approved", key: "slk_test_key" })
        return json({ status: next })
      }

      if (url.pathname.endsWith("/account-status")) {
        const caller = request.headers.get("authorization") || ""
        if (state.statusCode !== 200) return json({ error: "no" }, state.statusCode)
        if (caller === "Bearer slk_revoked") return json({ error: "unauthorized" }, 401)
        return json({
          schema_version: state.schemaVersion,
          email: state.email,
          display_name: "Ada",
          billing: state.billing,
          model_promotions: [],
        })
      }

      if (url.pathname.endsWith("/llm/v1/models")) {
        return json({ object: "list", data: state.models.map((id) => ({ id, object: "model" })) })
      }

      if (url.pathname.endsWith("/llm/v1/chat/completions")) {
        const answer = {
          id: "chatcmpl-1",
          object: "chat.completion",
          model: body?.model,
          choices: [{ index: 0, message: { role: "assistant", content: state.chatAnswer } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
        return json(answer)
      }

      // The two other wire APIs the gateway serves on the same base. magpie
      // reaches these only when a model declares the dialect, which is the
      // thing the sandbox checks.
      if (url.pathname.endsWith("/llm/v1/responses")) {
        const answer = {
          id: "resp_1",
          object: "response",
          created_at: 1_700_000_000,
          status: "completed",
          model: body?.model,
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: state.chatAnswer, annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }
        if (body?.stream !== true) return json(answer)
        const frames = [
          { type: "response.output_text.delta", delta: state.chatAnswer, item_id: "msg_1", output_index: 0, content_index: 0 },
          { type: "response.completed", response: answer },
        ]
        return sse(frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`))
      }

      if (url.pathname.endsWith("/llm/v1/messages")) {
        state.sawAnthropicVersion = request.headers.get("anthropic-version") || ""
        const answer = {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: body?.model,
          content: [{ type: "text", text: state.chatAnswer }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }
        if (body?.stream !== true) return json(answer)
        const frames = [
          ["message_start", { type: "message_start", message: { ...answer, content: [] } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: state.chatAnswer } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
          ["message_stop", { type: "message_stop" }],
        ]
        return sse(frames.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      return json({ error: { message: `no route for ${url.pathname}` } }, 404)
    },
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}/functions/v1`,
    server,
    state,
    /** Requests seen, optionally only those whose path ends with `suffix`. */
    requests(suffix) {
      return suffix ? state.requests.filter((r) => r.path.endsWith(suffix)) : state.requests
    },
    close() {
      server.stop(true)
    },
  }
}

/** A paid plan: the Pro one, 6 000 credits a 30-day period. */
export function paidBilling(over = {}) {
  return {
    status: "active",
    tier: "pro",
    balance_microusd: 12_400_000,
    month_burn_microusd: 12_000_000,
    cycle_burn_microusd: 12_000_000,
    burn_5h_microusd: 370_000,
    burn_7d_microusd: 2_000_000,
    cap_5h_microusd: 1_000_000,
    cap_7d_microusd: 8_000_000,
    free_allowance_microusd: null,
    unlimited_credits: false,
    free_granted_period: false,
    cancel_at_period_end: false,
    free_next_refill_at: null,
    current_period_end: "2026-12-01T00:00:00Z",
    credits_reset_at: "2026-11-28T09:00:00Z",
    paid: {
      plan: "plan_15",
      plan_name: "Pro",
      monthly_credits_microusd: 60_000_000,
      credit_period_days: 30,
      ledger_microusd_per_base_credit: 10_000,
      credit_unit_version: "paid-base-display-v1",
      credits_reset_at: "2026-11-28T09:00:00Z",
      models: [],
    },
    ...over,
  }
}

/** The free tier as the vendor publishes it: 50 credits a 30-day grant,
 *  10 per rolling five hours and 20 per rolling week. */
export function freeBilling(over = {}) {
  return {
    status: "none",
    tier: "free",
    balance_microusd: 315_000,
    month_burn_microusd: 185_000,
    cycle_burn_microusd: 185_000,
    burn_5h_microusd: 60_000,
    burn_7d_microusd: 120_000,
    cap_5h_microusd: 100_000,
    cap_7d_microusd: 200_000,
    free_allowance_microusd: 500_000,
    unlimited_credits: false,
    free_granted_period: true,
    cancel_at_period_end: false,
    free_next_refill_at: "2026-12-05T00:00:00Z",
    current_period_end: null,
    credits_reset_at: null,
    ...over,
  }
}

# AgentSearch agent bridge

The bridge connects to an already-running AgentSearch browser over CDP and
exposes a loopback-only HTTP API to the native sidebar.

Put the raw xAI key (one line, no quotes or variable name) in
`~/agentsearch-xai-key.txt`, or set `XAI_API_KEY`. Then run:

```sh
npm install
npm start
```

Defaults: bridge `127.0.0.1:9333`, CDP `127.0.0.1:9222`. Override with
`AGENT_BRIDGE_PORT` and `AGENTSEARCH_CDP_URL`. Set `AGENT_BRIDGE_MOCK=1` to
exercise messaging and the purchase gate without contacting xAI.

The loopback HTTP API is:

- `GET /health`
- `POST /v1/tasks`
- `GET /v1/tasks/:runId/events?after=:sequence`
- `POST /v1/tasks/:runId/confirmation`
- `POST /v1/tasks/:runId/cancel`

Mock mode does not require CDP or an API key. Deterministic failure scenarios
are selected by including one of these markers in the task:
`[mock:slow]`, `[mock:confirmation]`, `[mock:navigation-failure]`,
`[mock:timeout]`, `[mock:max-steps]`, or `[mock:invalid-response]`.

Sanitized per-run action traces are appended to
`/tmp/agentsearch-action-trace.jsonl`. Set `AGENTSEARCH_ACTION_TRACE_FILE` to
override the destination.

Sanitized Grok message payloads and hashes of the exact payloads are appended
to `/tmp/agentsearch-api-payloads.jsonl`. Set `AGENTSEARCH_API_PAYLOAD_LOG` to
override the destination.

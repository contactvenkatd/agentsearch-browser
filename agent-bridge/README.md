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

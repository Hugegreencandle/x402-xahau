# demo — an AI agent autonomously pays through x402 on Xahau, with its on-chain guardrail Hook enforcing the budget at L1

This is a runnable, end-to-end demo of the **agentic payments** story:

> An autonomous agent hits a paywalled HTTP resource, gets an **x402** `402 Payment Required`,
> signs a Xahau Payment, and retries. A small **resource server** relays the payment to the
> **x402-xahau facilitator** (`../server.mjs`), which submits it to the real Xahau ledger. The
> agent's account carries an **xahc `agent_guardrail` Hook** that caps per-payment spend. An
> in-budget call goes through; an over-budget call is **rejected on-chain** (`tecHOOK_REJECTED`)
> and the agent is denied access. **The ledger — not the app — enforces the agent's budget.**

A real testnet run with on-ledger-verified transaction hashes is in [`DEMO-RUN.md`](./DEMO-RUN.md).

## The pieces

| file | role |
|---|---|
| `facilitator-testnet.mjs` | Runs the **real** facilitator surface (`/supported`, `/verify`, `/settle`, `/health`) against Xahau **testnet**. Imports the unchanged production `verifyExact` + `settle` from `../server.mjs`; injects an `api_version:1` xrpl client via the `_deps` seam (Xahau requires v1; the default xrpl client uses v2). |
| `resource-server.mjs` | A tiny x402 **resource server**. Sells `GET /premium` (1 XAH) and `GET /premium-plus` (10 XAH). Returns `402` + `paymentRequirements` with no payment; on an `X-PAYMENT` retry it calls the facilitator `/verify` then `/settle`, and grants/denies based on the real settlement. |
| `agent.mjs` | The autonomous **agent**. Hits a resource, parses the 402, signs a Payment (NetworkID 21338, 0.1 XAH fee for Hook execution, `LastLedgerSequence` ahead), retries with `X-PAYMENT`, and prints each step + the on-chain outcome. |

## The split attack (`split-attack.mjs`) — off-chain check vs on-chain stateful guardrail

`node demo/split-attack.mjs` runs a self-contained illustration of **why** the on-chain guardrail
matters: two agents get the same hostile instruction — *"make 4 buys of 4 XAH, each under the 5 XAH
per-tx limit"* (total 16 XAH, against a 10 XAH budget).

- **Agent A (ungoverned)** has only an off-chain per-call limit. It approves all four — a per-call
  check never sums the calls — and **overspends to 16 XAH**.
- **Agent B (governed)** runs the stateful guardrail (`LIM` per-tx + `PLM` period cap + `PER`,
  cumulative `spent` in HookState). It accepts the first two, then **rejects** the buy that would
  breach `PLM` (on-ledger that is a `tecHOOK_REJECTED`), staying **within budget at 8 XAH**.

It is an **illustrative model**, not a proof: the governed decision faithfully reimplements the
deployed rule; the real enforcement is that rule **PROVEN for all inputs** by xahc-prover (invariant
`period-budget`) and executing on-ledger. The core logic is exported and unit-tested in `../test.mjs`
so it cannot silently become a strawman. Run with `--live` for the on-chain pointer (install the
stateful guardrail on a testnet account and watch the real reject + `GET /policy/:account` decrement).
The two live scenarios below use the simpler **per-tx** guardrail.

## The two scenarios

| resource | price | vs. the 5 XAH guardrail cap | expected |
|---|---|---|---|
| `GET /premium` | 1 XAH | under | **granted** — Hook allows, `tesSUCCESS`, 200 + content |
| `GET /premium-plus` | 10 XAH | over | **blocked** — Hook rejects on-ledger (`tecHOOK_REJECTED`), 402, no access |

## Prerequisites

- Node 18+ (uses global `fetch`). Run from the facilitator's `node_modules` (the parent dir).
- A funded Xahau **testnet** PAYER account with the `agent_guardrail` Hook installed
  (`LIM = 5 XAH`, `DST =` the merchant/PAYEE), plus a PAYEE account. The committed proof harness
  `../testnet-proof.mjs` faucets these and installs the Hook, caching the seeds in
  `/tmp/x402-testnet-proof.secrets.json` (mode 600). Run it once if you don't have that file:
  ```sh
  cd ..  &&  node testnet-proof.mjs
  ```
  The agent reads the **payer seed** from that `/tmp` scratch file — it is never stored in this repo.

## Run it (three terminals)

All commands run from this `demo/` directory. Pick a shared secret once and reuse it for both the
facilitator and the resource server.

```sh
# choose addresses from the scratch file (payer = the hooked agent, payee = the merchant)
MERCHANT=rPsf618mGxJgrvp5ubFYBTMEaJFY2KJWY3        # your PAYEE / allowlisted DST
SECRET=$(openssl rand -hex 16)                     # x402 /settle shared secret
```

**Terminal 1 — facilitator (port 4021):**
```sh
XAHAU_WSS=wss://xahau-test.net \
XAHAU_NETWORK_ID=21338 \
PORT=4021 \
X402_SHARED_SECRET="$SECRET" \
node facilitator-testnet.mjs
```

**Terminal 2 — resource server (port 4022):**
```sh
MERCHANT_ADDRESS="$MERCHANT" \
FACILITATOR_URL=http://127.0.0.1:4021 \
PORT=4022 \
X402_SHARED_SECRET="$SECRET" \
node resource-server.mjs
```

**Terminal 3 — the agent:**
```sh
RESOURCE_URL=http://127.0.0.1:4022 \
XAHAU_WSS=wss://xahau-test.net \
SECRETS_FILE=/tmp/x402-testnet-proof.secrets.json \
node agent.mjs
```

The agent prints both scenarios with real tx hashes and explorer links. Verify any hash at
`https://explorer.xahau-test.net/tx/<hash>`.

## Environment reference

**facilitator-testnet.mjs**
- `XAHAU_WSS` (default `wss://xahau-test.net`)
- `XAHAU_NETWORK_ID` (default `21338`)
- `X402_SHARED_SECRET` (optional; if set, `/settle` requires header `x-x402-secret`)
- `PORT` (default `4021`)

**resource-server.mjs**
- `MERCHANT_ADDRESS` (**required** — the `payTo` / allowlisted DST)
- `FACILITATOR_URL` (default `http://127.0.0.1:4021`)
- `X402_SHARED_SECRET` (optional; forwarded to `/settle` as `x-x402-secret`)
- `PORT` (default `4022`)

**agent.mjs**
- `RESOURCE_URL` (default `http://127.0.0.1:4022`)
- `XAHAU_WSS` (default `wss://xahau-test.net`)
- `SECRETS_FILE` (default `/tmp/x402-testnet-proof.secrets.json`)

## Security / honesty

- **No seeds in tracked files.** The agent loads its seed from the `/tmp` scratch file (mode 600).
  The repo `.gitignore` excludes `*.secrets.json`, `demo/.env*`, and `demo/*.secrets.json`. None of
  the demo source, the README, or `DEMO-RUN.md` contains a seed.
- **The facilitator logic is the production code.** `facilitator-testnet.mjs` imports `verifyExact`
  and `settle` from `../server.mjs` unchanged; it only injects the `api_version:1` client Xahau needs
  via the existing `_deps` seam and serves the HTTP routing. The signature crypto, replay protection,
  `delivered_amount` check, and honest guardrail-Hook reporting are all the real thing.
- **The Hook is the authority.** The facilitator does **not** enforce the spend limit — it submits
  the payment and surfaces the ledger's verdict. The over-budget rejection is a real on-chain
  `tecHOOK_REJECTED` from the `agent_guardrail` Hook.
- **Testnet only, no real value.**

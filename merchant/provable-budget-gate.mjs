// merchant/provable-budget-gate.mjs
// ---------------------------------------------------------------------------
// Reference MERCHANT-side gate for the x402 `kv-provable-budget` extension.
//
// A resource server (merchant) uses this to grant access ONLY when the paying
// agent's account is governed by a formally-proven on-chain guardrail Hook whose
// budget covers the price — verified WITHOUT trusting the facilitator that emitted
// the attestation. The attestation is signed by the facilitator's ed25519 receipt
// key; the merchant pins that key once from a TRUSTED GET /pubkey fetch and passes
// it as `expectedPubkey`. The gate FAILS CLOSED: anything unverifiable -> 402.
//
// The facilitator can populate a number, but it cannot forge `proofClass` + a
// matching `proofRef` for a Hook it did not actually prove — that binding is the
// moat. This file is intentionally dependency-light: it imports only the shared
// `verifyAttestation` (identical canonicalization as the signer) from the server.
// A production merchant would vendor an equivalent verifier.
import { verifyAttestation } from "../server.mjs";

/** Parse a non-negative integer drops value to BigInt, or null if malformed. */
function toDrops(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!/^\d+$/.test(s)) return null;
  try { return BigInt(s); } catch { return null; }
}

const deny = (reason) => ({ ok: false, status: 402, reason });

/**
 * Decide whether to grant access for a `priceDrops` charge given a signed budget
 * attestation. Pure + fail-closed. Returns { ok:true } or { ok:false, status:402,
 * reason }.
 *
 * @param {object}  attestation   the { ...fields, proof } object from the facilitator
 * @param {string}  expectedPubkey the merchant's TRUSTED facilitator pubkey (hex, from /pubkey)
 * @param {string|number|bigint} priceDrops the charge in drops
 * @param {boolean} [requireProof=true] require a proven-invariant binding (proofClass)
 */
export function checkProvableBudget({ attestation, expectedPubkey, priceDrops, requireProof = true }) {
  if (!attestation || typeof attestation !== "object") return deny("no budget attestation presented");
  if (!expectedPubkey) return deny("merchant has no trusted facilitator pubkey configured");
  // 1) The signature must verify against the merchant's trusted facilitator key.
  if (verifyAttestation(attestation, { expectedPubkey }) !== true) {
    return deny("attestation signature invalid or not from the expected facilitator");
  }
  // 2) An on-ledger guardrail Hook must actually govern the account.
  if (!attestation.hookHash) return deny("no on-ledger guardrail Hook governs this account");
  // 3) A PROVEN invariant must be bound (proofClass names the proven property).
  if (requireProof && !attestation.proofClass) {
    return deny("no proven-invariant binding (proofClass) on the attestation");
  }
  // 4) The budget must cover the price. Stateful -> real remaining; per-tx -> LIM cap.
  const price = toDrops(priceDrops);
  if (price === null) return deny("invalid price");
  if (attestation.stateful === true) {
    const remaining = toDrops(attestation.remaining);
    if (remaining === null) return deny("stateful guardrail but remaining budget is unknown");
    if (remaining < price) return deny(`remaining budget ${attestation.remaining} < price ${priceDrops}`);
  } else {
    const lim = toDrops(attestation.perTxLimitDrops);
    if (lim === null) return deny("per-tx guardrail but its limit is unknown");
    if (lim < price) return deny(`per-tx limit ${attestation.perTxLimitDrops} < price ${priceDrops}`);
  }
  return { ok: true };
}

/**
 * Express-style middleware factory. The agent presents the attestation in an
 * `X-PROVABLE-BUDGET: base64(json)` header; the gate verifies + budget-checks it and
 * either calls next() or answers 402. `expectedPubkey` is the merchant's pinned
 * facilitator key; `priceDrops` is the charge for the guarded resource.
 */
export function provableBudgetGate({ priceDrops, expectedPubkey, requireProof = true }) {
  return function (req, res, next) {
    let attestation = null;
    const hdr = req.headers && req.headers["x-provable-budget"];
    if (typeof hdr === "string") {
      try { attestation = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")); } catch { /* stays null -> deny */ }
    }
    const verdict = checkProvableBudget({ attestation, expectedPubkey, priceDrops, requireProof });
    if (verdict.ok) return next();
    res.statusCode = verdict.status || 402;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "payment required", extension: "kv-provable-budget", reason: verdict.reason }));
  };
}

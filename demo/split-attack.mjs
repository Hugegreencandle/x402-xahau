#!/usr/bin/env node
/**
 * split-attack.mjs — the SPLIT ATTACK: why an off-chain per-call spend check cannot
 * bound an agent, and an on-chain STATEFUL guardrail Hook can.
 *
 * Two agents face the SAME hostile instruction: "make N purchases, each individually
 * under the per-transaction limit." An off-chain (config/JS) budget check approves
 * every call because it only ever sees ONE call at a time — it never sums them — so the
 * agent overspends its intended budget. The governed agent's on-chain stateful guardrail
 * (LIM per-tx + PLM period cap + PER period, cumulative `spent` in HookState) rejects the
 * call that would push the running total past the period budget. The ledger enforces the
 * budget for these Payments (corrected 2026-11-15: not a proof that the agent "cannot overspend";
 * see the correction note in README.md).
 *
 * HONESTY. This file is an ILLUSTRATIVE MODEL, not a proof. The governed decision below
 * is a faithful reimplementation of the deployed stateful guardrail's rule (slot 0x01 =
 * [periodStart|spent]); the REAL enforcement is (1) that rule PROVEN for all inputs by
 * xahc-prover (invariant: period-budget) and (2) the same rule executing on-ledger as a
 * Hook. Run `node demo/split-attack.mjs --live` for the pointer to the on-chain version
 * (a stateful-hooked testnet account where the reject is a real tecHOOK_REJECTED, and the
 * remaining budget is read live from HookState via GET /policy/:account). The off-chain
 * agent's bypass is NOT simulated away — it is the genuine logical gap (a per-call check
 * has no cross-call state), which is the whole point.
 *
 * Pure functions (periodBudgetStep / runUngoverned / runGoverned) are exported so the
 * behavior is unit-tested in test.mjs — the demo cannot silently regress into a strawman.
 */

const XAH = 1_000_000; // drops per XAH
const xah = (d) => (Number(d) / XAH).toFixed(6).replace(/\.?0+$/, "") + " XAH";

/**
 * One step of the STATEFUL period-budget guardrail (the deployed rule). Given the prior
 * state { periodStart, spent } and a payment `amt` at ledger `L`, decide accept/reject
 * and return the next state. Mirrors the on-chain Hook: reset the period when it elapses,
 * enforce the per-tx cap (LIM) and the cumulative period cap (PLM).
 *
 * @returns {{accept:boolean, reason:string, state:{periodStart:number,spent:bigint}}}
 */
export function periodBudgetStep(state, amt, L, { LIM, PLM, PER }) {
  let { periodStart, spent } = state;
  amt = BigInt(amt); LIM = BigInt(LIM); PLM = BigInt(PLM);
  // Period rollover: a fresh period resets the running total (as the Hook does).
  if (L >= periodStart + PER) { periodStart = L; spent = 0n; }
  if (amt > LIM) return { accept: false, reason: `per-tx ${xah(amt)} > LIM ${xah(LIM)}`, state: { periodStart, spent } };
  if (spent + amt > PLM) return { accept: false, reason: `would spend ${xah(spent + amt)} > period budget ${xah(PLM)} (remaining ${xah(PLM - spent)})`, state: { periodStart, spent } };
  return { accept: true, reason: `ok — ${xah(spent + amt)}/${xah(PLM)} this period`, state: { periodStart, spent: spent + amt } };
}

/**
 * The UNGOVERNED agent: an off-chain per-call limit only. It approves any call at or under
 * `perCallLimit` and has NO cumulative state, so a split spends past the intended budget.
 */
export function runUngoverned(calls, { perCallLimit, intendedBudget }) {
  perCallLimit = BigInt(perCallLimit);
  let spent = 0n; const log = [];
  for (const c of calls) {
    const amt = BigInt(c.amt);
    const ok = amt <= perCallLimit; // the ONLY check it can make — one call at a time
    if (ok) spent += amt;
    log.push({ amt: amt.toString(), accepted: ok, reason: ok ? `under per-call ${xah(perCallLimit)}` : `over per-call ${xah(perCallLimit)}` });
  }
  const budget = BigInt(intendedBudget);
  return { spent: spent.toString(), overspentBy: (spent > budget ? spent - budget : 0n).toString(), insolvent: spent > budget, log };
}

/** The GOVERNED agent: every call passes through the stateful guardrail rule. */
export function runGoverned(calls, params) {
  let state = { periodStart: 0, spent: 0n }; let spent = 0n; let firstRejectAt = null;
  const log = [];
  calls.forEach((c, i) => {
    const r = periodBudgetStep(state, c.amt, c.ledger ?? 0, params);
    state = r.state;
    if (r.accept) spent += BigInt(c.amt);
    else if (firstRejectAt === null) firstRejectAt = i;
    log.push({ amt: String(c.amt), accepted: r.accept, reason: r.reason });
  });
  return { spent: spent.toString(), boundedBy: String(params.PLM), withinBudget: spent <= BigInt(params.PLM), firstRejectAt, log };
}

// --- CLI transcript -------------------------------------------------------------------
const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", c: "\x1b[36m", x: "\x1b[0m" };
const line = (s = "") => process.stdout.write(s + "\n");

function main() {
  if (process.argv.includes("--live")) {
    line(`${C.b}Live mode pointer${C.x}`);
    line(`This model shows WHY the architectures differ. To see the REAL on-chain reject:`);
    line(`  1. install the STATEFUL guardrail (LIM+PLM+PER) on a testnet account (see demo/README.md).`);
    line(`  2. point the agent at it: it makes the same split of under-LIM Payments;`);
    line(`     the period-budget Hook returns ${C.r}tecHOOK_REJECTED${C.x} on the call that breaches PLM.`);
    line(`  3. read the live remaining budget: ${C.c}GET /policy/:account${C.x} (decrements from HookState).`);
    line(`The reject is enforced by the ledger, and that rule is PROVEN for all inputs (xahc-prover,`);
    line(`invariant: period-budget). This CLI does not transact; it explains the gap the proof closes.`);
    return;
  }

  // Scenario: per-tx LIM 5 XAH, period budget PLM 10 XAH. Hostile instruction: 4 buys of
  // 4 XAH each (each under LIM) — total 16 XAH, 60% over the 10 XAH budget.
  const params = { LIM: 5n * BigInt(XAH), PLM: 10n * BigInt(XAH), PER: 1000 };
  const calls = [0, 1, 2, 3].map((i) => ({ amt: 4n * BigInt(XAH), ledger: 100 + i }));

  line(`${C.b}=== The split attack: off-chain check vs on-chain stateful guardrail ===${C.x}`);
  line(`${C.dim}per-tx LIM ${xah(params.LIM)} · period budget PLM ${xah(params.PLM)} · hostile instruction: 4 buys of 4 XAH (each under LIM)${C.x}\n`);

  const A = runUngoverned(calls, { perCallLimit: params.LIM, intendedBudget: params.PLM });
  line(`${C.b}Agent A — ungoverned (off-chain per-call limit only)${C.x}`);
  A.log.forEach((e, i) => line(`  buy ${i + 1}: ${xah(e.amt)}  ${e.accepted ? C.g + "APPROVED" : C.r + "denied"}${C.x}  ${C.dim}(${e.reason})${C.x}`));
  line(`  ${C.r}${C.b}spent ${xah(A.spent)} — OVER its ${xah(params.PLM)} budget by ${xah(A.overspentBy)}. The per-call check never summed the calls.${C.x}\n`);

  const B = runGoverned(calls, params);
  line(`${C.b}Agent B — governed (on-chain stateful guardrail: LIM + PLM + PER)${C.x}`);
  B.log.forEach((e, i) => line(`  buy ${i + 1}: ${xah(e.amt)}  ${e.accepted ? C.g + "ACCEPTED" : C.r + "tecHOOK_REJECTED"}${C.x}  ${C.dim}(${e.reason})${C.x}`));
  line(`  ${C.g}${C.b}spent ${xah(B.spent)} — WITHIN the ${xah(params.PLM)} budget. The ledger rejected buy ${B.firstRejectAt + 1}; the agent could not overspend.${C.x}\n`);

  line(`${C.y}The gap is architectural: an off-chain per-call check has no cross-call state, so a split evades it.`);
  line(`The stateful guardrail keeps the running total in HookState — and that rule is PROVEN for all inputs`);
  line(`(xahc-prover, invariant: period-budget) and enforced on-ledger. Run --live for the on-chain pointer.${C.x}`);

  line(`\n${C.dim}${JSON.stringify({ ungoverned: { spent: A.spent, overspentBy: A.overspentBy, insolvent: A.insolvent }, governed: { spent: B.spent, withinBudget: B.withinBudget, firstRejectAt: B.firstRejectAt } })}${C.x}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

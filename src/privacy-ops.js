// What a Tacit op keeps hidden, per SPEC §11 and the op's own section (§3.4–3.7). Deliberately conservative: an op only claims what the
// spec says it hides, and every Bitcoin address in it stays public (the transaction graph is public).
const PUBLIC_OPS = new Set(['T_PETCH', 'T_PMINT']);
const AMM = new Set(['T_LP_ADD', 'T_LP_REMOVE', 'T_SWAP_VAR', 'T_SWAP_ROUTE', 'T_LP_BOND', 'T_LP_UNBOND', 'T_LP_HARVEST', 'T_FARM_INIT', 'T_FARM_REFUND', 'T_PROTOCOL_FEE_CLAIM']);
const TRANSFERS = /^T_CXFER/;
const TRADES = /^T_(AXFER|PREAUTH_BID)/;

export const STEALTH_NOTE = "Output addresses are public. A note lands on the recipient's plain Bitcoin address unless they gave a stealth (tcs1) address.";

// -> { hidden: [...], note } for a decoded envelope name ('T_CXFER_BPP', 'bridge burn', …).
export function opPrivacy(name) {
  if (PUBLIC_OPS.has(name)) return { hidden: ['nothing: a public etch or mint shows its amounts'], note: '' };
  // SPEC §3.4: T_BURN publishes burned(8 LE); its change notes stay encrypted.
  if (name === 'T_BURN') return { hidden: ['amounts of the change notes (encrypted)'], note: 'The burned amount itself is public.' };
  // SPEC §3.7 and Tacit docs/BRIDGE.md: the 161-byte bridge burn has no amount field; it is on neither chain.
  if (name === 'bridge burn') return { hidden: ['the amount burned (published on neither chain)'], note: 'The asset and the Ethereum mint it pays are public.' };
  if (name === 'T_SWAP_BATCH') return { hidden: ['each trade size inside the batch'], note: 'Pool reserves are public, so the net change of the batch is visible.' };
  if (name === 'T_SWAP_VAR') return { hidden: ['amounts of the notes it creates (encrypted)'], note: 'The input amount of this swap is public (SPEC §3.5), and so are the pool reserves.' };
  if (AMM.has(name)) return { hidden: ['note amounts (encrypted)'], note: 'Pool reserves are public, so a change in reserves shows how much entered or left the pool.' };
  if (TRADES.test(name || '')) return { hidden: ['the asset amount (encrypted)'], note: `The BTC side is public, so the price in sats can be read. ${STEALTH_NOTE}` };
  if (TRANSFERS.test(name || '')) return { hidden: ['note amounts (encrypted)'], note: STEALTH_NOTE };
  return { hidden: ['note amounts, where the op creates notes (encrypted)'], note: '' };
}

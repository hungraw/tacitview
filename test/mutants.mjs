// Mutation check for the offline tests: plant one small bug at a time in the logic that matters (a flipped
// comparison, a shifted byte offset, a removed rule) and run the suite. A mutant the suite does not catch marks code
// the tests do not really pin down. The file is always restored, even on Ctrl-C.
//   node test/mutants.mjs            every mutant
//   node test/mutants.mjs traced     only mutants whose label contains "traced"
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// [file, exact text, replacement, what the bug would do]
const MUTANTS = [
  ['server/envelope.cjs', 'out.nullifier = payload.subarray(65, 97)', 'out.nullifier = payload.subarray(64, 96)', 'bridge burn nullifier read one byte early'],
  ['server/envelope.cjs', "0x2A: 'T_WITHDRAW'", "0x2A: 'T_DEPOSIT'", 'opcode 0x2A named wrong'],
  ['src/format.js', ".padStart(decimals, '0').slice(0, places);", ".padStart(decimals, '0').slice(0, places).replace(/\\d$/, (d) => String(Math.min(9, Number(d) + 1)));", 'amounts rounded up instead of truncated'],
  ['server/tacit-address.cjs', 'const BECH32M = 0x2bc830a3;', 'const BECH32M = 0x2bc830a4;', 'wrong bech32m checksum constant'],
  ['server/chain-verify.cjs', 'listHash(leaves), listHash(nullifiers)', 'listHash(nullifiers), listHash(leaves)', 'Tacit chain hash with leaves and nullifiers swapped'],
  ['server/chain-verify.cjs', 'if ([...f.leaves, ...f.nullifiers].some((x) => seen.has(x.toLowerCase()))) out.push(...f.lockNullifiers);', 'out.push(...f.lockNullifiers);', 'lock spends counted from settle calls that did not run'],
  ['src/verify-block.js', 'lockNullifiers: arr(18)', 'lockNullifiers: arr(17)', 'browser check reads lock nullifiers from the wrong field'],
  ['server/pool-index.cjs', 'if (seen.size) { // a note leaf', 'if (true) { // a note leaf', 'calldata required for transactions without note logs'],
  ['server/pool-index.cjs', 'if (e.type === \'wrap\') c.wraps += 1;', '', 'wraps not counted'],
  ['server/pool-index.cjs', 'if (typeof input !== \'string\') throw', 'if (false) throw', 'missing calldata read as "no lock spends"'],
  ['server/measured-privacy.cjs', "Buffer.from('spent')", "Buffer.from('spend')", 'traced spends: wrong nullifier formula'],
  ['server/measured-privacy.cjs', 'if (made) {', 'if (!made) {', 'traced spends: match inverted'],
  ['server/measured-privacy.cjs', 'state.spends++;', '', 'spends not counted'],
  ['server/measured-privacy.cjs', 'if (b <= block) addCounts(out, c);', 'if (b < block) addCounts(out, c);', 'totals at a block miss that block (tail)'],
  ['server/measured-privacy.cjs', 'if (b > block) addCounts(out, c, -1);', 'if (b >= block) addCounts(out, c, -1);', 'totals at a block drop that block (recent)'],
  ['server/measured-privacy.cjs', 'if (block < state.recentFrom) return null;', '', 'totals given for blocks older than the instance can rebuild'],
  ['server/evm-history.cjs', 'w.by && w.by !== w.to && before(w.by, w.time)', 'false', 'withdrawal check: links by sender ignored'],
  ['server/evm-history.cjs', 'first.has(a) && first.get(a) < t', 'first.has(a) && first.get(a) > t', 'withdrawal check: deposit order reversed'],
  ['server/evm-history.cjs', 'if (s && e.block <= s.through) continue;', '', 'withdrawal check: snapshot and live rows counted twice'],
  ['server/evm-history.cjs', "if (n) return 'partial';", "if (n > 1) return 'partial';", 'withdrawal check: one linked withdrawal not partial'],
  ['server/evm-history.cjs', "    const wd = (e) => {\n      count('withdrawals', e);", "    const wd = (e) => {", 'EVM pool totals: withdrawals not counted'],
  ['server/evm-history.cjs', 'if (e.block > t.lastBlock) t.lastBlock = e.block;', '', 'EVM pool totals: newest event not tracked'],
  ['server/pool-index.cjs', 'if (chain && (body.noteLeaves.length || body.noteNfs.length || body.lockLeaves.length || body.lockNfs.length))', 'if (chain)', 'Tacit chain: a wrap-only transaction counted as a block'],
  ['server/tacit-chain.cjs', 'const h = height + 1;', 'const h = height + 2;', 'Tacit chain: heights skip'],
  ['server/tacit-chain.cjs', 'blockHash({ prev: hash, height: h,', 'blockHash({ prev: chain.hash, height: h,', 'Tacit chain: every block chained to the old tip'],
  ['server/chain-verify.cjs', "if (f.burns.length && [...f.leaves, ...f.nullifiers].some((x) => seen.has(x.toLowerCase()))) out.push(...f.burns);", 'out.push(...f.burns);', 'bridge mints counted from settle calls that did not run'],
  ['server/chain-verify.cjs', 'burns: arr(8)', 'burns: arr(9)', 'bridge mints read from the wrong field'],
  ['server/envelope.cjs', 'items.length === 3 ? [items[1]] : [items[1], items[items.length - 2]]', 'items.length === 3 ? [items[1]] : [items[items.length - 2]]', 'envelope in witness item 1 of a 4-item witness missed'],
  ['server/envelope.cjs', 'out.binding = payload.subarray(129, 161)', 'out.binding = payload.subarray(128, 160)', 'burn target deployment read one byte early'],
  ['server/api-handler.cjs', 'const LIMITS = { any: 300, heavy: 60 };', 'const LIMITS = { any: 3000, heavy: 60 };', 'lookup rate limit ten times looser'],
  ['server/security-headers.cjs', "\"connect-src 'self' http://localhost:* http://127.0.0.1:*\"", "\"connect-src 'self' https: http://localhost:* http://127.0.0.1:*\"", 'browser allowed to call any https host'],
  ['server/security-headers.cjs', "'referrer-policy': 'no-referrer',", "'referrer-policy': 'origin',", 'outbound links send the referrer'],
  ['src/own-node.js', 'export const LOCAL_NODE = /^http:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d{1,5})?(\\/[^\\s]*)?$/;', 'export const LOCAL_NODE = /^https?:\\/\\/.+$/;', 'own-node setting accepts any server'],
  ['src/router.js', 'return `#/eth/${s.toLowerCase()}`;', 'return `#/eth/${s}`;', 'Ethereum hashes not normalised'],
  ['server/upstream.cjs', 'if (hit && Date.now() - hit.savedAt < hit.staleMs) return { data: hit.data, stale: true, savedAt: hit.savedAt };', '', 'no stale fallback when an upstream fails'],
  ['server/rpc.cjs', 'return it.reject(new Error(message));', 'return it.resolve(null);', 'a reverted call in a batch reads as an empty answer'],
  ['server/settle-decode.cjs', 'recipient: `0x${hexAt(data, r).slice(26)}`', 'recipient: `0x${hexAt(data, r).slice(24, 64)}`', 'withdrawal recipient sliced wrong'],
  ['src/filters.js', 'aria-label="${escapeHtml(g.label)}"', 'aria-label="${g.label}"', 'filter labels not escaped'],
];

const only = process.argv[2];
const list = MUTANTS.filter(([, , , label]) => !only || label.includes(only));
let restore = null;
process.on('SIGINT', () => { restore?.(); process.exit(130); });
const survived = [];
for (const [file, from, to, label] of list) {
  const path = root + file;
  const source = readFileSync(path, 'utf8');
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) { console.log(`?  ${label}: text ${at < 0 ? 'not found' : 'not unique'} in ${file}`); survived.push(label); continue; }
  restore = () => writeFileSync(path, source);
  try {
    writeFileSync(path, source.slice(0, at) + to + source.slice(at + from.length));
    const run = spawnSync(process.execPath, ['--test', 'test/offline.cjs'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    const caught = run.status !== 0;
    console.log(`${caught ? 'caught  ' : 'MISSED  '} ${label}`);
    if (!caught) survived.push(label);
  } finally { restore(); restore = null; }
}
console.log(`\n${list.length - survived.length} of ${list.length} planted bugs caught`);
process.exitCode = survived.length ? 1 : 0;

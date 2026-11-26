// Daily snapshot refresh, run by a scheduled cloud agent (or by hand). Fresh snapshots keep cold starts short: a new
// server instance only reads the blocks after them. It changes nothing unless every check passes.
//   node scripts/refresh-snapshots.mjs         refresh, check, commit and push to main, then check the live site
//   node scripts/refresh-snapshots.mjs --dry   refresh and check only, then put the old files back
// Exit 0: pushed, or nothing new to push. Exit 1: stopped; the snapshot files are as they were and nothing was pushed
// (or, if the live site broke after the push, the commit was reverted).
// Steps: the three incremental snapshot scripts; each new snapshot must only grow from the old one (no block, burn,
// spend or deposit lost) and agree with Tacit's own figures; the offline tests and planted-bug tests; every main view
// built in a fresh process from the new files; then a fast-forward push (never forced) and a check of the live views.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILES = ['server/data/privacy-snapshot.json', 'server/data/evm-snapshot.json.gz', 'server/data/burn-snapshot.json'];
const DRY = process.argv.includes('--dry');
const SITE = 'https://tacitview.vercel.app';
const VIEWS = ['confidential', 'privacy', 'measured-privacy', 'evm-pools', 'bridge-state', 'bridge-burns', 'checks', 'chain-recent', 'envelopes'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const backup = new Map(FILES.map((f) => [f, readFileSync(join(ROOT, f))]));
const restore = () => { for (const [f, bytes] of backup) writeFileSync(join(ROOT, f), bytes); };
function stop(message) {
  restore();
  console.log(`\nSTOPPED: ${message}\nNothing was committed or pushed; the snapshot files are as they were.`);
  process.exit(1);
}
function run(name, args, minutes) {
  console.log(`\n== ${name}`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', timeout: minutes * 60_000 });
  if (r.status !== 0) stop(`${name}: ${r.error ? r.error.message : `exit ${r.status}`}`);
}
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// What each snapshot holds, for the before/after comparison.
function read(bytesOf) {
  const p = JSON.parse(bytesOf(FILES[0]));
  const e = JSON.parse(gunzipSync(bytesOf(FILES[1])));
  const b = JSON.parse(bytesOf(FILES[2]));
  return {
    privacy: { next: p.nextBlock, spends: p.spends, height: p.chain.height, blocks: p.chain.blocks, mints: p.mints.length, pairs: p.pairs.length, counts: p.counts, madeAt: p.madeAt },
    evm: { pool: e.pool, chains: Object.fromEntries(Object.entries(e.chains).map(([id, c]) => [id, { through: c.through, deposits: c.deposits[0].length, withdrawals: c.withdrawals[0].length }])) },
    burn: { through: b.through, launch: b.launch, binding: b.binding, txids: new Set(b.burns.map((x) => x.txid)), mine: b.burns.filter((x) => x.binding === b.binding).length,
      mineTo: (h) => b.burns.filter((x) => x.binding === b.binding && x.height <= h).length },
  };
}

// 1. Preflight: a clean public checkout of main, level with GitHub. Never runs the push on the private working copy.
if (!DRY) {
  if (git('ls-files', 'CLAUDE.md', 'AGENTS.md', 'docs/context')) stop('this checkout holds private files; only the public repo is pushed from here');
  if (git('status', '--porcelain', '--untracked-files=no')) stop('the working tree has uncommitted changes');
  git('fetch', '-q', 'origin', 'main');
  git('checkout', '-q', '-B', 'main', 'origin/main');
  for (const f of FILES) backup.set(f, readFileSync(join(ROOT, f)));
}
const before = read((f) => backup.get(f));

// 2. The three incremental scans (each reads only the blocks after its snapshot).
run('Ethereum pool snapshot', ['scripts/privacy-snapshot.mjs'], 10);
run('EVM pool snapshot', ['scripts/evm-snapshot.mjs', '--update'], 20);
run('Bitcoin bridge burn snapshot', ['scripts/burn-snapshot.mjs'], 30);

// 3. Each snapshot only grows, and agrees with Tacit's figures.
console.log('\n== Checks');
let after;
try { after = read((f) => readFileSync(join(ROOT, f))); } catch (error) { stop(`a new snapshot does not parse: ${error.message}`); }
const problems = [];
const grows = (label, a, b) => { if (!(Number.isFinite(b) && b >= a)) problems.push(`${label} went from ${a} to ${b}`); };
const p0 = before.privacy, p1 = after.privacy;
grows('privacy next block', p0.next, p1.next); grows('privacy spends', p0.spends, p1.spends); grows('Tacit chain height', p0.height, p1.height);
grows('bridge mints', p0.mints, p1.mints); grows('traced pairs', p0.pairs, p1.pairs);
for (const k of Object.keys(p0.counts || {})) grows(`pool count ${k}`, p0.counts[k], p1.counts?.[k]);
const newHash = new Map(p1.blocks.map((x) => [x.height, x.hash]));
for (const x of p0.blocks) if (newHash.has(x.height) && newHash.get(x.height) !== x.hash) problems.push(`Tacit chain block ${x.height} changed hash`);
if (after.evm.pool !== before.evm.pool) problems.push('EVM pool address changed');
for (const [id, c0] of Object.entries(before.evm.chains)) {
  const c1 = after.evm.chains[id];
  if (!c1) { problems.push(`EVM chain ${id} missing`); continue; }
  grows(`chain ${id} through`, c0.through, c1.through); grows(`chain ${id} deposits`, c0.deposits, c1.deposits); grows(`chain ${id} withdrawals`, c0.withdrawals, c1.withdrawals);
}
const b0 = before.burn, b1 = after.burn;
grows('burn snapshot block', b0.through, b1.through);
if (b1.launch !== b0.launch || b1.binding !== b0.binding) problems.push('burn snapshot launch or binding changed');
for (const t of b0.txids) if (!b1.txids.has(t)) { problems.push(`burn ${t} dropped`); break; }
const [tip, status] = await Promise.all([
  fetch('https://blockstream.info/api/blocks/tip/height', { signal: AbortSignal.timeout(20_000) }).then((r) => r.text()).then(Number).catch(() => null),
  getJson('https://api.tacit.finance/reflection/status').catch(() => null),
]);
if (tip && b1.through > tip - 6) problems.push(`burn snapshot reaches block ${b1.through}, within 6 of the tip ${tip}`);
// Tacit counts up to its own head, a few blocks past ours: close, not equal.
if (status) {
  // Tacit counts burns up to its SP1-attested height, which can lag ours by days: compare at that height.
  // If it is past our snapshot, ours is only a lower bound there.
  const at = Number(status.attestedHeight), theirs = Number(status.bridgeBurns);
  const ours = at <= b1.through ? b1.mineTo(at) : b1.mine;
  if (at <= b1.through ? Math.abs(theirs - ours) > 25 : ours > theirs + 25) problems.push(`burns for this pool ${ours} through block ${Math.min(at, b1.through)}, Tacit says ${theirs} through ${at}`);
  if (Math.abs(Number(status.bridgeMinted) - p1.mints) > 25) problems.push(`bridge mints ${p1.mints}, Tacit says ${status.bridgeMinted}`);
} else console.log('  Tacit /reflection/status did not answer: skipped the comparison with Tacit (chain checks still apply)');
if (problems.length) stop(`checks failed:\n  ${problems.join('\n  ')}`);
console.log(`  ok: privacy through ${p1.next - 1}, ${p1.mints} mints; burns through ${b1.through} (${b1.mine} for this pool); EVM ${Object.entries(after.evm.chains).map(([id, c]) => `${id}:${c.through}`).join(' ')}`);
const changed = FILES.filter((f) => !readFileSync(join(ROOT, f)).equals(backup.get(f)));
if (!changed.length) { console.log('\nNothing new: no commit.'); process.exit(0); }

// 4. Tests, then every main view built in a fresh process from the new files.
run('Offline tests', ['--test', 'test/offline.cjs'], 5);
run('Planted-bug tests', ['test/mutants.mjs'], 10);
console.log('\n== Views from the new snapshots');
const probe = `const { getView } = require(${JSON.stringify(join(ROOT, 'server/views.cjs'))});
getView(process.argv[1]).then((r) => { console.log(JSON.stringify({ ok: true, partial: Boolean(r.data?.partial || r.data?.asOf?.partial) })); process.exit(0); },
  (e) => { console.log(JSON.stringify({ ok: false, status: e.status || 500, message: String(e.message).slice(0, 200) })); process.exit(0); });`;
let slow = 0;
for (const v of VIEWS) {
  let out;
  for (let k = 0; k < 3; k++) {
    const r = spawnSync(process.execPath, ['-e', probe, `/views/${v}`], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    try { out = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { out = { ok: false, status: 500, message: `no answer (${r.error?.message || `exit ${r.status}`})` }; }
    if (out.ok || ![502, 503, 504].includes(out.status)) break;
  }
  console.log(`  ${v}: ${out.ok ? (out.partial ? 'ok (partial)' : 'ok') : `${out.status} ${out.message}`}`);
  // A code error from the new data stops the run; a slow network here (502-504) only counts against a limit.
  if (!out.ok && ![502, 503, 504].includes(out.status)) stop(`view ${v} failed: ${out.message}`);
  if (!out.ok) slow += 1;
}
if (slow > 2) stop(`${slow} views timed out here; not sure enough to push`);

if (DRY) { restore(); console.log('\nDry run: all checks passed; the old snapshot files are back.'); process.exit(0); }

// 5. Live views before the push, so only a view that was fine and then broke counts against this change.
async function live() {
  const out = {};
  for (const v of VIEWS) {
    out[v] = false;
    for (let k = 0; k < 3 && !out[v]; k++) {
      try { out[v] = (await fetch(`${SITE}/api/views/${v}`, { signal: AbortSignal.timeout(25_000) })).ok; } catch { /* retried */ }
      if (!out[v]) await sleep(15_000);
    }
  }
  return out;
}
const liveBefore = await live();

// 6. Commit the three files only and fast-forward main (a rejected push changes nothing on GitHub).
console.log('\n== Commit and push');
const id = (key, fallback) => { try { return git('config', key) || fallback; } catch { return fallback; } };
const who = ['-c', `user.name=${id('user.name', 'Tuan Hung Nguyen')}`, '-c', `user.email=${id('user.email', '240219653+hungraw@users.noreply.github.com')}`];
git('add', '--', ...changed);
git(...who, 'commit', '-q', '-m', `Snapshots refreshed (daily job)\n\nPrivacy through block ${p1.next - 1}, burns through ${b1.through}, EVM ${Object.entries(after.evm.chains).map(([i, c]) => `${i}:${c.through}`).join(' ')}.`);
try { git('push', '-q', 'origin', 'HEAD:main'); } catch (error) { console.log(`\nSTOPPED: push refused (${String(error.message).split('\n')[0]}). GitHub is unchanged.`); process.exit(1); }
console.log(`  pushed ${git('rev-parse', '--short', 'HEAD')}`);

// 7. Wait for the deploy, then the live views: one that answered before and does not now reverts the commit.
await sleep(150_000);
const liveAfter = await live();
const broke = VIEWS.filter((v) => liveBefore[v] && !liveAfter[v]);
if (broke.length) {
  git(...who, 'revert', '--no-edit', 'HEAD');
  try { git('push', '-q', 'origin', 'HEAD:main'); } catch { /* reported below */ }
  console.log(`\nREVERTED: after the deploy these views stopped answering: ${broke.join(', ')}. The commit was reverted and pushed.`);
  process.exit(1);
}
console.log(`\nDone: live views answering: ${VIEWS.filter((v) => liveAfter[v]).length} of ${VIEWS.length}.`);

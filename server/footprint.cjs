// Footprint lookup: classify a query, then collect every public trace the allowlisted sources expose.
// "Public footprint only": nothing here can reveal amounts or owners hidden by the protocol.

const { getUpstream } = require('./upstream.cjs');
const { decodeTx } = require('./envelope.cjs');
const { esplora } = require('./bitcoin.cjs');
const { cached } = require('./upstream.cjs');
const { rpc } = require('./rpc.cjs');
const { resolveName, reverseNames, systemFor, SYSTEMS } = require('./names.cjs');
const { decodeTacitAddress } = require('./tacit-address.cjs');

// Known Tacit contracts (docs/DEPLOYMENTS.md in src-company/tacit). Lowercased.
const CONTRACTS = Object.fromEntries(Object.entries({
  ConfidentialPool: '0x000000000Ed1eabD231Be41d93b719056F7febFC',
  'EVM pool': '0x000000c2A20657CE25f2Ba99737933D031AFBEE9',
  'EVM pool router': '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5',
  CollateralEngine: '0x000000003f608BDdF0ca45934003ffb9DbDF70DB',
  CanonicalAssetFactory: '0x0000000042c2D57499Df64BAF81bfA2C6E100535',
  TacitPublicAmm: '0x00000000E36C7EC997CC59DCda9E03673B448119',
  ConfidentialRouter: '0x000000005dA3E3B73726af3c774Deeb9472D4992',
  TacitRelayer: '0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3',
  BtcCallExecutor: '0x00000000Df8263Ac5810C53B31AaE20ee53C247f',
  EthCallOutbox: '0x00000000a26a6E291972666a9687741dBa11Af46',
  TacitAmmRoute: '0x00000065e3e51af95d330fb6932cA3E87912c554',
  BitcoinLightRelay: '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0',
  TAC: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279',
  wTAC: '0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf',
  tacBTC: '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696',
  tacUSD: '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564',
  FarmManager: '0x000031C47Cb61faB1CE2790a69625FABB71EDE24',
  'TAC/ETH pool': '0x0155358241411dB868BA714aE7c83A27087e3D6E',
  ProofMarket: '0x0000000033Dd45B1686Ba37e5F6e4ABDdaC17609',
  TacitGasRelay: '0x000000197E8f0B64463B2010e568fF42090Af88d',
  // Relay wallets that settle for users (worker/src/relay-economics.js): a relayed tx's sender is Tacit, not the user.
  'Tacit settle relayer': '0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331',
  'Tacit relay wallet': '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7',
}).map(([name, address]) => [address.toLowerCase(), name]));
const CHAINS = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood' };
const EXPLORERS = { 1: 'https://etherscan.io', 8453: 'https://basescan.org', 4663: 'https://explorer.mainnet.chain.robinhood.com' };

function classifyQuery(input) {
  const q = String(input ?? '').trim();
  if (!q) return { kind: 'empty', q };
  if (/^[0-9a-f]{64}$/i.test(q)) return { kind: 'btc-txid-or-asset', q: q.toLowerCase() };
  if (/^0x[0-9a-f]{64}$/i.test(q)) return { kind: 'eth-tx', q: q.toLowerCase() };
  if (/^0x[0-9a-f]{40}$/i.test(q)) return { kind: 'evm-address', q: q.toLowerCase() };
  if (/^0x/i.test(q)) return { kind: 'unknown', q, hint: 'Malformed 0x input: expected a 40-hex address or 64-hex tx hash.' };
  if (/^(tacit|tactt|tacrt)1[02-9ac-hj-np-z]{6,}$/i.test(q)) return { kind: 'tacit-address', q };
  if (systemFor(q)) return { kind: 'name', q: q.toLowerCase() }; // name@xns, *.eth, *.wei, *.gwei, *.base.eth
  if (/^[a-z0-9][a-z0-9-]{0,63}$/i.test(q)) return { kind: 'name-or-ticker', q };
  return { kind: 'unknown', q };
}

const fmtTime = (seconds) => (Number.isFinite(Number(seconds)) ? new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z') : null);
const safe = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

async function assetsList() {
  const { data } = await getUpstream('/assets', '?network=mainnet', { ttlMs: 60_000 });
  return (data.assets || []).filter((asset) => asset.network === 'mainnet');
}

function assetItem(asset) {
  return { title: `Asset ${asset.ticker || ''}${asset.verified ? ' (verified)' : ' (unverified)'}`, source: '/assets?network=mainnet', rows: [
    ['Asset id', asset.asset_id], ['Ticker', asset.ticker], ['Verified by indexer', asset.verified ? 'yes' : 'no'], ['Decimals', asset.decimals],
    ['Etch tx', asset.etch_txid, asset.etch_txid ? `https://mempool.space/tx/${asset.etch_txid}` : null], ['Etched at height', asset.etched_at_height],
    ['Holders / transfers', `${asset.holder_count ?? '—'} / ${asset.transfer_count ?? '—'}`], ['Mintable', asset.mintable],
    ['Supply', asset.attestation?.supply != null ? `${asset.attestation.supply} base units (published by the issuer)` : 'not published (Pedersen commitment)'],
  ] };
}

async function bitcoin(q, out) {
  const [assets, tx, recent] = await Promise.all([
    safe(assetsList()),
    safe(cached(`btc:tx:${q}`, () => esplora(`/tx/${q}`), { ttlMs: (t) => (t?.status?.confirmed ? 24 * 3600_000 : 30_000), staleMs: 24 * 3600_000 })),
    safe(getUpstream('/recent-cxfer-txids', '?network=mainnet', { ttlMs: 15_000 })),
  ]);
  out.sources.push('/assets?network=mainnet', 'Esplora /tx/<txid>', '/recent-cxfer-txids?network=mainnet');
  const asset = assets.value?.find((a) => a.asset_id === q);
  if (asset) out.items.push(assetItem(asset));
  const etched = assets.value?.find((a) => a.etch_txid === q);
  if (etched) out.items.push({ title: 'Etch transaction of an asset', source: '/assets?network=mainnet', rows: [['Asset', `${etched.ticker} (${etched.asset_id})`]] });
  const t = tx.value?.data;
  if (t) {
    const envelope = decodeTx(t);
    out.items.push({ title: 'Bitcoin transaction', source: 'Esplora /tx/<txid>', rows: [
      ['Txid', t.txid, `https://mempool.space/tx/${t.txid}`],
      ['Status', t.status?.confirmed ? `confirmed in block ${t.status.block_height}` : 'unconfirmed'],
      ['Block time', fmtTime(t.status?.block_time)], ['Fee', t.fee != null ? `${t.fee} sat` : null],
      ['Tacit envelope', envelope ? `${envelope.name || 'unknown opcode'} (${envelope.opcodeHex}), ${envelope.payloadBytes}-byte payload` : 'none in vin[0]'],
      ['Inputs / outputs', `${t.vin?.length ?? '—'} / ${t.vout?.length ?? '—'}`],
    ] });
    const listed = recent.value?.data?.entries?.find((e) => e.txid === q);
    if (listed) out.items.push({ title: 'Listed as a recent confidential transfer', source: '/recent-cxfer-txids?network=mainnet', rows: [['Asset id', listed.aid], ['Seen', fmtTime(Number(listed.ts) / 1000)]] });
  } else if (tx.error && tx.error.status !== 404 && tx.error.status !== 400) out.notes.push(`Bitcoin tx lookup failed: ${tx.error.message}`);
}

async function ethTx(q, out) {
  const receipts = await Promise.all(Object.keys(CHAINS).map((chain) => safe(rpc(Number(chain), 'eth_getTransactionReceipt', [q], { ttlMs: 300_000 })).then((r) => ({ chain: Number(chain), ...r }))));
  out.sources.push('eth_getTransactionReceipt (Ethereum, Base, Robinhood public RPCs)');
  for (const { chain, value: receipt, error } of receipts) {
    if (error) { out.notes.push(`${CHAINS[chain]} RPC: ${error.message}`); continue; }
    if (!receipt) continue;
    const touched = [...new Set((receipt.logs || []).map((log) => CONTRACTS[String(log.address).toLowerCase()]).filter(Boolean))];
    const toName = CONTRACTS[String(receipt.to || '').toLowerCase()];
    out.items.push({ title: `${CHAINS[chain]} transaction`, source: `${CHAINS[chain]} RPC receipt`, rows: [
      ['Tx', q, `${EXPLORERS[chain]}/tx/${q}`], ['Status', receipt.status === '0x1' ? 'success' : 'reverted'],
      ['Block', Number.parseInt(receipt.blockNumber, 16)], ['From (public)', receipt.from], ['To', toName ? `${receipt.to} (${toName})` : receipt.to],
      ['Tacit contracts emitting logs', touched.length ? touched.join(', ') : 'none (not a Tacit transaction)'], ['Log count', (receipt.logs || []).length],
    ] });
  }
}

async function evmAddress(q, out, { knownName = null } = {}) {
  const chains = Object.keys(CHAINS).map(Number);
  const [points, name, balances] = await Promise.all([
    safe(getUpstream(`/points/${q}`, '', { ttlMs: 60_000 })),
    safe(reverseNames(q)),
    // Native balance and transactions sent (the account nonce) on each chain, straight from its RPC.
    Promise.all(chains.map((c) => Promise.all([rpc(c, 'eth_getBalance', [q, 'latest'], { ttlMs: 30_000 }), rpc(c, 'eth_getTransactionCount', [q, 'latest'], { ttlMs: 30_000 })])
      .then(([b, n]) => [CHAINS[c], BigInt(b).toString(), Number.parseInt(n, 16)], () => [CHAINS[c], null, null]))),
  ]);
  out.items.push({ title: 'Balances', source: 'eth_getBalance and eth_getTransactionCount on each chain', rows: balances });
  out.sources.push('/points/<address>', 'XNS, ENS, WNS and GNS reverse records (Ethereum RPC)');
  if (CONTRACTS[q]) out.items.push({ title: 'Known Tacit contract', source: 'docs/DEPLOYMENTS.md', rows: [['Contract', CONTRACTS[q]], ['Address', q, `https://etherscan.io/address/${q}`]] });
  const names = (name.value || []).filter((n) => n.name !== knownName);
  if (names.length) out.items.push({ title: 'Names', source: 'reverse records, each checked forward', rows: names.map((n) => [SYSTEMS[n.system].label, n.name, n.url]) });
  else if (name.error) out.notes.push(`Name lookup failed: ${name.error.message}`);
  const p = points.value?.data;
  if (p && (p.deposit_count > 0 || p.points > 0)) {
    out.items.push({ title: 'EVM pool deposits', source: '/points/<address>', rows: [
      ['Deposits', p.deposit_count], ['Total deposited', `${p.amount_wei} wei`, null, { wei: p.amount_wei }], ['Points', p.points],
    ], list: (p.deposits || []).slice(0, 100).map((d) => ({
      label: `${CHAINS[d.chain_id] || `chain ${d.chain_id}`} · ${d.activity || 'deposit'}`, detail: fmtTime(d.block_time), wei: d.amount_wei,
      href: EXPLORERS[d.chain_id] ? `${EXPLORERS[d.chain_id]}/tx/${d.tx_hash}` : null, id: d.tx_hash,
      chain: CHAINS[d.chain_id] || null, activity: d.activity || 'deposit', time: d.block_time ?? null, points: d.points ?? null,
    })) });
  } else if (p) out.notes.push('No EVM pool deposits.');
  else if (points.error) out.notes.push(`Points lookup failed: ${points.error.message}`);
}

async function name(q, out, { tickers }) {
  const target = systemFor(q); // bare labels are tickers only
  const [addr, assets] = await Promise.all([target ? safe(resolveName(q)) : Promise.resolve({}), tickers ? safe(assetsList()) : Promise.resolve({ value: [] })]);
  if (tickers) {
    out.sources.push('/assets?network=mainnet');
    const matches = (assets.value || []).filter((a) => String(a.ticker || '').toLowerCase() === q.toLowerCase())
      .sort((a, b) => Number(Boolean(b.verified)) - Number(Boolean(a.verified)));
    for (const asset of matches) out.items.push(assetItem(asset));
    if (matches.length > 1) out.notes.push(`${matches.length} assets share this ticker. Verified first.`);
    if (!matches.length && !target) out.notes.push(`No asset with ticker "${q}". Names need their suffix: name@xns, name.eth, name.wei, name.gwei, name.base.eth.`);
  }
  if (!target) return;
  const label = SYSTEMS[target.system].label;
  out.sources.push(`${label} (${target.system === 'base' ? 'Base' : 'Ethereum'} RPC)`);
  if (addr.error) { out.notes.push(`${label} lookup failed: ${addr.error.message}`); return; }
  if (!addr.value?.address) { out.notes.push(`No ${label} name "${q}".`); return; }
  out.items.push({ title: 'Name', source: label, rows: [['Name', q, addr.value.url], ['Service', label], ['Address', addr.value.address, `https://etherscan.io/address/${addr.value.address}`]] });
  await evmAddress(addr.value.address, out, { knownName: q });
}

function tacitAddress(q, out) {
  const decoded = decodeTacitAddress(q);
  out.sources.push('local bech32m decode (layout from dapp/tacit-address.js)');
  if (!decoded.ok) { out.notes.push(`Invalid tacit address: ${decoded.error}.`); return; }
  out.items.push({ title: 'Unified Tacit address', source: 'decoded locally', rows: [
    ['Network', decoded.network], ['Bitcoin address', decoded.bitcoinAddress], ['Lanes', decoded.lanes.join(', ')], ['Pool address', decoded.poolAddress], ['Flags', `0x${decoded.flags.toString(16).padStart(2, '0')}`],
    ...Object.entries(decoded.keys || {}),
  ] });
  out.notes.push("Amounts paid to it are encrypted. On Bitcoin, Tacit's app pays its plain Bitcoin address, which is public and linked; stealth there is opt-in (tcs1…). Pool payments to it arrive as stealth locks.");
}

async function footprint(query) {
  const { kind, q } = classifyQuery(query);
  const out = { view: 'footprint', query: String(query ?? '').trim(), kind, publicOnly: true, sources: [], items: [], notes: [], asOf: { fetchedAt: Date.now() } };
  if (kind === 'btc-txid-or-asset') await bitcoin(q, out);
  else if (kind === 'eth-tx') await ethTx(q, out);
  else if (kind === 'evm-address') await evmAddress(q, out);
  else if (kind === 'name') await name(q, out, { tickers: false });
  else if (kind === 'name-or-ticker') await name(q, out, { tickers: true });
  else if (kind === 'tacit-address') tacitAddress(q, out);
  else out.notes.push(classifyQuery(query).hint || 'Not recognised. Try a txid, 0x hash or address, tacit1…, a name (name@xns, name.eth, name.wei) or a ticker.');
  if (!out.items.length && !out.notes.length) out.notes.push('Nothing found.');
  return out;
}

module.exports = { classifyQuery, footprint, CONTRACTS };

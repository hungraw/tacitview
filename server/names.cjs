// Name services for EVM addresses, all read with eth_call on public RPCs (no third-party name APIs).
//   XNS        label@namespace   Ethereum, 0x6e79…f74b (immutable address book)
//   ENS        *.eth and other ENS names   Ethereum, ENSv2 UniversalResolverV2 0x06fd…cfd5 (docs.ens.domains/learn/
//              deployments). resolve() and reverse(); reverse is forward-checked by the resolver itself. CCIP-read
//              (offchain) names such as cb.id revert and show as not found.
//   WNS        *.wei             Ethereum, 0x0000…42EB (z0r0z's Wei Name Service)
//   GNS        *.gwei            Ethereum, 0x9D51…81d6 (Gwei Name Service, same read interface as WNS)
//   Basenames  *.base.eth        Base registry → resolver (forward only)
// Reverse names are trusted only when the name resolves back to the same address (reverse records are not
// self-validating). Selectors computed with server/keccak.cjs.

const { keccak256 } = require('./keccak.cjs');
const { rpc, xnsAddress, xnsName, encodeString, decodeString, decodeAddress } = require('./rpc.cjs');

const word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const SEL = { computeId: 'fb021939', resolve: '4f896d4f', reverseResolve: '9af8b7aa', resolver: '0178b8bf', addr: '3b3b57de', urResolve: '9061b923', urReverse: '5d78a217' };
const ENS_UNIVERSAL = '0x06fdd07f007adac667177b46ab2eb9a75132cfd5'; // ENSv2, live since 2026-10-02
const BASE_REGISTRY = '0xb94704422c2a1e396835a571837aa5ae53285a95';
const REGISTRIES = { wns: '0x0000000000696760E15f265e828DB644A0c242EB', gns: '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6' };

const SYSTEMS = {
  xns: { label: 'XNS', url: null }, // no official profile site confirmed
  ens: { label: 'ENS', url: (n) => `https://app.ens.domains/${n}` },
  wns: { label: 'Wei Name Service', url: (n) => `https://wei.domains/#${n.replace(/\.wei$/, '')}` },
  gns: { label: 'Gwei Name Service', url: (n) => `https://gwei.domains/#${n.replace(/\.gwei$/, '')}` },
  base: { label: 'Basenames', url: (n) => `https://www.base.org/name/${n.replace(/\.base\.eth$/, '')}` },
};

function namehash(name) {
  let node = Buffer.alloc(32);
  for (const label of name.split('.').reverse()) node = Buffer.from(keccak256(Buffer.concat([node, Buffer.from(keccak256(Buffer.from(label)))])));
  return hex(node);
}

const call = (chain, to, data) => rpc(chain, 'eth_call', [{ to, data: `0x${data}` }, 'latest'], { ttlMs: 300_000 });

// ENS-style registry (Basenames on Base): registry.resolver(node) → resolver.addr(node).
async function registryAddr(chain, registry, name) {
  const node = namehash(name);
  const resolver = decodeAddress(await call(chain, registry, SEL.resolver + node));
  return resolver ? decodeAddress(await call(chain, resolver, SEL.addr + node)) : null;
}

// ENS through the Universal Resolver. Names are DNS-encoded; dynamic bytes are ABI-encoded by hand.
const pad = (h) => h.padEnd(Math.ceil(h.length / 64) * 64, '0');
const dnsEncode = (name) => hex(Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]));
const bytesArg = (h) => word((h.length / 2).toString(16)) + pad(h);
async function ensAddr(name) {
  const nameArg = bytesArg(dnsEncode(name));
  const dataArg = bytesArg(SEL.addr + namehash(name));
  try {
    const r = String(await call(1, ENS_UNIVERSAL, SEL.urResolve + word('40') + word((64 + nameArg.length / 2).toString(16)) + nameArg + dataArg)).slice(2);
    const offset = Number.parseInt(r.slice(0, 64), 16) * 2; // (bytes result, address resolver)
    return decodeAddress(r.slice(offset + 64, offset + 128));
  } catch (error) {
    if (/revert/i.test(error.message)) return null; // unregistered, no resolver, or offchain (CCIP-read)
    throw error;
  }
}
async function ensReverse(address) {
  try { // reverse(bytes address, uint256 coinType 60) → (string name, address resolver, address reverseResolver)
    return decodeString(await call(1, ENS_UNIVERSAL, SEL.urReverse + word('40') + word('3c') + bytesArg(address.slice(2).toLowerCase()))) || null;
  } catch (error) {
    if (/revert/i.test(error.message)) return null;
    throw error;
  }
}

// WNS / GNS: computeId(fullName) → resolve(id); reverseResolve(address) → name.
async function nsAddr(system, name) {
  const id = word(await call(1, REGISTRIES[system], SEL.computeId + encodeString(name)));
  return /^0+$/.test(id) ? null : decodeAddress(await call(1, REGISTRIES[system], SEL.resolve + id));
}
async function nsReverse(system, address) {
  return decodeString(await call(1, REGISTRIES[system], SEL.reverseResolve + word(address))) || null;
}

const SUFFIX = [['.base.eth', 'base'], ['.gwei', 'gns'], ['.wei', 'wns']];
// Which system a typed name belongs to. Lower-case ASCII only (full ENS normalisation, ENSIP-15, is out of scope).
function systemFor(input) {
  const name = String(input || '').trim().toLowerCase();
  if (/^[a-z0-9-]{1,64}@[a-z0-9-]{1,32}$/.test(name)) return { system: 'xns', name };
  if (!/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(name)) return null;
  const hit = SUFFIX.find(([s]) => name.endsWith(s));
  return { system: hit ? hit[1] : 'ens', name };
}

async function resolveName(input) {
  const target = systemFor(input);
  if (!target) return null;
  const { system, name } = target;
  const address = system === 'xns' ? await xnsAddress(name)
    : system === 'ens' ? await ensAddr(name)
      : system === 'base' ? await registryAddr(8453, BASE_REGISTRY, name)
        : await nsAddr(system, name);
  return { system, name, address: address ? address.toLowerCase() : null, url: profileUrl(system, name) };
}

const profileUrl = (system, name) => { const u = SYSTEMS[system]?.url; return typeof u === 'function' ? u(name) : u || null; };

// Every verified name an address has, in display order (XNS first: it is the bounty's name system).
async function reverseNames(address) {
  const a = address.toLowerCase();
  const tries = [
    ['xns', () => xnsName(a)],
    ['ens', () => ensReverse(a)],
    ['wns', () => nsReverse('wns', a)],
    ['gns', () => nsReverse('gns', a)],
  ];
  const found = await Promise.all(tries.map(async ([system, read]) => {
    try {
      const name = await read();
      if (!name) return null;
      // Reverse names are chosen by whoever owns the address: show one only if it is plain lower-case ASCII in the
      // shape the name system uses (no zero-width or look-alike characters), so it cannot pose as a label like
      // "Tacit settle relayer" or a well-known name.
      const shape = systemFor(name);
      if (!shape || shape.name !== name || !(shape.system === system || (system === 'ens' && shape.system === 'base'))) return null;
      if (system !== 'ens') { // ENS's universal resolver already checked forward; the others are checked here
        const back = await resolveName(name);
        if (back?.address !== a) return null;
      }
      return { system, name, url: profileUrl(system, name) };
    } catch { return null; }
  }));
  return found.filter(Boolean);
}

module.exports = { resolveName, reverseNames, systemFor, namehash, SYSTEMS };

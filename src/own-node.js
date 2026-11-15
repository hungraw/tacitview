// The visitor's own Ethereum node for the block check (set in settings). Only a node on this computer: the page's
// content security policy allows no other outside address.
export const LOCAL_NODE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s]*)?$/;
export function ethNode() {
  try { const v = localStorage.getItem('tacit-explorer-eth-node'); return v && LOCAL_NODE.test(v) ? v : ''; } catch { return ''; }
}

// EVM chain adapter (Robinhood Chain / any EVM): the verifier talks to the
// Quarters.sol contract through this one object, with the same shape as the
// Solana adapter. Money units are wei (decimals 18). Score submits are BATCHED:
// a submit waits up to SUBMIT_BATCH_MS for company, then one transaction
// carries every pending run for that cabinet — gas is real money here.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { createPublicClient, createWalletClient, http, parseAbi, parseAbiParameters, encodeAbiParameters, keccak256, encodePacked, getAddress, formatEther, decodeEventLog } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { nonceManager } = require("viem/nonce");

function loadAbi() {
  const p = path.join(__dirname, "../../contracts/out/Quarters.sol/Quarters.json");
  return JSON.parse(fs.readFileSync(p, "utf8")).abi;
}

let _doorAbi = null;
function doorAbi() {
  if (!_doorAbi) _doorAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "../../contracts/out/JackpotDoor.sol/JackpotDoor.json"), "utf8")).abi;
  return _doorAbi;
}

function makeEvmChain({ rpcUrl, chainId, contract, privateKey, network, log = console.log }) {
  const abi = loadAbi();
  const chain = { id: chainId, name: "quarters-evm", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
  // One key signs submits, settles, house adds and buybacks. viem picks a nonce per call,
  // so concurrent sends race ("nonce lower than current") — seen live on Fly when a submit
  // landed mid-sweep. nonceManager tracks the nonce locally; the mutex makes sends sequential.
  const account = privateKeyToAccount(privateKey, { nonceManager });
  let sendLock = Promise.resolve();
  const serial = (fn) => { const p = sendLock.then(fn, fn); sendLock = p.catch(() => {}); return p; };
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });
  const address = getAddress(contract);
  const read = (functionName, args = []) => pub.readContract({ address, abi, functionName, args });
  const write = async (functionName, args = [], value) => {
    const hash = await serial(() => wallet.writeContract({ address, abi, functionName, args, value }));
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60000 });
    if (rc.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
    return hash;
  };
  const hex = (b) => "0x" + Buffer.from(b).toString("hex");
  const creditKey = (player, commit) => keccak256(encodePacked(["address", "bytes32"], [getAddress(player), hex(commit)]));

  let cfgCache = null;
  const api = {
    kind: "evm", network, signer: account.address, unit: { symbol: "ETH", decimals: 18 }, contract: address,
    bountyInSubmit: true,          // the contract pays a record inside submitScores
    canPreOpen: false,             // pots are mappings; nothing to open, no rent
    async config() {
      if (cfgCache && Date.now() - cfgCache.at < 30000) return cfgCache.v;
      const [verifier, treasury, quarter, potBps, operatorBps, period] = await Promise.all([read("verifier"), read("treasury"), read("quarterWei"), read("potBps"), read("operatorBps"), read("periodSeconds")]);
      cfgCache = { at: Date.now(), v: { verifier, treasury, quarter: Number(quarter), potBps, operatorBps, periodSeconds: Number(period) } };
      return cfgCache.v;
    },
    async cabinet(cab) {
      const c = await read("cabinets", [cab]);   // [game, operator, isBounty, exists, price]
      if (!c[3]) return null;
      return { game: Buffer.from(c[0].slice(2), "hex").toString("utf8").replace(/\0+$/, ""), operator: c[1], isBounty: c[2], price: Number(c[4]) };
    },
    // creditId on EVM is the credit key (0x…); the body must carry player + secret so we can re-derive it.
    async credit(creditId, body) {
      if (!body || !body.player || !body.secret) return null;
      const commit = crypto.createHash("sha256").update(Buffer.from(body.secret, "hex")).digest();
      const key = creditKey(body.player, commit);
      if (String(creditId).toLowerCase() !== key.toLowerCase()) return null;
      let c = null;
      for (let i = 0; i < 4 && !(c && c[6]); i++) { c = await read("credits", [key]); if (!c[6] && i < 3) await new Promise((r) => setTimeout(r, 1500)); }
      if (!c || !c[6]) return null;   // [player, cabinet, day, insertedAt, salt, used, exists]
      return { id: key, player: c[0], cabinet: Number(c[1]), day: Number(c[2]), insertedAt: Number(c[3]), salt: c[4].slice(2), used: c[5], commit, rentPayer: null };
    },
    potId: (cab, day) => `evm:${address.toLowerCase()}:${cab}:${day}`,   // contract-scoped: a new deployment must not inherit the old one's books
    async pot(cab, day) {
      const p = await read("potOf", [cab, day]);   // [count, settled, exists, poolWei, entries]
      if (!p[2]) return null;
      const entries = p[4].slice(0, p[0]).map((e) => ({ player: e.player, score: Number(e.score), flagged: e.flagged, replayHash: e.replayHash.slice(2) }));
      return { exists: true, settled: p[1], count: p[0], entries, pool: Number(p[3]), balance: Number(p[3]), rentPayer: null };
    },
    // floor: the contract's minimum winning score (contracts before bountyFloor have none).
    // bar = what a run must BEAT to pay — the same max() the contract applies in _submit.
    // Bounty fee feed backstop: what a Proof fee splitter owes our forwarder, and a
    // permissionless crank (claim the leg's share, forward it to the BountyFeeder).
    async forwarderPending(forwarder, splitter) {
      const ab = parseAbi(["function legOwed(address,address) view returns (uint256)"]);
      const [owed, held] = await Promise.all([
        pub.readContract({ address: getAddress(splitter), abi: ab, functionName: "legOwed", args: [getAddress(forwarder), "0x0000000000000000000000000000000000000000"] }).catch(() => 0n),
        pub.getBalance({ address: getAddress(forwarder) }),
      ]);
      return { owed: Number(owed), held: Number(held) };
    },
    async crankForwarder(forwarder, splitter) {
      const ab = parseAbi(["function crank(address splitter)"]);
      const hash = await serial(() => wallet.writeContract({ address: getAddress(forwarder), abi: ab, functionName: "crank", args: [getAddress(splitter)] }));
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60000 });
      if (rc.status !== "success") throw new Error("crank reverted " + hash);
      return hash;
    },
    // on-chain activity for the reviewer: how many transactions this wallet has ever sent, and its balance
    async walletFacts(addr) {
      const a = getAddress(addr);
      const [nonce, bal] = await Promise.all([pub.getTransactionCount({ address: a }), pub.getBalance({ address: a })]);
      return { onchainTxCount: nonce, balanceEth: Number(formatEther(bal)).toFixed(4) };
    },
    // --- THE BOUNTY's door (evm/src/JackpotDoor.sol) ---
    async doorSeat(door, commitHex) {
      const r = await pub.readContract({ address: getAddress(door), abi: doorAbi(), functionName: "seats", args: ["0x" + commitHex.replace(/^0x/, "")] });
      return { player: r[0], holder: r[1], settled: r[2] };
    },
    async doorParams(door) {
      const d = getAddress(door), rd = (fn) => pub.readContract({ address: d, abi: doorAbi(), functionName: fn });
      const [cap, nonHolderBps, refillTo, token, holdMin, reserve, retired] = await Promise.all(["cap", "nonHolderBps", "refillTo", "token", "holdMin", "reserve", "retired"].map(rd));
      return { cap: Number(cap), nonHolderBps: Number(nonHolderBps), refillTo: Number(refillTo), token, holdMin: holdMin.toString(), reserve: Number(reserve), retired };
    },
    async doorIsHolder(door, who) { return pub.readContract({ address: getAddress(door), abi: doorAbi(), functionName: "isHolder", args: [getAddress(who)] }); },
    // what a winning submit actually paid, straight from its receipt (BountyClaimed)
    async bountyPaidIn(txHash) {
      const rc = await pub.getTransactionReceipt({ hash: txHash });
      for (const lg of rc.logs) {
        if (getAddress(lg.address) !== address) continue;
        try { const ev = decodeEventLog({ abi, data: lg.data, topics: lg.topics }); if (ev.eventName === "BountyClaimed") return { player: ev.args.player, score: Number(ev.args.score), paidWei: ev.args.paidWei }; } catch (e) {}
      }
      return null;
    },
    async doorSettle(door, commitHex, receivedWei) {
      const hash = await serial(() => wallet.writeContract({ address: getAddress(door), abi: doorAbi(), functionName: "settle", args: ["0x" + commitHex.replace(/^0x/, ""), BigInt(receivedWei)] }));
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60000 });
      if (rc.status !== "success") throw new Error(`door settle reverted ${hash}`);
      return hash;
    },
    async bounty(cab) {
      const b = await read("bounties", [cab]);
      let floor = 0;
      try { floor = Number(await read("bountyFloor", [cab])); }
      catch (e) { if (!/bountyFloor|reverted|returned no data/i.test(String(e && e.message))) throw e; }
      const record = Number(b[0]);
      return { record, floor, bar: Math.max(record, floor), champion: b[1], pool: Number(b[2]) };
    },
    potRent: async () => 0,
    async now() { const b = await pub.getBlock({ blockTag: "latest" }); return Number(b.timestamp); },   // the contract enforces block time, so the daemon reads it
    async signerBalance() { return Number(await pub.getBalance({ address: account.address })); },
    async gasPriceGwei() { return Number(await pub.getGasPrice()) / 1e9; },
    // --- batched submits ---
    _queue: new Map(),   // cab → { subs: [{sub, resolve, reject}], timer }
    submit(cab, s) {
      return new Promise((resolve, reject) => {
        const q = api._queue.get(cab) || { subs: [], timer: null };
        q.subs.push({ sub: { player: getAddress(s.player), secret: "0x" + s.secret, score: s.score, replayHash: hex(s.replayHash), flagged: !!s.flagged }, resolve, reject });
        if (!q.timer) q.timer = setTimeout(() => api._flush(cab), parseInt(process.env.SUBMIT_BATCH_MS || "1500", 10));
        if (q.subs.length >= 20) { clearTimeout(q.timer); q.timer = null; api._flush(cab); }
        api._queue.set(cab, q);
      });
    },
    async _flush(cab) {
      const q = api._queue.get(cab); if (!q || !q.subs.length) return; api._queue.delete(cab);
      try {
        const hash = await write("submitScores", [cab, q.subs.map((x) => x.sub)]);
        for (const x of q.subs) x.resolve({ txSig: hash, batched: q.subs.length });
      } catch (e) {
        // one bad run must not sink the batch: retry singly so the good ones land
        if (q.subs.length > 1) { for (const x of q.subs) { try { x.resolve({ txSig: await write("submitScores", [cab, [x.sub]]), batched: 1 }); } catch (e2) { x.reject(e2); } } }
        else q.subs[0].reject(e);
      }
    },
    async settle(cab, day) { return { txSig: await write("settlePot", [cab, day]) }; },
    isDayNotOver: (err) => /day not over/i.test(String(err)),
    async preOpen() { return false; },
    async houseAdd(cab, day, amount) { return await write("addToPot", [cab, day], BigInt(amount)); },
    async clearFlag(cab, day, index) { return await write("clearFlag", [cab, day, index]); },
    fmt: (v) => formatEther(BigInt(Math.floor(v))),
    // ---- sponsored cabinets / buyback lane ----
    async sponsor(cab) { const sp = await read("sponsors", [cab]); return sp[1] && !/^0x0+$/.test(sp[1]) ? { token: sp[0], vault: sp[1], buybackBps: Number(sp[2]) } : null; },
    async buybackAccrued(cab) { return Number(await read("buybackPool", [cab])); },
    async withdrawBuyback(cab) { return await write("withdrawBuyback", [cab]); },
    // Buy the sponsor's token with ETH. Three venues, picked from the token's own
    // launch record so a pad-launched coin works at every stage of its life:
    //   1. Pons/ProofLaunch coin, graduated  → Uniswap v4 via the Universal Router
    //      (pons pools live on the pons PoolManager behind the memeHook; native ETH
    //      is currency0, poolFee 0, tickSpacing 200 — the hook takes the fee)
    //   2. Pons coin, still on its bonding curve → buy straight off the curve
    //   3. anything else → Uniswap v3 exactInputSingle (the original path)
    async ponsInfo(token) {
      // Robinhood Chain defaults (pons V2 live factory; verified on-chain 2026-09-25)
      const factory = process.env.EVM_PONS_FACTORY || (chainId === 4663 ? "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" : null);
      if (!factory) return null;
      const abi = parseAbi([
        "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
        "function getLaunchedToken(address token) view returns (LaunchedToken)",
      ]);
      try {
        const i = await pub.readContract({ address: getAddress(factory), abi, functionName: "getLaunchedToken", args: [getAddress(token)] });
        if (!i.exists) return null;
        // curves quoted in a non-ETH pair token can't be fed by this lane
        if (i.pairToken && !/^0x0+$/.test(i.pairToken)) return { unsupported: "pairToken is not ETH" };
        let graduated = false;
        try { graduated = await pub.readContract({ address: i.curve, abi: parseAbi(["function graduated() view returns (bool)"]), functionName: "graduated" }); } catch (e) {}
        return { curve: i.curve, poolFee: Number(i.poolFee), tickSpacing: Number(i.tickSpacing), graduated };
      } catch (e) { return null; }
    },
    async buyTokenV4(token, amountWei, minOut, info) {
      const router = process.env.EVM_UNIVERSAL_ROUTER || "0x8876789976decbfcbbbe364623c63652db8c0904";
      const hook = process.env.EVM_MEME_HOOK || "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
      const poolKey = { currency0: "0x0000000000000000000000000000000000000000", currency1: getAddress(token),
        fee: info && info.poolFee !== undefined ? info.poolFee : 0,
        tickSpacing: info && info.tickSpacing ? info.tickSpacing : 200, hooks: getAddress(hook) };
      // Universal Router: one V4_SWAP command carrying SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL
      const V4_SWAP = "0x10", ACTIONS = "0x060c0f";
      const keyType = "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
      const swapParams = encodeAbiParameters(
        parseAbiParameters(`(${keyType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`),
        [{ poolKey, zeroForOne: true, amountIn: BigInt(amountWei), amountOutMinimum: BigInt(minOut || 0), hookData: "0x" }]);
      const settle = encodeAbiParameters(parseAbiParameters("address,uint256"), [poolKey.currency0, BigInt(amountWei)]);
      const take = encodeAbiParameters(parseAbiParameters("address,uint256"), [poolKey.currency1, BigInt(minOut || 0)]);
      const input = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [ACTIONS, [swapParams, settle, take]]);
      const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
      const hash = await serial(() => wallet.writeContract({ address: getAddress(router), abi: routerAbi, functionName: "execute",
        args: [V4_SWAP, [input], BigInt(Math.floor(Date.now() / 1000) + 600)], value: BigInt(amountWei) }));
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90000 });
      if (rc.status !== "success") throw new Error("v4 swap reverted " + hash);
      return { txSig: hash, venue: "uniswap-v4" };
    },
    async buyTokenCurve(curve, amountWei, minOut) {
      const abi = parseAbi(["function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)"]);
      const hash = await serial(() => wallet.writeContract({ address: getAddress(curve), abi, functionName: "buy",
        args: [BigInt(amountWei), BigInt(minOut || 0), account.address], value: BigInt(amountWei) }));
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90000 });
      if (rc.status !== "success") throw new Error("curve buy reverted " + hash);
      return { txSig: hash, venue: "pons-curve" };
    },
    async buyToken(token, amountWei, minOut = 0n) {
      const info = await api.ponsInfo(token);
      if (info && info.unsupported) throw new Error("cannot buy this token: " + info.unsupported);
      if (info) return info.graduated ? await api.buyTokenV4(token, amountWei, minOut, info)
                                      : await api.buyTokenCurve(info.curve, amountWei, minOut);
      const router = process.env.EVM_SWAP_ROUTER, weth = process.env.EVM_WETH, factory = process.env.EVM_V3_FACTORY;
      if (!router || !weth || !factory) throw new Error("swap not configured (EVM_SWAP_ROUTER / EVM_WETH / EVM_V3_FACTORY)");
      const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
      let fee = 0; for (const f of [10000, 3000, 500, 100]) { const pool = await pub.readContract({ address: getAddress(factory), abi: factoryAbi, functionName: "getPool", args: [getAddress(weth), getAddress(token), f] }); if (pool && !/^0x0+$/.test(pool)) { fee = f; break; } }
      if (!fee) throw new Error("no v3 pool for token " + token);
      const routerAbi = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)"]);
      const hash = await serial(() => wallet.writeContract({ address: getAddress(router), abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: getAddress(weth), tokenOut: getAddress(token), fee, recipient: account.address, amountIn: BigInt(amountWei), amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }], value: BigInt(amountWei) }));
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90000 });
      if (rc.status !== "success") throw new Error("swap reverted " + hash);
      return { txSig: hash, fee, venue: "uniswap-v3" };
    },
    async sendEth(to, amountWei) { const hash = await serial(() => wallet.sendTransaction({ to: getAddress(to), value: BigInt(amountWei) })); await pub.waitForTransactionReceipt({ hash, timeout: 90000 }); return hash; },
    async gasBps() { return Number(await read("gasBps")); },
    async tokenBalance(token) { return await pub.readContract({ address: getAddress(token), abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [account.address] }); },
    async sendToken(token, to, amount) {
      const hash = await serial(() => wallet.writeContract({ address: getAddress(token), abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [getAddress(to), BigInt(amount)] }));
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90000 }); if (rc.status !== "success") throw new Error("token transfer reverted"); return hash;
    },
  };
  log(`evm adapter: chain ${chainId} contract ${address} signer ${account.address}`);
  return api;
}
module.exports = makeEvmChain;

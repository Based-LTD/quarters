// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// QUARTERS on an EVM chain (Robinhood Chain). Same shape as the Anchor program:
/// cabinets, a per-cabinet per-period pot, seed-committed credits, verifier-signed
/// score submission (batched: gas on this chain is real money), permissionless
/// settlement after the period + grace, a winner-takes-all bounty per cabinet,
/// and session tabs so a player signs once per pack. Payouts that cannot be
/// delivered (contract wallets that revert) are held for pull-withdrawal so a
/// single bad recipient can never block a pot.
contract QuartersV2 {
    // ---------- config ----------
    address public authority;
    address public verifier;
    address payable public treasury;
    uint256 public quarterWei;
    uint16 public potBps;        // 7000
    uint16 public operatorBps;   // 1500 (remainder → treasury)
    uint32 public periodSeconds; // 86400

    uint256 public constant SUBMIT_WINDOW = 1200;   // s after insert to land a score
    uint256 public constant MAX_GRACE = 1260;       // settle waits period end + min(1260, period/4)
    // Payout table: bps per rank (1st, 2nd, ...), set by the authority. Every
    // pot locks the table that was current when it opened, so a change never
    // reaches a day that already has coins in it. Ranks count honest runs only:
    // a flagged run holds no seat, so the next honest run moves up.
    uint16[][] internal tables;
    uint16 public currentTable;

    // ---------- storage ----------
    struct Cabinet { bytes16 game; address payable operator; bool isBounty; bool exists; uint256 price; } // price 0 → quarterWei
    struct Credit { address player; uint8 cabinet; uint32 day; uint64 insertedAt; bytes8 salt; bool used; bool exists; }
    struct Entry { address player; uint32 score; bool flagged; bytes32 replayHash; }
    struct Pot { uint8 count; bool settled; bool exists; uint16 table; uint256 poolWei; Entry[10] entries; }
    struct Bounty { uint32 record; address champion; uint256 poolWei; }
    struct Tab { uint256 balance; address sessionKey; }
    struct Submission { address player; bytes32 secret; uint32 score; bytes32 replayHash; bool flagged; }

    mapping(uint8 => Cabinet) public cabinets;
    mapping(bytes32 => Credit) public credits;                 // key = keccak256(player, seedCommit)
    mapping(uint8 => mapping(uint32 => Pot)) internal pots;
    mapping(uint8 => Bounty) public bounties;
    /// A posted target the first claim must beat. Lets the house advertise a real bar
    /// ("beat 12,000") without faking a run to set one, which is the only other way to
    /// raise a record from zero. Visible on chain, only ever set by the authority.
    mapping(uint8 => uint32) public bountyFloor;
    mapping(address => Tab) public tabs;
    mapping(address => uint256) public owed;                   // undeliverable payouts, pull-withdrawable
    // Sponsored cabinets: a slice of every quarter (taken from the HOUSE share, never the
    // pot) accrues here for the buyback vault, which market-buys the sponsor's token and
    // hands the bag to the day's #1. Everything is on-chain and event-logged.
    struct Sponsor { address token; address vault; uint16 buybackBps; }
    mapping(uint8 => Sponsor) public sponsors;
    mapping(uint8 => uint256) public buybackPool;
    // Gas leg: a fixed slice of every quarter (out of the house share) goes to the
    // verifier so it funds its own submits, settles, house adds and buyback swaps.
    // The daemon sweeps anything above its float cap back to the treasury.
    uint16 public gasBps;

    // ---------- events ----------
    event CoinInserted(address indexed player, uint8 indexed cabinet, uint32 indexed day, bytes32 seedCommit, bytes8 salt, uint256 price);
    event ScoreSubmitted(uint8 indexed cabinet, uint32 indexed day, address indexed player, uint32 score, bytes32 replayHash, bool flagged);
    event PotSettled(uint8 indexed cabinet, uint32 indexed day, uint256 poolWei, uint256 paidWei, uint8 players);
    event PayoutTableSet(uint16 indexed table, uint16[] bps);
    event BountyClaimed(uint8 indexed cabinet, address indexed player, uint32 score, uint256 paidWei);
    event BountyFloorSet(uint8 indexed cabinet, uint32 floorScore);
    event FlagCleared(uint8 indexed cabinet, uint32 indexed day, uint8 index);
    event TabOpened(address indexed player, address sessionKey, uint256 balance);
    event TabClosed(address indexed player, uint256 returned);
    event Paid(address indexed to, uint256 wei_, bool delivered);
    event SponsorSet(uint8 indexed cabinet, address token, address vault, uint16 buybackBps);
    event GasLegSet(uint16 gasBps);
    event BuybackAccrued(uint8 indexed cabinet, uint256 wei_);
    event BuybackWithdrawn(uint8 indexed cabinet, address vault, uint256 wei_);

    modifier onlyAuthority() { require(msg.sender == authority, "authority"); _; }
    modifier onlyVerifier() { require(msg.sender == verifier, "verifier"); _; }

    constructor(address _verifier, address payable _treasury, uint256 _quarterWei, uint16 _potBps, uint16 _operatorBps, uint32 _period, uint16[] memory _payout) {
        require(_potBps + _operatorBps <= 10000, "bps");
        authority = msg.sender; verifier = _verifier; treasury = _treasury;
        quarterWei = _quarterWei; potBps = _potBps; operatorBps = _operatorBps; periodSeconds = _period;
        _setTable(_payout);
    }

    // ---------- admin ----------
    function updateConfig(address _verifier, address payable _treasury, uint256 _quarterWei, uint16 _potBps, uint16 _operatorBps, uint32 _period) external onlyAuthority {
        require(_potBps + _operatorBps <= 10000, "bps");
        verifier = _verifier; treasury = _treasury; quarterWei = _quarterWei; potBps = _potBps; operatorBps = _operatorBps; periodSeconds = _period;
    }
    function setAuthority(address a) external onlyAuthority { authority = a; }
    /// New payout table for pots that open from now on. 1-10 ranks, summing to 10000 bps.
    function setPayoutTable(uint16[] calldata bps) external onlyAuthority { _setTable(bps); }
    function _setTable(uint16[] memory bps) internal {
        require(bps.length > 0 && bps.length <= 10, "ranks");
        uint256 sum = 0; for (uint256 i = 0; i < bps.length; i++) sum += bps[i];
        require(sum == 10000, "bps");
        tables.push(bps); currentTable = uint16(tables.length - 1);
        emit PayoutTableSet(currentTable, bps);
    }
    function setBountyFloor(uint8 cab, uint32 floorScore) external onlyAuthority {
        require(cabinets[cab].exists && cabinets[cab].isBounty, "not a bounty cabinet");
        bountyFloor[cab] = floorScore;
        emit BountyFloorSet(cab, floorScore);
    }

    function setGasLeg(uint16 bps) external onlyAuthority { require(bps <= 10000 - potBps - operatorBps, "bps > house share"); gasBps = bps; emit GasLegSet(bps); }
    function createCabinet(uint8 id, bytes16 game, bool isBounty) external onlyAuthority {
        require(id != 0 && !cabinets[id].exists, "cabinet");
        cabinets[id] = Cabinet({ game: game, operator: payable(authority), isBounty: isBounty, exists: true, price: 0 });
    }
    function setOperator(uint8 id, address payable op) external onlyAuthority { require(cabinets[id].exists, "cabinet"); cabinets[id].operator = op; }
    function setStakes(uint8 id, uint256 price) external onlyAuthority { require(cabinets[id].exists, "cabinet"); cabinets[id].price = price; }
    /// Sponsor a cabinet: `buybackBps` of every quarter (≤ the house share) accrues for `vault`.
    function setSponsor(uint8 id, address token, address vault, uint16 buybackBps) external onlyAuthority {
        require(cabinets[id].exists, "cabinet");
        require(buybackBps <= 10000 - potBps - operatorBps, "bps > house share");
        sponsors[id] = Sponsor({ token: token, vault: vault, buybackBps: buybackBps });
        emit SponsorSet(id, token, vault, buybackBps);
    }
    /// The vault pulls what has accrued, swaps it for the sponsor token, and pays the winner.
    function withdrawBuyback(uint8 cab) external {
        Sponsor storage sp = sponsors[cab];
        require(msg.sender == sp.vault && sp.vault != address(0), "vault");
        uint256 amt = buybackPool[cab]; require(amt > 0, "nothing accrued");
        buybackPool[cab] = 0;
        (bool ok, ) = sp.vault.call{ value: amt }(""); require(ok, "withdraw");
        emit BuybackWithdrawn(cab, sp.vault, amt);
    }
    function clearFlag(uint8 cab, uint32 day, uint8 index) external onlyAuthority {
        Pot storage p = pots[cab][day]; require(p.exists && !p.settled && index < p.count, "entry");
        p.entries[index].flagged = false; emit FlagCleared(cab, day, index);
    }

    // ---------- money in ----------
    function priceOf(uint8 cab) public view returns (uint256) { uint256 p = cabinets[cab].price; return p == 0 ? quarterWei : p; }
    function currentDay() public view returns (uint32) { return uint32(block.timestamp / periodSeconds); }

    /// One quarter: pays the price, splits it, and records a seed-committed credit.
    function insertCoin(uint8 cab, bytes32 seedCommit) external payable {
        require(msg.value == priceOf(cab), "price");
        _credit(msg.sender, cab, seedCommit, msg.value);
    }
    /// From a tab, by the session key: no popup, same money flow.
    function startRun(address player, uint8 cab, bytes32 seedCommit) external {
        Tab storage t = tabs[player];
        require(t.sessionKey == msg.sender && msg.sender != address(0), "session");
        uint256 price = priceOf(cab);
        require(t.balance >= price, "tab balance");
        t.balance -= price;
        _credit(player, cab, seedCommit, price);
    }
    function _credit(address player, uint8 cab, bytes32 seedCommit, uint256 price) internal {
        Cabinet storage c = cabinets[cab]; require(c.exists, "cabinet");
        bytes32 key = keccak256(abi.encodePacked(player, seedCommit));
        require(!credits[key].exists, "commit used");
        uint32 day = currentDay();
        Pot storage p = pots[cab][day];
        if (!p.exists) { p.exists = true; p.table = currentTable; }
        uint256 potShare = price * potBps / 10000;
        uint256 opShare = price * operatorBps / 10000;
        uint256 houseShare = price - potShare - opShare;
        if (c.isBounty) bounties[cab].poolWei += potShare; else p.poolWei += potShare;
        _pay(c.operator, opShare);
        if (gasBps > 0) { uint256 g = price * gasBps / 10000; if (g > houseShare) g = houseShare; houseShare -= g; _pay(payable(verifier), g); }
        Sponsor storage sp = sponsors[cab];
        if (sp.buybackBps > 0 && sp.vault != address(0)) {
            uint256 bb = price * sp.buybackBps / 10000; if (bb > houseShare) bb = houseShare;
            buybackPool[cab] += bb; houseShare -= bb; emit BuybackAccrued(cab, bb);
        }
        _pay(treasury, houseShare);
        // salt: unknowable when the commit was chosen (previous block hash on a 100 ms chain), so seeds can't be shopped
        bytes8 salt = bytes8(keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, player, seedCommit)));
        credits[key] = Credit({ player: player, cabinet: cab, day: day, insertedAt: uint64(block.timestamp), salt: salt, used: false, exists: true });
        emit CoinInserted(player, cab, day, seedCommit, salt, price);
    }
    /// House adds and bounty seeds: anyone may put money in.
    function addToPot(uint8 cab, uint32 day) external payable { require(cabinets[cab].exists && msg.value > 0, "add"); Pot storage p = pots[cab][day]; require(!p.settled, "settled"); if (!p.exists) { p.exists = true; p.table = currentTable; } p.poolWei += msg.value; }
    function seedBounty(uint8 cab) external payable { require(cabinets[cab].exists && cabinets[cab].isBounty && msg.value > 0, "bounty"); bounties[cab].poolWei += msg.value; }

    // ---------- tabs ----------
    /// Deposit a pack; `sessionFloat` of it is forwarded to the session key for its gas.
    function openTab(address sessionKey, uint256 sessionFloat) external payable {
        require(sessionKey != address(0) && msg.value > sessionFloat, "tab");
        Tab storage t = tabs[msg.sender];
        t.sessionKey = sessionKey; t.balance += msg.value - sessionFloat;
        if (sessionFloat > 0) _pay(payable(sessionKey), sessionFloat);
        emit TabOpened(msg.sender, sessionKey, t.balance);
    }
    function closeTab() external {
        Tab storage t = tabs[msg.sender]; uint256 bal = t.balance; t.balance = 0; t.sessionKey = address(0);
        if (bal > 0) _pay(payable(msg.sender), bal);
        emit TabClosed(msg.sender, bal);
    }

    // ---------- scores (verifier only, batched) ----------
    function submitScores(uint8 cab, Submission[] calldata subs) external onlyVerifier {
        for (uint256 i = 0; i < subs.length; i++) _submit(cab, subs[i]);
    }
    function _submit(uint8 cab, Submission calldata s) internal {
        bytes32 seedCommit = sha256(abi.encodePacked(s.secret));
        bytes32 key = keccak256(abi.encodePacked(s.player, seedCommit));
        Credit storage cr = credits[key];
        require(cr.exists && !cr.used && cr.cabinet == cab, "credit");
        require(block.timestamp <= cr.insertedAt + SUBMIT_WINDOW, "window");
        cr.used = true;
        Cabinet storage c = cabinets[cab];
        uint32 bar = bounties[cab].record;
        if (bountyFloor[cab] > bar) bar = bountyFloor[cab];
        if (c.isBounty && !s.flagged && s.score > bar) {
            Bounty storage b = bounties[cab]; uint256 pool = b.poolWei; b.poolWei = 0; b.record = s.score; b.champion = s.player;
            _pay(payable(s.player), pool);
            emit BountyClaimed(cab, s.player, s.score, pool);
        }
        Pot storage p = pots[cab][cr.day];
        require(p.exists && !p.settled, "pot");
        // insert sorted (desc) into the top 10
        uint8 n = p.count; uint8 pos = n;
        for (uint8 i = 0; i < n; i++) { if (s.score > p.entries[i].score) { pos = i; break; } }
        if (pos < 10) {
            uint8 last = n < 10 ? n : 9;
            for (uint8 i = last; i > pos; i--) p.entries[i] = p.entries[i - 1];
            p.entries[pos] = Entry({ player: s.player, score: s.score, flagged: s.flagged, replayHash: s.replayHash });
            if (n < 10) p.count = n + 1;
        }
        emit ScoreSubmitted(cab, cr.day, s.player, s.score, s.replayHash, s.flagged);
    }

    // ---------- settlement (anyone) ----------
    function grace() public view returns (uint256) { uint256 g = periodSeconds / 4; return g < MAX_GRACE ? g : MAX_GRACE; }
    function settlePot(uint8 cab, uint32 day) external {
        Pot storage p = pots[cab][day];
        require(p.exists && !p.settled, "pot");
        require(block.timestamp >= uint256(day + 1) * periodSeconds + grace(), "day not over");
        p.settled = true;
        uint256 pool = p.poolWei; p.poolWei = 0;
        uint256 presentBps = 0; uint8 n = p.count;
        uint16[] storage t = tables[p.table];
        uint8 seat = 0; for (uint8 i = 0; i < n; i++) if (!p.entries[i].flagged) presentBps += _rankBps(t, seat++);
        uint256 paid = 0; uint8 players = 0;
        if (presentBps > 0) {
            seat = 0;
            for (uint8 i = 0; i < n; i++) {
                if (p.entries[i].flagged) continue;
                uint256 amt = pool * _rankBps(t, seat++) / presentBps;
                if (amt > 0) { _pay(payable(p.entries[i].player), amt); paid += amt; players++; }
            }
        }
        if (pool - paid > 0) _pay(treasury, pool - paid);   // dust, or the whole pool when nobody played
        emit PotSettled(cab, day, pool, paid, players);
    }
    function _rankBps(uint16[] storage t, uint8 seat) internal view returns (uint256) { return seat < t.length ? uint256(t[seat]) : 0; }
    function payoutTable(uint16 table) external view returns (uint16[] memory) { return tables[table]; }
    function potTable(uint8 cab, uint32 day) external view returns (uint16[] memory) { return tables[pots[cab][day].table]; }

    // ---------- payouts ----------
    function _pay(address payable to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok, ) = to.call{ value: amt, gas: 30000 }("");
        if (!ok) owed[to] += amt;
        emit Paid(to, amt, ok);
    }
    function withdraw() external { uint256 a = owed[msg.sender]; require(a > 0, "nothing owed"); owed[msg.sender] = 0; (bool ok, ) = msg.sender.call{ value: a }(""); require(ok, "withdraw"); }

    // ---------- views ----------
    function potOf(uint8 cab, uint32 day) external view returns (uint8 count, bool settled, bool exists, uint256 poolWei, Entry[10] memory entries) {
        Pot storage p = pots[cab][day]; return (p.count, p.settled, p.exists, p.poolWei, p.entries);
    }
    function creditOf(address player, bytes32 seedCommit) external view returns (Credit memory) { return credits[keccak256(abi.encodePacked(player, seedCommit))]; }
}

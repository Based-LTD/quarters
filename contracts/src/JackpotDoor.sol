// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Quarters } from "./Quarters.sol";

interface IERC20Balance { function balanceOf(address) external view returns (uint256); }

/// THE BOUNTY's door. Every jackpot play goes through here, so the door is the
/// player of record on Quarters and receives the whole pool when a run wins.
/// It then pays the winner by status and keeps the rest for the next jackpot:
///
///   jackpot = min(pool won, CAP)                 CAP = 1 ETH
///   holder     (≥ HOLD_MIN $QTR at coin time) → 100% of the jackpot
///   non-holder                                → 25% of the jackpot
///   everything else → the reserve, which refills the next jackpot up to REFILL_TO
///
/// Status is fixed when the coin goes in, so nobody can buy in after a winning
/// run. Holding changes the payout, never the game: same target, same score.
///
/// No owner can take money out. Funds leave only as (a) a payout to the wallet
/// that inserted the winning coin, or (b) back into the Bounty pool via
/// seedBounty. Pivoting = deploying a new door; retire() sends this door's
/// whole balance back into the pool so the next door inherits it.
contract JackpotDoor {
    Quarters public immutable arcade;
    uint8 public immutable cab;
    IERC20Balance public immutable token;   // zero until $QTR exists: nobody is a holder yet
    uint256 public immutable holdMin;
    uint256 public immutable cap;
    uint16 public immutable nonHolderBps;
    uint256 public immutable refillTo;

    struct Seat { address player; bool holder; bool settled; }
    mapping(bytes32 => Seat) public seats;         // seed commit → who inserted the coin, and their status then
    mapping(address => uint256) public owed;       // payouts a wallet couldn't receive; withdraw() pulls them
    uint256 public reserve;                        // held for future jackpots
    uint256 public owedTotal;
    bool public retired;
    uint256 public retiredAt;

    event Seated(bytes32 indexed commit, address indexed player, bool holder);
    event Won(bytes32 indexed commit, address indexed player, bool holder, uint256 received, uint256 paid, uint256 kept);
    event Refilled(uint256 amount, uint256 poolAfter);
    event Retired(uint256 returnedToPool);

    error NotVerifier();
    error NotAuthority();
    error Closed();
    error SeatTaken();
    error UnknownSeat();
    error AlreadySettled();
    error NotScored();
    error TooMuch();

    constructor(Quarters arcade_, uint8 cab_, address token_, uint256 holdMin_, uint256 cap_, uint16 nonHolderBps_, uint256 refillTo_) {
        require(nonHolderBps_ <= 10_000 && cap_ > 0 && refillTo_ <= cap_, "params");
        arcade = arcade_; cab = cab_; token = IERC20Balance(token_);
        holdMin = holdMin_; cap = cap_; nonHolderBps = nonHolderBps_; refillTo = refillTo_;
    }

    /// Anyone can play. The coin goes straight into Quarters with this door as
    /// the player of record; the door remembers who you are and your status.
    function play(bytes32 seedCommit) external payable {
        if (retired) revert Closed();
        if (seats[seedCommit].player != address(0)) revert SeatTaken();
        bool holder = isHolder(msg.sender);
        seats[seedCommit] = Seat({ player: msg.sender, holder: holder, settled: false });
        arcade.insertCoin{ value: msg.value }(cab, seedCommit);
        emit Seated(seedCommit, msg.sender, holder);
    }

    function isHolder(address who) public view returns (bool) {
        return address(token) != address(0) && token.balanceOf(who) >= holdMin;
    }

    /// Quarters pays a winning door-seat's whole pool here (with a 30k gas
    /// stipend, so this stays empty). Direct sends just grow the next jackpot.
    receive() external payable {}

    /// The money this door holds that isn't the reserve or owed to someone:
    /// a jackpot that has arrived and not been settled yet.
    function unsettled() public view returns (uint256) { return address(this).balance - reserve - owedTotal; }

    /// Called by the Quarters verifier (the same key that wrote the score) once
    /// a door seat's winning run has paid out: `received` is the pool Quarters
    /// paid for that win. Pays the winner by status, keeps the rest, refills.
    function settle(bytes32 seedCommit, uint256 received) external {
        if (msg.sender != arcade.verifier()) revert NotVerifier();
        Seat storage s = seats[seedCommit];
        if (s.player == address(0)) revert UnknownSeat();
        if (s.settled) revert AlreadySettled();
        if (!arcade.creditOf(address(this), seedCommit).used) revert NotScored();
        if (received > unsettled()) revert TooMuch();
        s.settled = true;
        uint256 jackpot = received < cap ? received : cap;
        uint256 paid = s.holder ? jackpot : jackpot * nonHolderBps / 10_000;
        uint256 kept = received - paid;
        reserve += kept;
        _pay(s.player, paid);
        emit Won(seedCommit, s.player, s.holder, received, paid, kept);
        _refill();
    }

    /// Top the live jackpot back up to REFILL_TO from the reserve. Anyone can
    /// call it; it only ever moves reserve into the pool.
    function refill() external { _refill(); }

    function _refill() internal {
        if (reserve == 0) return;
        if (retired) { uint256 all = reserve; reserve = 0; arcade.seedBounty{ value: all }(cab); emit Refilled(all, _pool()); return; }
        uint256 pool = _pool();
        if (pool >= refillTo) return;
        uint256 amt = refillTo - pool; if (amt > reserve) amt = reserve;
        reserve -= amt;
        arcade.seedBounty{ value: amt }(cab);
        emit Refilled(amt, pool + amt);
    }

    /// The Quarters authority can close this door for a new one. The reserve
    /// goes back into the Bounty pool at once. A jackpot that has arrived but
    /// isn't settled yet stays for its winner (settle still works after
    /// retirement); a day later anyone can sweep whatever is left to the pool.
    function retire() external {
        if (msg.sender != arcade.authority()) revert NotAuthority();
        if (retired) revert Closed();
        retired = true; retiredAt = block.timestamp;
        uint256 back = reserve; reserve = 0;
        if (back > 0) arcade.seedBounty{ value: back }(cab);
        emit Retired(back);
    }

    /// After a retired door has had a day for its last settlements, anything
    /// still unsettled (late direct sends, dust) goes back into the pool.
    function sweep() external {
        require(retired && block.timestamp >= retiredAt + 1 days, "not yet");
        uint256 left = unsettled() + reserve; reserve = 0;
        if (left > 0) arcade.seedBounty{ value: left }(cab);
        emit Retired(left);
    }

    /// If Quarters couldn't deliver a win to this door, it holds it as owed;
    /// anyone can pull it here so it can be settled.
    function pullOwed() external { arcade.withdraw(); }

    function withdraw() external {
        uint256 a = owed[msg.sender]; require(a > 0, "nothing owed");
        owed[msg.sender] = 0; owedTotal -= a;
        (bool ok, ) = msg.sender.call{ value: a }(""); require(ok, "withdraw");
    }

    function _pay(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok, ) = to.call{ value: amt, gas: 30_000 }("");
        if (!ok) { owed[to] += amt; owedTotal += amt; }
    }

    function _pool() internal view returns (uint256 p) { (, , p) = arcade.bounties(cab); }
}

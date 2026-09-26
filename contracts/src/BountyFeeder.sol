// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IQuartersBounty { function seedBounty(uint8 cabinet) external payable; }

/// Turns a stream of ETH into arcade bounty money, with nobody in the path.
///
/// Point a Proof Launch fee leg (or any payer) at this address and every payment
/// lands in the cabinet's bounty pool. There is no owner, no pause, no withdraw
/// and no way to change where the money goes: the arcade and the cabinet are
/// fixed at construction. Trading the token grows the prize; the prize brings
/// players; players grow the pot. Anyone can verify the whole path on chain.
contract BountyFeeder {
    IQuartersBounty public immutable arcade;
    uint8 public immutable cabinet;

    event Fed(address indexed from, uint256 amount);

    constructor(address arcade_, uint8 cabinet_) {
        require(arcade_ != address(0), "arcade");
        arcade = IQuartersBounty(arcade_);
        cabinet = cabinet_;
    }

    receive() external payable { _feed(); }
    fallback() external payable { _feed(); }

    /// Sweep anything that arrived by self-destruct or a transfer that skipped receive().
    function feed() external { _feed(); }

    function _feed() internal {
        uint256 amount = address(this).balance;
        if (amount == 0) return;
        arcade.seedBounty{ value: amount }(cabinet);
        emit Fed(msg.sender, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../src/Quarters.sol";
import "../src/BountyFeeder.sol";

contract BountyFeederTest is Test {
    Quarters q; BountyFeeder f;
    address payable treasury = payable(address(0x7E00));
    uint256 constant Q = 0.0002 ether;

    function setUp() public {
        q = new Quarters(address(0xD100), treasury, Q, 7000, 1500, 86400);
        q.createCabinet(2, bytes16("voidrocks"), true);
        f = new BountyFeeder(address(q), 2);
        vm.warp(1_700_000_000); vm.roll(100);
    }
    function test_plain_transfer_becomes_bounty() public {
        (, , uint256 before) = q.bounties(2);
        (bool ok, ) = address(f).call{ value: 1 ether }(""); assertTrue(ok, "send");
        (, , uint256 after_) = q.bounties(2);
        assertEq(after_ - before, 1 ether, "the whole payment reached the pool");
        assertEq(address(f).balance, 0, "feeder never holds funds");
    }
    function test_many_small_payments_accumulate() public {
        for (uint256 i = 0; i < 25; i++) { (bool ok, ) = address(f).call{ value: 0.004 ether }(""); assertTrue(ok); }
        (, , uint256 pool) = q.bounties(2);
        assertEq(pool, 0.1 ether, "25 fee payments accumulated");
    }
    function test_no_owner_no_escape_hatch() public {
        // the feeder exposes no way to redirect or withdraw: only arcade+cabinet, both immutable
        assertEq(address(f.arcade()), address(q));
        assertEq(f.cabinet(), 2);
        (bool ok, ) = address(f).call(abi.encodeWithSignature("withdraw()"));
        assertTrue(ok, "unknown selector hits fallback and feeds, it does not withdraw");
        assertEq(address(f).balance, 0);
    }
    function test_sweep_after_forced_send() public {
        vm.deal(address(f), 0.5 ether);      // e.g. arrived via selfdestruct, no receive() ran
        f.feed();
        (, , uint256 pool) = q.bounties(2);
        assertEq(pool, 0.5 ether, "sweep recovers it");
    }
}

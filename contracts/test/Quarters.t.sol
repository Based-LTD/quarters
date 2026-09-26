// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../src/Quarters.sol";

contract Reverter { receive() external payable { revert("no"); } }

contract QuartersTest is Test {
    Quarters q;
    address verifier = address(0xD100);
    address payable treasury = payable(address(0x7E00));
    address payable operator = payable(address(0x0B00));
    address alice = address(0xA100); address bob = address(0xB000); address carol = address(0xC000);
    uint256 constant Q = 0.001 ether;   // quarter
    uint32 constant PERIOD = 3600;

    function setUp() public {
        q = new Quarters(verifier, treasury, Q, 7000, 1500, PERIOD);
        q.createCabinet(1, bytes16("voidrocks"), false);
        q.createCabinet(2, bytes16("voidrocks"), true);
        q.setOperator(1, operator); q.setOperator(2, operator);
        vm.deal(alice, 10 ether); vm.deal(bob, 10 ether); vm.deal(carol, 10 ether);
        vm.warp(1_700_000_000); vm.roll(100);
    }
    function _commit(bytes32 secret) internal pure returns (bytes32) { return sha256(abi.encodePacked(secret)); }
    function _insert(address who, uint8 cab, bytes32 secret) internal { uint256 p = q.priceOf(cab); bytes32 c = _commit(secret); vm.prank(who); q.insertCoin{ value: p }(cab, c); }
    function _sub(address p, bytes32 s, uint32 score, bool f) internal pure returns (Quarters.Submission memory) { return Quarters.Submission({ player: p, secret: s, score: score, replayHash: keccak256(abi.encodePacked(score)), flagged: f }); }
    function _submit(uint8 cab, Quarters.Submission memory s) internal { Quarters.Submission[] memory a = new Quarters.Submission[](1); a[0] = s; vm.prank(verifier); q.submitScores(cab, a); }

    function test_insert_splits_exactly() public {
        uint256 t0 = treasury.balance; uint256 o0 = operator.balance;
        _insert(alice, 1, bytes32(uint256(1)));
        (, , , uint256 pool, ) = q.potOf(1, q.currentDay());
        assertEq(pool, Q * 7000 / 10000, "pot 70%");
        assertEq(operator.balance - o0, Q * 1500 / 10000, "operator 15%");
        assertEq(treasury.balance - t0, Q - Q * 7000 / 10000 - Q * 1500 / 10000, "house 15%");
        Quarters.Credit memory c = q.creditOf(alice, _commit(bytes32(uint256(1))));
        assertTrue(c.exists && !c.used && c.salt != bytes8(0), "credit with salt");
    }
    function test_wrong_price_and_reused_commit_revert() public {
        bytes32 c1 = _commit(bytes32(uint256(1)));
        vm.prank(alice); vm.expectRevert(bytes("price")); q.insertCoin{ value: Q - 1 }(1, c1);
        _insert(alice, 1, bytes32(uint256(1)));
        vm.prank(alice); vm.expectRevert(bytes("commit used")); q.insertCoin{ value: Q }(1, c1);
    }
    function test_only_verifier_submits_and_window() public {
        _insert(alice, 1, bytes32(uint256(1)));
        Quarters.Submission[] memory a = new Quarters.Submission[](1); a[0] = _sub(alice, bytes32(uint256(1)), 500, false);
        vm.prank(alice); vm.expectRevert(bytes("verifier")); q.submitScores(1, a);
        vm.warp(block.timestamp + 1201);
        vm.prank(verifier); vm.expectRevert(bytes("window")); q.submitScores(1, a);
    }
    function test_sorted_top10_and_settle_split_with_flag() public {
        uint32 day = q.currentDay();
        _insert(alice, 1, bytes32(uint256(1))); _insert(bob, 1, bytes32(uint256(2))); _insert(carol, 1, bytes32(uint256(3)));
        _submit(1, _sub(bob, bytes32(uint256(2)), 200, false));
        _submit(1, _sub(alice, bytes32(uint256(1)), 900, true));    // top score but flagged: held
        _submit(1, _sub(carol, bytes32(uint256(3)), 500, false));
        (uint8 count, , , uint256 pool, Quarters.Entry[10] memory e) = q.potOf(1, day);
        assertEq(count, 3); assertEq(e[0].score, 900); assertEq(e[1].score, 500); assertEq(e[2].score, 200);
        // settle: before grace reverts
        vm.expectRevert(bytes("day not over")); q.settlePot(1, day);
        vm.warp(uint256(day + 1) * PERIOD + q.grace());
        uint256 b0 = bob.balance; uint256 c0 = carol.balance; uint256 a0 = alice.balance; uint256 t0 = treasury.balance;
        q.settlePot(1, day);
        // present: ranks 2 (1800) and 3 (1200) → carol 1800/3000, bob 1200/3000; alice 0
        assertEq(carol.balance - c0, pool * 1800 / 3000, "carol");
        assertEq(bob.balance - b0, pool * 1200 / 3000, "bob");
        assertEq(alice.balance - a0, 0, "flagged held");
        uint256 dust = pool - pool * 1800 / 3000 - pool * 1200 / 3000;
        assertEq(treasury.balance - t0, dust, "dust to treasury");
        vm.expectRevert(bytes("pot")); q.settlePot(1, day);   // no double settle
    }
    function test_clear_flag_restores_payout() public {
        uint32 day = q.currentDay();
        _insert(alice, 1, bytes32(uint256(1))); _submit(1, _sub(alice, bytes32(uint256(1)), 900, true));
        q.clearFlag(1, day, 0);
        (, , , uint256 pool, ) = q.potOf(1, day);
        vm.warp(uint256(day + 1) * PERIOD + q.grace()); uint256 a0 = alice.balance; q.settlePot(1, day);
        assertEq(alice.balance - a0, pool, "sole player takes whole pool after clear");
    }
    function test_empty_pot_sweeps_to_treasury() public {
        uint32 day = q.currentDay();
        q.addToPot{ value: 0.01 ether }(1, day);                     // house add, nobody plays
        vm.warp(uint256(day + 1) * PERIOD + q.grace()); uint256 t0 = treasury.balance; q.settlePot(1, day);
        assertEq(treasury.balance - t0, 0.01 ether, "house add returns to treasury");
    }
    function test_tab_start_run_by_session_key() public {
        address session = address(0x5E5500);
        vm.prank(alice); q.openTab{ value: 10 * Q + 0.002 ether }(session, 0.002 ether);
        assertEq(session.balance, 0.002 ether, "session float forwarded");
        bytes32 c9 = _commit(bytes32(uint256(9))); bytes32 c10 = _commit(bytes32(uint256(10)));
        vm.prank(session); q.startRun(alice, 1, c9);
        (uint256 bal, ) = q.tabs(alice); assertEq(bal, 9 * Q, "tab debited one quarter");
        Quarters.Credit memory c = q.creditOf(alice, c9); assertEq(c.player, alice, "credit belongs to the player");
        vm.prank(bob); vm.expectRevert(bytes("session")); q.startRun(alice, 1, c10);
        vm.prank(alice); uint256 a0 = alice.balance; q.closeTab(); assertEq(alice.balance - a0, 9 * Q, "close returns balance");
    }
    function test_bounty_record_takes_pool_and_raises_bar() public {
        q.seedBounty{ value: 0.5 ether }(2);
        _insert(alice, 2, bytes32(uint256(1)));
        (, , uint256 pool0) = q.bounties(2); assertEq(pool0, 0.5 ether + Q * 7000 / 10000, "coin's pot share feeds the bounty");
        uint256 a0 = alice.balance; _submit(2, _sub(alice, bytes32(uint256(1)), 1500, false));
        assertEq(alice.balance - a0, pool0, "record takes the whole pool");
        (uint32 rec, address champ, uint256 poolAfter) = q.bounties(2); assertEq(rec, 1500); assertEq(champ, alice); assertEq(poolAfter, 0);
        _insert(bob, 2, bytes32(uint256(2))); uint256 b0 = bob.balance; _submit(2, _sub(bob, bytes32(uint256(2)), 1200, false));
        assertEq(bob.balance - b0, 0, "below the record pays nothing now");
    }
    function test_undeliverable_payout_is_owed_not_lost() public {
        Reverter r = new Reverter(); vm.deal(address(r), 1 ether);
        uint32 day = q.currentDay();
        bytes32 c7 = _commit(bytes32(uint256(7))); vm.prank(address(r)); q.insertCoin{ value: Q }(1, c7);
        _submit(1, _sub(address(r), bytes32(uint256(7)), 100, false));
        (, , , uint256 pool, ) = q.potOf(1, day);
        vm.warp(uint256(day + 1) * PERIOD + q.grace()); q.settlePot(1, day);
        assertEq(q.owed(address(r)), pool, "held for withdrawal");
    }
    function test_sponsor_buyback_accrues_from_house_share_only() public {
        address token = address(0x70CE00); address vault = address(0xBA6);
        q.setSponsor(1, token, vault, 1000);                          // 10% of the quarter, out of the house's 15%
        vm.expectRevert(bytes("bps > house share")); q.setSponsor(1, token, vault, 1501);
        uint256 t0 = treasury.balance; uint256 o0 = operator.balance;
        _insert(alice, 1, bytes32(uint256(1)));
        (, , , uint256 pool, ) = q.potOf(1, q.currentDay());
        assertEq(pool, Q * 7000 / 10000, "pot untouched");
        assertEq(operator.balance - o0, Q * 1500 / 10000, "operator untouched");
        assertEq(q.buybackPool(1), Q * 1000 / 10000, "buyback accrued");
        assertEq(treasury.balance - t0, Q * 500 / 10000, "house keeps the rest");
        vm.prank(alice); vm.expectRevert(bytes("vault")); q.withdrawBuyback(1);
        vm.deal(vault, 0); vm.prank(vault); q.withdrawBuyback(1);
        assertEq(vault.balance, Q * 1000 / 10000, "vault pulled the accrual");
        assertEq(q.buybackPool(1), 0);
    }
    function test_gas_leg_pays_verifier_from_house_share() public {
        q.setGasLeg(500);                                              // 5% of the quarter
        vm.expectRevert(bytes("bps > house share")); q.setGasLeg(1501);
        uint256 v0 = verifier.balance; uint256 t0 = treasury.balance; uint256 o0 = operator.balance;
        _insert(alice, 1, bytes32(uint256(1)));
        (, , , uint256 pool, ) = q.potOf(1, q.currentDay());
        assertEq(pool, Q * 7000 / 10000, "pot untouched");
        assertEq(operator.balance - o0, Q * 1500 / 10000, "operator untouched");
        assertEq(verifier.balance - v0, Q * 500 / 10000, "verifier gets the gas leg");
        assertEq(treasury.balance - t0, Q * 1000 / 10000, "house keeps the rest");
        // with a sponsor on top: gas leg first, then buyback, house gets what is left
        q.setSponsor(1, address(0x70CE00), address(0xBA6), 800);
        uint256 t1 = treasury.balance; _insert(bob, 1, bytes32(uint256(2)));
        assertEq(q.buybackPool(1), Q * 800 / 10000, "buyback accrued");
        assertEq(treasury.balance - t1, Q * 200 / 10000, "house share after gas + buyback");
    }
    function test_bounty_floor_sets_a_real_bar() public {
        q.seedBounty{ value: 0.5 ether }(2);
        q.setBountyFloor(2, 12000);
        // a good-but-not-good-enough run takes nothing and does not become the record
        _insert(alice, 2, bytes32(uint256(1)));
        uint256 a0 = alice.balance;
        _submit(2, _sub(alice, bytes32(uint256(1)), 9000, false));
        assertEq(alice.balance - a0, 0, "under the posted bar pays nothing");
        (uint32 rec, , uint256 pool) = q.bounties(2);
        assertEq(rec, 0, "record untouched"); assertGt(pool, 0.5 ether, "pool kept growing");
        // clearing the bar takes the pool and sets the record
        _insert(bob, 2, bytes32(uint256(2)));
        uint256 b0 = bob.balance; uint256 want = pool;
        _submit(2, _sub(bob, bytes32(uint256(2)), 12001, false));
        assertGt(bob.balance - b0, want, "cleared the bar, took the pool");
        (uint32 rec2, address champ, ) = q.bounties(2);
        assertEq(rec2, 12001); assertEq(champ, bob);
        // from then on the record leads, the floor is spent
        _insert(carol, 2, bytes32(uint256(3)));
        uint256 c0 = carol.balance;
        _submit(2, _sub(carol, bytes32(uint256(3)), 12500, false));
        assertGt(carol.balance - c0, 0, "beating the record still pays");
    }
    function test_only_authority_sets_the_floor() public {
        vm.prank(alice); vm.expectRevert(bytes("authority")); q.setBountyFloor(2, 5000);
        vm.expectRevert(bytes("not a bounty cabinet")); q.setBountyFloor(1, 5000);
    }
    function test_batch_submit_gas_shared() public {
        Quarters.Submission[] memory a = new Quarters.Submission[](5);
        for (uint256 i = 0; i < 5; i++) { address p = address(uint160(0x1000 + i)); vm.deal(p, 1 ether); bytes32 ci = _commit(bytes32(i + 100)); vm.prank(p); q.insertCoin{ value: Q }(1, ci); a[i] = _sub(p, bytes32(i + 100), uint32(100 * (i + 1)), false); }
        vm.prank(verifier); q.submitScores(1, a);
        (uint8 count, , , , Quarters.Entry[10] memory e) = q.potOf(1, q.currentDay());
        assertEq(count, 5); assertEq(e[0].score, 500); assertEq(e[4].score, 100);
    }
}

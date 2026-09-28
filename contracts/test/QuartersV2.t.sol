// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/QuartersV2.sol";

// The floor contract: same money path as Quarters, plus a payout table the
// authority can change for pots that open afterwards (80/15/5 to start).
contract QuartersV2Test is Test {
    QuartersV2 q;
    address verifier = address(0xD100);
    address payable treasury = payable(address(0x7E00));
    address[6] players = [address(0xA1), address(0xA2), address(0xA3), address(0xA4), address(0xA5), address(0xA6)];
    uint256 constant Q = 0.0002 ether;
    uint32 constant PERIOD = 86400;

    function setUp() public {
        uint16[] memory t = new uint16[](3); t[0] = 8000; t[1] = 1500; t[2] = 500;
        q = new QuartersV2(verifier, treasury, Q, 7000, 1500, PERIOD, t);
        q.createCabinet(9, bytes16("chomp"), false);
        for (uint256 i = 0; i < players.length; i++) vm.deal(players[i], 1 ether);
        vm.warp(1_700_000_000); vm.roll(100);
    }
    function _commit(bytes32 s) internal pure returns (bytes32) { return sha256(abi.encodePacked(s)); }
    // coin + score for player i (flagged optional), in today's pot
    function _run(uint256 i, uint32 score, bool flagged) internal {
        bytes32 secret = keccak256(abi.encode(i, score, block.timestamp)); bytes32 c = _commit(secret);
        vm.prank(players[i]); q.insertCoin{ value: Q }(9, c);
        QuartersV2.Submission[] memory a = new QuartersV2.Submission[](1);
        a[0] = QuartersV2.Submission({ player: players[i], secret: secret, score: score, replayHash: keccak256(abi.encode(secret)), flagged: flagged });
        vm.prank(verifier); q.submitScores(9, a);
    }
    function _settleToday() internal returns (uint256[6] memory got, uint256 pool) {
        uint32 day = q.currentDay(); (, , , pool, ) = q.potOf(9, day);
        uint256[6] memory b0; for (uint256 i = 0; i < 6; i++) b0[i] = players[i].balance;
        vm.warp(uint256(day + 1) * PERIOD + q.grace() + 1);
        q.settlePot(9, day);
        for (uint256 i = 0; i < 6; i++) got[i] = players[i].balance - b0[i];
    }

    function test_full_board_pays_top_three_80_15_5() public {
        _run(0, 900, false); _run(1, 800, false); _run(2, 700, false); _run(3, 600, false); _run(4, 500, false);
        (uint256[6] memory got, uint256 pool) = _settleToday();
        assertEq(got[0], pool * 8000 / 10000, "1st 80%");
        assertEq(got[1], pool * 1500 / 10000, "2nd 15%");
        assertEq(got[2], pool * 500 / 10000, "3rd 5%");
        assertEq(got[3] + got[4], 0, "4th and 5th: nothing");
    }

    function test_thin_boards_split_the_whole_pool() public {
        _run(0, 900, false);
        (uint256[6] memory got, uint256 pool) = _settleToday();
        assertEq(got[0], pool, "alone: 100%");
        vm.warp(block.timestamp + 10);
        _run(1, 500, false); _run(2, 400, false);
        (got, pool) = _settleToday();
        assertEq(got[1], pool * 8000 / 9500, "two players: 80/95");
        assertEq(got[2], pool * 1500 / 9500, "two players: 15/95");
    }

    function test_flagged_runs_hold_no_seat() public {
        _run(0, 999, true);   // flagged at the top
        _run(1, 800, false); _run(2, 700, false); _run(3, 600, false);
        (uint256[6] memory got, uint256 pool) = _settleToday();
        assertEq(got[0], 0, "flagged: nothing");
        assertEq(got[1], pool * 8000 / 10000, "best honest run takes 1st");
        assertEq(got[3], pool * 500 / 10000, "the honest #4 moves into 3rd");
    }

    function test_a_table_change_never_reaches_an_open_pot() public {
        _run(0, 900, false); _run(1, 800, false);   // today's pot opens under 80/15/5
        uint16[] memory t = new uint16[](2); t[0] = 6000; t[1] = 4000;
        q.setPayoutTable(t);
        _run(2, 700, false);
        assertEq(q.potTable(9, q.currentDay())[0], 8000, "today keeps the table it opened with");
        (uint256[6] memory got, uint256 pool) = _settleToday();
        assertEq(got[0], pool * 8000 / 10000, "old table paid today");
        _run(3, 500, false); _run(4, 400, false);   // a new day opens under 60/40
        assertEq(q.potTable(9, q.currentDay())[0], 6000, "the next day opens with the new table");
        (got, pool) = _settleToday();
        assertEq(got[3], pool * 6000 / 10000); assertEq(got[4], pool * 4000 / 10000);
    }

    function test_payout_table_guards() public {
        uint16[] memory bad = new uint16[](2); bad[0] = 8000; bad[1] = 1000;
        vm.expectRevert(bytes("bps")); q.setPayoutTable(bad);
        uint16[] memory none = new uint16[](0);
        vm.expectRevert(bytes("ranks")); q.setPayoutTable(none);
        uint16[] memory ok = new uint16[](1); ok[0] = 10000;
        vm.prank(players[0]); vm.expectRevert(bytes("authority")); q.setPayoutTable(ok);
    }

    function test_dust_and_empty_pots_go_to_the_treasury() public {
        _run(0, 900, false); _run(1, 800, false); _run(2, 700, false);
        uint256 t0 = treasury.balance;
        (uint256[6] memory got, uint256 pool) = _settleToday();
        uint256 paid = got[0] + got[1] + got[2];
        assertEq(treasury.balance - t0, pool - paid, "the treasury gets exactly the rounding dust");
        assertLe(pool - paid, 3, "and it is only dust");
    }
}

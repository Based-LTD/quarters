// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Quarters.sol";
import "../src/JackpotDoor.sol";

contract MockQTR { mapping(address => uint256) public balanceOf; function set(address a, uint256 v) external { balanceOf[a] = v; } }
contract Refuser { function play(JackpotDoor d, bytes32 c, uint256 v) external payable { d.play{ value: v }(c); } receive() external payable { revert("no"); } }

contract JackpotDoorTest is Test {
    Quarters q; JackpotDoor door; MockQTR qtr;
    address verifier = address(0xD100);
    address payable treasury = payable(address(0x7E00));
    address holder = address(0xA100); address pleb = address(0xB000);
    uint256 constant Q = 0.0002 ether;
    uint256 constant HOLD = 1_000_000 ether;   // $QTR units needed to count as a holder

    function setUp() public {
        q = new Quarters(verifier, treasury, Q, 7000, 1500, 86400);
        q.createCabinet(2, bytes16("voidrocks"), true);
        qtr = new MockQTR();
        door = new JackpotDoor(q, 2, address(qtr), HOLD, 1 ether, 2500, 1 ether);
        vm.deal(holder, 10 ether); vm.deal(pleb, 10 ether); vm.deal(address(this), 100 ether);
        qtr.set(holder, HOLD);   // exactly the minimum counts
        vm.warp(1_700_000_000); vm.roll(100);
    }
    function _commit(bytes32 s) internal pure returns (bytes32) { return sha256(abi.encodePacked(s)); }
    // sha256 is a precompile call: compute commits BEFORE vm.prank/expectRevert, or the cheatcode is spent on it
    function _play(address who, bytes32 secret) internal { bytes32 c = _commit(secret); vm.prank(who); door.play{ value: Q }(c); }
    function _settle(bytes32 secret, uint256 received) internal { bytes32 c = _commit(secret); vm.prank(verifier); door.settle(c, received); }
    // the verifier writes the door seat's run: on Quarters the player of record is the door
    function _win(bytes32 secret, uint32 score) internal returns (uint256 received) {
        uint256 b0 = address(door).balance;
        Quarters.Submission[] memory a = new Quarters.Submission[](1);
        a[0] = Quarters.Submission({ player: address(door), secret: secret, score: score, replayHash: keccak256(abi.encode(secret)), flagged: false });
        vm.prank(verifier); q.submitScores(2, a);
        received = address(door).balance - b0;
    }
    function _pool() internal view returns (uint256 p) { (, , p) = q.bounties(2); }

    function test_play_seats_the_player_and_their_status() public {
        _play(holder, bytes32(uint256(1))); _play(pleb, bytes32(uint256(2)));
        (address p1, bool h1, ) = door.seats(_commit(bytes32(uint256(1))));
        (address p2, bool h2, ) = door.seats(_commit(bytes32(uint256(2))));
        assertEq(p1, holder); assertTrue(h1, "holder at the minimum");
        assertEq(p2, pleb); assertFalse(h2, "no $QTR, no status");
        assertTrue(q.creditOf(address(door), _commit(bytes32(uint256(1)))).exists, "door is the player of record");
        assertEq(_pool(), 2 * Q * 7000 / 10000, "the coins' pot share still feeds the Bounty");
    }

    function test_status_is_fixed_at_coin_time() public {
        _play(pleb, bytes32(uint256(3)));
        qtr.set(pleb, HOLD * 10);   // buys in after playing
        (, bool h, ) = door.seats(_commit(bytes32(uint256(3))));
        assertFalse(h, "buying after the coin doesn't upgrade the seat");
    }

    function test_holder_takes_the_capped_jackpot_rest_refills() public {
        q.seedBounty{ value: 3 ether }(2);
        _play(holder, bytes32(uint256(4)));
        uint256 received = _win(bytes32(uint256(4)), 50_001);
        assertEq(received, 3 ether + Q * 7000 / 10000, "Quarters paid the whole pool to the door");
        uint256 b0 = holder.balance;
        _settle(bytes32(uint256(4)), received);
        assertEq(holder.balance - b0, 1 ether, "holder: 100% of the 1 ETH jackpot");
        assertEq(_pool(), 1 ether, "next jackpot refilled to 1 ETH");
        assertEq(door.reserve(), received - 1 ether - 1 ether, "the rest waits in reserve");
        assertEq(address(door).balance, door.reserve(), "books match the balance");
    }

    function test_non_holder_takes_25_percent_of_the_jackpot() public {
        q.seedBounty{ value: 0.4 ether }(2);
        _play(pleb, bytes32(uint256(5)));
        uint256 received = _win(bytes32(uint256(5)), 60_000);
        uint256 b0 = pleb.balance;
        _settle(bytes32(uint256(5)), received);
        assertEq(pleb.balance - b0, received * 2500 / 10000, "25% of a sub-cap jackpot");
        assertEq(_pool(), received - received * 2500 / 10000, "the other 75% refilled the next jackpot");
        assertEq(door.reserve(), 0);
    }

    function test_non_holder_capped_at_a_quarter_of_1_eth() public {
        q.seedBounty{ value: 5 ether }(2);
        _play(pleb, bytes32(uint256(6)));
        uint256 received = _win(bytes32(uint256(6)), 70_000);
        uint256 b0 = pleb.balance;
        _settle(bytes32(uint256(6)), received);
        assertEq(pleb.balance - b0, 0.25 ether, "25% of the 1 ETH cap");
        assertEq(_pool() + door.reserve(), received - 0.25 ether, "every other wei stays in the prize");
    }

    function test_settle_guards() public {
        q.seedBounty{ value: 1 ether }(2);
        _play(holder, bytes32(uint256(7)));
        bytes32 c = _commit(bytes32(uint256(7)));
        vm.expectRevert(JackpotDoor.NotScored.selector); vm.prank(verifier); door.settle(c, 0);
        uint256 received = _win(bytes32(uint256(7)), 80_000);
        vm.expectRevert(JackpotDoor.NotVerifier.selector); door.settle(c, received);
        vm.expectRevert(JackpotDoor.TooMuch.selector); vm.prank(verifier); door.settle(c, received + 1);
        vm.expectRevert(JackpotDoor.UnknownSeat.selector); vm.prank(verifier); door.settle(bytes32(uint256(999)), 1);
        vm.prank(verifier); door.settle(c, received);
        vm.expectRevert(JackpotDoor.AlreadySettled.selector); vm.prank(verifier); door.settle(c, received);
    }

    function test_direct_sends_only_ever_grow_the_prize() public {
        (bool ok, ) = address(door).call{ value: 2 ether }(""); assertTrue(ok);
        assertEq(door.unsettled(), 2 ether, "not reserve, not anyone's");
        _play(pleb, bytes32(uint256(8)));
        // nobody can settle money that isn't a scored win's
        bytes32 c8 = _commit(bytes32(uint256(8)));
        vm.expectRevert(JackpotDoor.NotScored.selector); vm.prank(verifier); door.settle(c8, 2 ether);
    }

    function test_retire_returns_reserve_but_keeps_an_unsettled_win_for_its_winner() public {
        q.seedBounty{ value: 3 ether }(2);
        _play(holder, bytes32(uint256(9)));
        uint256 r1 = _win(bytes32(uint256(9)), 90_000);
        _settle(bytes32(uint256(9)), r1);   // reserve now > 0
        uint256 reserve = door.reserve(); assertGt(reserve, 0);
        // a second win lands, then the door is retired before it settles
        _play(holder, bytes32(uint256(10)));
        uint256 r2 = _win(bytes32(uint256(10)), 90_001);
        vm.expectRevert(JackpotDoor.NotAuthority.selector); vm.prank(pleb); door.retire();
        uint256 poolBefore = _pool();
        door.retire();   // this test contract deployed Quarters, so it is the authority
        assertEq(_pool(), poolBefore + reserve, "reserve went back into the Bounty");
        bytes32 c11 = _commit(bytes32(uint256(11)));
        vm.expectRevert(JackpotDoor.Closed.selector); vm.prank(pleb); door.play{ value: Q }(c11);
        uint256 b0 = holder.balance;
        _settle(bytes32(uint256(10)), r2);
        assertEq(holder.balance - b0, r2 < 1 ether ? r2 : 1 ether, "the winner still gets paid after retirement");
        assertEq(address(door).balance, 0, "retired door keeps nothing");
        vm.expectRevert(bytes("not yet")); door.sweep();
        vm.warp(block.timestamp + 1 days); door.sweep();
    }

    function test_undeliverable_payout_is_owed_not_lost() public {
        Refuser r = new Refuser(); qtr.set(address(r), HOLD);
        q.seedBounty{ value: 1 ether }(2);
        vm.deal(address(r), 1 ether);
        r.play(door, _commit(bytes32(uint256(12))), Q);   // Refuser calls play itself: no prank involved
        uint256 received = _win(bytes32(uint256(12)), 99_999);
        _settle(bytes32(uint256(12)), received);
        assertEq(door.owed(address(r)), received < 1 ether ? received : 1 ether, "held for the winner");
        assertEq(address(door).balance, door.reserve() + door.owedTotal(), "books match");
    }

    function test_no_token_yet_means_everyone_plays_at_25_percent() public {
        JackpotDoor open = new JackpotDoor(q, 2, address(0), 0, 1 ether, 2500, 1 ether);
        assertFalse(open.isHolder(holder), "no $QTR contract, no holders");
    }
}

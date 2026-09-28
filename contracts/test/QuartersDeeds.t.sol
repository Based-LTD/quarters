// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Quarters.sol";
import "../src/QuartersDeeds.sol";

// Feasibility: cabinet deeds paid by the LIVE Quarters contract, unchanged.
contract QuartersDeedsTest is Test {
    Quarters q; QuartersDeeds deeds;
    address verifier = address(0xD100);
    address payable treasury = payable(address(0x7E00));
    address player = address(0xA100); address alice = address(0xA11CE); address bob = address(0xB0B);
    uint256 constant Q = 0.0002 ether;

    function setUp() public {
        q = new Quarters(verifier, treasury, Q, 7000, 1500, 86400);
        q.createCabinet(2, bytes16("voidrocks"), true);    // THE BOUNTY
        q.createCabinet(9, bytes16("chomp"), false);       // a daily machine
        deeds = new QuartersDeeds("https://quarters.fun/deeds/");
        vm.deal(player, 10 ether);
    }
    function _coin(uint8 cab, uint256 n) internal { vm.prank(player); q.insertCoin{ value: Q }(cab, sha256(abi.encode(cab, n))); }

    function test_the_operator_cut_pays_whoever_holds_the_deed() public {
        address vault = deeds.mint(9, alice);
        q.setOperator(9, payable(vault));                      // one authority call on the live contract
        for (uint256 i = 0; i < 10; i++) _coin(9, i);
        assertEq(vault.balance, 10 * Q * 1500 / 10000, "15% of every coin reached the vault inside Quarters' 30k-gas stipend");
        uint256 a0 = alice.balance; DeedVault(payable(vault)).claim();
        assertEq(alice.balance - a0, 10 * Q * 1500 / 10000, "deed holder paid");
    }

    function test_selling_the_deed_moves_the_income() public {
        address vault = deeds.mint(9, alice);
        q.setOperator(9, payable(vault));
        _coin(9, 1);
        vm.prank(alice); deeds.safeTransferFrom(alice, bob, 9);   // a sale, as any NFT market would do it
        assertEq(deeds.ownerOf(9), bob);
        _coin(9, 2);
        uint256 b0 = bob.balance; DeedVault(payable(vault)).claim();
        assertEq(bob.balance - b0, 2 * Q * 1500 / 10000, "unclaimed earnings travel with the deed");
    }

    function test_the_featured_deed_earns_the_bounty_machine_cut_that_week() public {
        address chompVault = deeds.mint(9, alice);
        q.setOperator(9, payable(chompVault));
        q.setOperator(2, payable(chompVault));                 // CHOMP week: the jackpot machine's cut goes to the Chomp deed
        _coin(2, 1); _coin(2, 2);
        assertEq(chompVault.balance, 2 * Q * 1500 / 10000);
    }

    function test_standard_erc721_surface() public {
        deeds.mint(9, alice);
        assertTrue(deeds.supportsInterface(0x80ac58cd), "ERC-721");
        assertEq(deeds.balanceOf(alice), 1);
        assertEq(deeds.tokenURI(9), "https://quarters.fun/deeds/9");
        vm.prank(alice); deeds.approve(bob, 9);
        vm.prank(bob); deeds.transferFrom(alice, bob, 9);
        assertEq(deeds.ownerOf(9), bob, "approved transfer, as a marketplace would do");
        vm.expectRevert(bytes("authority")); vm.prank(bob); deeds.mint(3, bob);
    }
}

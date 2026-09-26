// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// Test doubles for the buyback lane on Anvil: a mintable token, a "factory" that
/// always reports a pool, and a router whose exactInputSingle mints 1,000 tokens
/// per ETH to the recipient. Never deployed to a real chain.
contract MockToken {
    string public name = "MOCK"; string public symbol = "MOCK"; uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; emit Transfer(address(0), to, amt); }
    function transfer(address to, uint256 amt) external returns (bool) { require(balanceOf[msg.sender] >= amt, "bal"); balanceOf[msg.sender] -= amt; balanceOf[to] += amt; emit Transfer(msg.sender, to, amt); return true; }
}
contract MockFactory { function getPool(address, address, uint24 fee) external pure returns (address) { return fee == 10000 ? address(0x1) : address(0); } }
contract MockRouter {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        require(msg.value == p.amountIn, "value");
        amountOut = p.amountIn * 1000; MockToken(p.tokenOut).mint(p.recipient, amountOut);
    }
}

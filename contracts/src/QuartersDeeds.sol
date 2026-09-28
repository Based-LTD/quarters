// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Cabinet deeds: one ERC-721 per machine on the QUARTERS floor, token id =
/// cabinet id. Each deed has its own DeedVault; the Quarters authority sets
/// that vault as the cabinet's operator (Quarters.setOperator), so the 15%
/// operator cut of every coin lands in the vault at the moment of play.
/// Whoever holds the deed can have the vault paid out to them at any time;
/// unclaimed earnings travel with the deed, like a rent roll.
///
/// Works with the live Quarters contract as-is: the operator is just an
/// address, and the vault's receive() is empty so it fits Quarters' 30k-gas
/// payout stipend. During a game's Bounty week the authority can point
/// cabinet 2's operator at that game's vault, so the featured deed earns the
/// jackpot machine's cut too.
contract QuartersDeeds {
    string public constant name = "QUARTERS Cabinet Deeds";
    string public constant symbol = "DEED";
    address public authority;
    string public baseURI;

    mapping(uint256 => address) private _owner;
    mapping(address => uint256) private _balance;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operatorApproval;
    mapping(uint256 => address) public vaultOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event DeedMinted(uint256 indexed cabinet, address vault);

    constructor(string memory baseURI_) { authority = msg.sender; baseURI = baseURI_; }

    /// Mint the deed for a cabinet (to the authority, to auction later) and its vault.
    function mint(uint256 cabinet, address to) external returns (address vault) {
        require(msg.sender == authority, "authority");
        require(_owner[cabinet] == address(0) && to != address(0), "exists");
        vault = address(new DeedVault(this, cabinet));
        vaultOf[cabinet] = vault;
        _owner[cabinet] = to; _balance[to] += 1;
        emit Transfer(address(0), to, cabinet);
        emit DeedMinted(cabinet, vault);
    }

    // ---- ERC-721 ----
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd /* ERC721 */ || id == 0x5b5e139f /* metadata */ || id == 0x01ffc9a7 /* ERC165 */;
    }
    function balanceOf(address o) external view returns (uint256) { require(o != address(0), "zero"); return _balance[o]; }
    function ownerOf(uint256 id) public view returns (address o) { o = _owner[id]; require(o != address(0), "no deed"); }
    function tokenURI(uint256 id) external view returns (string memory) { ownerOf(id); return string(abi.encodePacked(baseURI, _toString(id))); }
    function getApproved(uint256 id) external view returns (address) { ownerOf(id); return _approved[id]; }
    function isApprovedForAll(address o, address op) external view returns (bool) { return _operatorApproval[o][op]; }
    function approve(address to, uint256 id) external {
        address o = ownerOf(id); require(msg.sender == o || _operatorApproval[o][msg.sender], "not allowed");
        _approved[id] = to; emit Approval(o, to, id);
    }
    function setApprovalForAll(address op, bool ok) external { _operatorApproval[msg.sender][op] = ok; emit ApprovalForAll(msg.sender, op, ok); }
    function transferFrom(address from, address to, uint256 id) public {
        address o = ownerOf(id);
        require(o == from && to != address(0), "bad transfer");
        require(msg.sender == o || _approved[id] == msg.sender || _operatorApproval[o][msg.sender], "not allowed");
        delete _approved[id]; _balance[from] -= 1; _balance[to] += 1; _owner[id] = to;
        emit Transfer(from, to, id);
    }
    function safeTransferFrom(address from, address to, uint256 id) external { safeTransferFrom(from, to, id, ""); }
    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (to.code.length > 0) {
            (bool ok, bytes memory ret) = to.call(abi.encodeWithSelector(0x150b7a02, msg.sender, from, id, data));
            require(ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == 0x150b7a02, "unsafe recipient");
        }
    }
    function setBaseURI(string calldata u) external { require(msg.sender == authority, "authority"); baseURI = u; }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v; uint256 len; while (n != 0) { len++; n /= 10; }
        bytes memory b = new bytes(len); while (v != 0) { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}

/// Collects one cabinet's operator cut. No owner: it can only pay the current deed holder.
contract DeedVault {
    QuartersDeeds public immutable deeds;
    uint256 public immutable cabinet;
    uint256 public totalPaid;
    event Claimed(address indexed holder, uint256 amount);

    constructor(QuartersDeeds deeds_, uint256 cabinet_) { deeds = deeds_; cabinet = cabinet_; }

    receive() external payable {}   // empty on purpose: Quarters pays operators with a 30k-gas stipend

    /// Anyone can trigger it; the money only ever goes to whoever holds the deed right now.
    function claim() external {
        address holder = deeds.ownerOf(cabinet);
        uint256 amount = address(this).balance; require(amount > 0, "nothing to claim");
        totalPaid += amount;
        (bool ok, ) = holder.call{ value: amount }("");
        require(ok, "holder refused payment");
        emit Claimed(holder, amount);
    }
}

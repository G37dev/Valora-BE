// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title InstallmentAssetPool
 * @notice Custody pool untuk VIVALORA Installment claim flow.
 *
 * Siklus plan:
 *   ACTIVE  -> operator allocate(planId, beneficiary, amount) saat plan aktif
 *   CLAIMED -> operator releaseClaim(planId) saat user claim dari app
 *   VOID    -> operator reclaimPlan(planId) saat plan AUTO_LIQUIDATED / CANCELLED
 *
 * Backend (off-chain) tetap sumber kebenaran bisnis; kontrak ini hanya custody
 * + emit event untuk indexer PostgreSQL, sama seperti EarnAssetPool.
 * Satu pool per asset (deploy terpisah untuk VVLR GOLD dan XAUT).
 */
contract InstallmentAssetPool is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // Packed dalam 2 slot: amount (256) | beneficiary (160) + allocatedAt (64) + status (8)
    struct PlanAllocation {
        uint256 amount;        // Slot 1: token amount (wei)
        address beneficiary;   // Slot 2: 160 bits — alamat on-chain user
        uint64 allocatedAt;    // Slot 2: 64 bits
        uint8 status;          // Slot 2: 8 bits — 0 NONE, 1 ALLOCATED, 2 CLAIMED, 3 VOID
    }

    uint8 internal constant S_NONE = 0;
    uint8 internal constant S_ALLOCATED = 1;
    uint8 internal constant S_CLAIMED = 2;
    uint8 internal constant S_VOID = 3;

    IERC20 public immutable assetToken;

    address public operator;
    address public treasurySafe;

    // planId = keccak256(abi.encodePacked(uuid plan di backend))
    mapping(bytes32 => PlanAllocation) public plans;

    // Aggregate inkremental — berapa banyak saldo pool yang sudah di-earmark untuk plan aktif
    uint256 public totalAllocatedLiability;

    error InvalidAddress();
    error InvalidAmount();
    error Unauthorized();
    error PlanAlreadyExists();
    error PlanNotAllocated();
    error PlanNotClaimable();
    error PlanNotVoidable();
    error InsufficientLiquidity();

    event OperatorUpdated(address indexed operator);
    event TreasuryUpdated(address indexed treasury);
    event PoolFunded(address indexed from, uint256 amount);
    event PlanAllocated(
        bytes32 indexed planId,
        address indexed beneficiary,
        uint256 amount
    );
    event ClaimReleased(
        bytes32 indexed planId,
        address indexed beneficiary,
        uint256 amount
    );
    event PlanVoided(
        bytes32 indexed planId,
        address indexed treasury,
        uint256 amount
    );

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(
        address _assetToken,
        address _governanceSafe,
        address _operator,
        address _treasurySafe
    ) Ownable(_governanceSafe) {
        if (
            _assetToken == address(0) ||
            _governanceSafe == address(0) ||
            _operator == address(0) ||
            _treasurySafe == address(0)
        ) revert InvalidAddress();

        assetToken = IERC20(_assetToken);
        operator = _operator;
        treasurySafe = _treasurySafe;
    }

    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert InvalidAddress();
        operator = _operator;
        emit OperatorUpdated(_operator);
    }

    function setTreasury(address _treasurySafe) external onlyOwner {
        if (_treasurySafe == address(0)) revert InvalidAddress();
        treasurySafe = _treasurySafe;
        emit TreasuryUpdated(_treasurySafe);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice Stok inventaris pool — operator mengirim token untuk backing claim.
     * Token di-pull dari operator (butuh approve sebelumnya).
     */
    function fundPool(uint256 amount) external onlyOperator nonReentrant {
        if (amount == 0) revert InvalidAmount();
        assetToken.safeTransferFrom(msg.sender, address(this), amount);
        emit PoolFunded(msg.sender, amount);
    }

    /**
     * @notice Earmark token untuk plan yang baru aktif.
     * Revert kalau likuiditas pool tidak cukup menutup semua alokasi.
     */
    function allocate(
        bytes32 planId,
        address beneficiary,
        uint256 amount
    ) external onlyOperator nonReentrant whenNotPaused {
        if (beneficiary == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (plans[planId].status != S_NONE) revert PlanAlreadyExists();

        uint256 available = assetToken.balanceOf(address(this)) -
            totalAllocatedLiability;
        if (available < amount) revert InsufficientLiquidity();

        plans[planId] = PlanAllocation({
            amount: amount,
            beneficiary: beneficiary,
            allocatedAt: uint64(block.timestamp),
            status: S_ALLOCATED
        });
        totalAllocatedLiability += amount;

        emit PlanAllocated(planId, beneficiary, amount);
    }

    /**
     * @notice Release alokasi ke beneficiary saat user claim.
     * Dipanggil backend operator; tx hash-nya disimpan sebagai release_tx_hash.
     */
    function releaseClaim(
        bytes32 planId
    ) external onlyOperator nonReentrant whenNotPaused {
        PlanAllocation storage p = plans[planId];
        if (p.status != S_ALLOCATED) revert PlanNotClaimable();

        p.status = S_CLAIMED;
        totalAllocatedLiability -= p.amount;

        assetToken.safeTransfer(p.beneficiary, p.amount);

        emit ClaimReleased(planId, p.beneficiary, p.amount);
    }

    /**
     * @notice Tarik kembali alokasi ke treasury — plan AUTO_LIQUIDATED / CANCELLED.
     */
    function reclaimPlan(
        bytes32 planId
    ) external onlyOperator nonReentrant whenNotPaused {
        PlanAllocation storage p = plans[planId];
        if (p.status != S_ALLOCATED) revert PlanNotVoidable();

        p.status = S_VOID;
        totalAllocatedLiability -= p.amount;

        assetToken.safeTransfer(treasurySafe, p.amount);

        emit PlanVoided(planId, treasurySafe, p.amount);
    }

    /**
     * @notice Tarik saldo pool yang BELUM di-earmark (excess inventory) ke treasury.
     * Alokasi aktif tidak bisa disentuh.
     */
    function withdrawExcess(
        uint256 amount
    ) external onlyOperator nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        uint256 available = assetToken.balanceOf(address(this)) -
            totalAllocatedLiability;
        if (amount > available) revert InsufficientLiquidity();

        assetToken.safeTransfer(treasurySafe, amount);
    }

    function availableLiquidity() external view returns (uint256) {
        return assetToken.balanceOf(address(this)) - totalAllocatedLiability;
    }

    function getPlan(
        bytes32 planId
    )
        external
        view
        returns (uint256 amount, address beneficiary, uint64 allocatedAt, uint8 status)
    {
        PlanAllocation storage p = plans[planId];
        return (p.amount, p.beneficiary, p.allocatedAt, p.status);
    }
}

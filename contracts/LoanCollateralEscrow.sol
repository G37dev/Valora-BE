// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title LoanCollateralEscrow
 * @notice Dumb custody escrow untuk VIVALORA Gold Loan (brief 17 / D.3).
 *
 * SATU codebase, di-deploy TERPISAH per aset (XAUT & VVLR Gold) agar blast
 * radius terisolasi dan pause bisa per-aset.
 *
 * Kontrak TIDAK punya business logic: tanpa interest, LTV, oracle, atau IDR.
 * Backend adalah authoritative ledger; kontrak hanya:
 *   1. custody token jaminan per position,
 *   2. release (partial/full) ke OWNER posisi — recipient di-pin on-chain
 *      sehingga hot operator key tidak bisa mengalirkan dana ke alamat lain,
 *   3. settle = atomic liquidation split yang BUTUH signature dari
 *      settlementSigner (nonce + expiry + jumlah + recipient di-bind di sig).
 *
 * Model key: `operator` (hot relayer) boleh submit tx, tapi dana keluar ke
 * treasury hanya lewat settle() bertanda tangan — tidak ada single key yang
 * bisa menarik collateral user.
 *
 * positionId = keccak256(uuid posisi backend), sama dengan adapter off-chain.
 */
contract LoanCollateralEscrow is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // 0 NONE, 1 LOCKED, 2 SETTLED (liquidated split), 3 CLOSED (released out)
    uint8 internal constant S_NONE = 0;
    uint8 internal constant S_LOCKED = 1;
    uint8 internal constant S_SETTLED = 2;
    uint8 internal constant S_CLOSED = 3;

    struct Position {
        uint256 locked;      // Slot 1: raw token units
        address owner;       // Slot 2: 160 bits — wallet user saat lock
        uint64 lockedAt;     // Slot 2: 64 bits
        uint8 status;        // Slot 2: 8 bits
    }

    IERC20 public immutable assetToken;

    address public operator;
    address public settlementSigner;
    address public treasurySafe;

    mapping(bytes32 => Position) public positions;
    // Replay protection: nonce unik per (positionId, nonce), lintas fungsi
    mapping(bytes32 => mapping(uint256 => bool)) public usedNonces;

    uint256 public totalLockedLiability;

    error InvalidAddress();
    error InvalidAmount();
    error Unauthorized();
    error PositionExists();
    error PositionNotLocked();
    error OwnerMismatch();
    error RecipientNotOwner();
    error TreasuryMismatch();
    error NonceUsed();
    error SignatureExpired();
    error InvalidSignature();
    error SplitMismatch();
    error InsufficientLiquidity();

    event OperatorUpdated(address indexed operator);
    event SettlementSignerUpdated(address indexed signer);
    event TreasuryUpdated(address indexed treasury);
    event CollateralLocked(
        bytes32 indexed positionId,
        address indexed owner,
        uint256 amount,
        uint256 totalLocked
    );
    event CollateralReleased(
        bytes32 indexed positionId,
        address indexed to,
        uint256 amount,
        uint256 nonce,
        uint256 remainingLocked
    );
    event PositionSettled(
        bytes32 indexed positionId,
        address indexed user,
        uint256 refundAmount,
        address indexed treasury,
        uint256 treasuryAmount,
        uint256 nonce
    );

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(
        address _assetToken,
        address _governanceSafe,
        address _operator,
        address _settlementSigner,
        address _treasurySafe
    ) Ownable(_governanceSafe) {
        if (
            _assetToken == address(0) ||
            _governanceSafe == address(0) ||
            _operator == address(0) ||
            _settlementSigner == address(0) ||
            _treasurySafe == address(0)
        ) revert InvalidAddress();

        assetToken = IERC20(_assetToken);
        operator = _operator;
        settlementSigner = _settlementSigner;
        treasurySafe = _treasurySafe;
    }

    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert InvalidAddress();
        operator = _operator;
        emit OperatorUpdated(_operator);
    }

    function setSettlementSigner(address _signer) external onlyOwner {
        if (_signer == address(0)) revert InvalidAddress();
        settlementSigner = _signer;
        emit SettlementSignerUpdated(_signer);
    }

    function setTreasury(address _treasurySafe) external onlyOwner {
        if (_treasurySafe == address(0)) revert InvalidAddress();
        treasurySafe = _treasurySafe;
        emit TreasuryUpdated(_treasurySafe);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice Kunci collateral: operator pull dari wallet user (approve escrow).
     * Re-lock pada posisi LOCKED dengan owner sama = top-up collateral.
     */
    function lock(
        bytes32 positionId,
        address owner,
        uint256 amount
    ) external onlyOperator nonReentrant whenNotPaused {
        if (owner == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        Position storage p = positions[positionId];
        if (p.status == S_NONE) {
            positions[positionId] = Position({
                locked: amount,
                owner: owner,
                lockedAt: uint64(block.timestamp),
                status: S_LOCKED
            });
        } else if (p.status == S_LOCKED && p.owner == owner) {
            p.locked += amount;
        } else {
            revert PositionExists();
        }
        totalLockedLiability += amount;

        assetToken.safeTransferFrom(owner, address(this), amount);

        emit CollateralLocked(
            positionId,
            owner,
            amount,
            positions[positionId].locked
        );
    }

    /**
     * @notice Release collateral (partial/full) — SELALU ke owner posisi.
     * Recipient di-pin on-chain: operator tidak bisa mengalirkan dana ke
     * alamat lain, jadi hot key tidak perlu signature untuk jalur aman ini.
     */
    function release(
        bytes32 positionId,
        address to,
        uint256 amount,
        uint256 nonce
    ) external onlyOperator nonReentrant whenNotPaused {
        Position storage p = positions[positionId];
        if (p.status != S_LOCKED) revert PositionNotLocked();
        if (to != p.owner) revert RecipientNotOwner();
        if (amount == 0 || amount > p.locked) revert InvalidAmount();
        if (usedNonces[positionId][nonce]) revert NonceUsed();
        usedNonces[positionId][nonce] = true;

        p.locked -= amount;
        totalLockedLiability -= amount;
        if (p.locked == 0) p.status = S_CLOSED;

        assetToken.safeTransfer(to, amount);

        emit CollateralReleased(positionId, to, amount, nonce, p.locked);
    }

    /**
     * @notice Atomic liquidation split (D.3): refund -> user, sisanya ->
     * treasury. Wajib signature settlementSigner atas payload kanonik:
     * (chainId, contract, positionId, user, refund, treasury, treasuryAmount,
     *  nonce, expiresAt) — EIP-191 signed message.
     * Konservasi: refund + treasuryAmount HARUS == locked (tidak ada sisa).
     */
    function settle(
        bytes32 positionId,
        address user,
        uint256 refundAmount,
        address treasury,
        uint256 treasuryAmount,
        uint256 nonce,
        uint256 expiresAt,
        bytes calldata signature
    ) external onlyOperator nonReentrant whenNotPaused {
        Position storage p = positions[positionId];
        if (p.status != S_LOCKED) revert PositionNotLocked();
        if (block.timestamp > expiresAt) revert SignatureExpired();
        if (usedNonces[positionId][nonce]) revert NonceUsed();
        if (user != p.owner) revert RecipientNotOwner();
        if (treasury != treasurySafe) revert TreasuryMismatch();
        if (refundAmount + treasuryAmount != p.locked) revert SplitMismatch();

        bytes32 digest = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                positionId,
                user,
                refundAmount,
                treasury,
                treasuryAmount,
                nonce,
                expiresAt
            )
        );
        address recovered = digest.toEthSignedMessageHash().recover(signature);
        if (recovered != settlementSigner) revert InvalidSignature();
        usedNonces[positionId][nonce] = true;

        uint256 lockedBefore = p.locked;
        p.locked = 0;
        p.status = S_SETTLED;
        totalLockedLiability -= lockedBefore;

        if (refundAmount > 0) assetToken.safeTransfer(user, refundAmount);
        if (treasuryAmount > 0) assetToken.safeTransfer(treasury, treasuryAmount);

        emit PositionSettled(
            positionId,
            user,
            refundAmount,
            treasury,
            treasuryAmount,
            nonce
        );
    }

    /**
     * @notice Sapu token yang TIDAK tercatat sebagai liability posisi
     * (mis. kiriman langsung salah alamat) ke treasury. Dana posisi
     * aktif tidak bisa disentuh.
     */
    function sweepSurplus(
        uint256 amount
    ) external onlyOperator nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        uint256 surplus = assetToken.balanceOf(address(this)) -
            totalLockedLiability;
        if (amount > surplus) revert InsufficientLiquidity();
        assetToken.safeTransfer(treasurySafe, amount);
    }

    function getPosition(
        bytes32 positionId
    )
        external
        view
        returns (address owner, uint256 locked, uint8 status)
    {
        Position storage p = positions[positionId];
        return (p.owner, p.locked, p.status);
    }

    function surplusBalance() external view returns (uint256) {
        return assetToken.balanceOf(address(this)) - totalLockedLiability;
    }
}

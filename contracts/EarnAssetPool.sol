// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface ISafe {
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation
    ) external returns (bool success);
}

/**
 * @title EarnAssetPool
 * @notice Financial Engine untuk VIVALORA Earn. Menyimpan principal, position state, dan menyelesaikan claim[cite: 2].
 * Menggunakan O(1) operations, incremental aggregates, dan packed storage[cite: 2].
 */
contract EarnAssetPool is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // Struktur compact (packed) untuk menghemat gas ke dalam 2 Storage Slot EVM[cite: 2]
    struct Position {
        uint256 principalRaw; // Slot 1: 256 bits[cite: 2]
        address owner;        // Slot 2: 160 bits[cite: 2]
        uint64 maturityAt;    // Slot 2: 64 bits[cite: 2]
        uint16 aprBps;        // Slot 2: 16 bits[cite: 2]
        uint8 termCode;       // Slot 2: 8 bits[cite: 2]
        uint8 status;         // Slot 2: 8 bits (0 = Active, 1 = Claimed)[cite: 2]
    }

    IERC20 public immutable assetToken;
    
    address public router;
    address public strategyTreasurySafe;
    address public rewardReserveSafe;
    address public feeTreasurySafe;
    address public governanceSafe;

    mapping(uint8 => uint16) public aprConfigs;
    uint16 public platformFeeBps = 0; 
    uint256 public minDeposit;

    // Incremental aggregates untuk menghindari looping yang memicu gas spike[cite: 2]
    uint256 public totalPrincipalLiability;
    uint256 public totalRewardLiability;
    uint256 public totalDeployedPrincipal;
    
    // Boundary enforcement untuk strategy deployment[cite: 2]
    uint256 public contractHardMaxDeployment;
    uint256 public liquidityBufferMin;

    mapping(uint256 => Position) public positions;
    uint256 public nextPositionId = 1;

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error UnsupportedTerm();
    error PositionNotFound();
    error NotPositionOwner();
    error PositionNotMatured();
    error AlreadyClaimed();
    error DeploymentCapExceeded();
    error SafeExecutionFailed();

    // Event on-chain untuk dibaca oleh backend indexer (PostgreSQL) tanpa redundant history on-chain[cite: 2]
    event EarnPositionCreated(address indexed user, uint256 indexed positionId, uint256 principal, uint64 maturityAt, uint16 aprBps);
    event EarnPositionClaimed(address indexed user, uint256 indexed positionId, uint256 principal, uint256 reward);
    event AprUpdated(uint8 termCode, uint16 aprBps);
    event PoolCapacityUpdated(uint256 hardMax, uint256 bufferMin);
    event StrategyDeployed(uint256 amount);
    event StrategyCapitalReturned(uint256 returnedPrincipal, uint256 realizedYield);
    event RewardReserveTopUp(uint256 amount);

    modifier onlyRouter() {
        if (msg.sender != router) revert Unauthorized();
        _;
    }

    modifier onlyStrategyOperator() {
        if (msg.sender != strategyTreasurySafe) revert Unauthorized();
        _;
    }

    constructor(
        address _assetToken,
        address _governanceSafe,
        address _strategyTreasurySafe,
        address _rewardReserveSafe,
        address _feeTreasurySafe
    ) Ownable(_governanceSafe) {
        if (_assetToken == address(0) || _governanceSafe == address(0)) revert InvalidAddress();
        assetToken = IERC20(_assetToken);
        governanceSafe = _governanceSafe;
        strategyTreasurySafe = _strategyTreasurySafe;
        rewardReserveSafe = _rewardReserveSafe;
        feeTreasurySafe = _feeTreasurySafe;
    }

    function setRouter(address _router) external onlyOwner {
        if (_router == address(0)) revert InvalidAddress();
        router = _router;
    }

    function setAPR(uint8 termCode, uint16 aprBps) external onlyOwner {
        aprConfigs[termCode] = aprBps;
        emit AprUpdated(termCode, aprBps);
    }

    function setPlatformFeeBps(uint16 _feeBps) external onlyOwner {
        platformFeeBps = _feeBps;
    }

    function setLimits(uint256 _hardMax, uint256 _bufferMin, uint256 _minDeposit) external onlyOwner {
        contractHardMaxDeployment = _hardMax;
        liquidityBufferMin = _bufferMin;
        minDeposit = _minDeposit;
        emit PoolCapacityUpdated(_hardMax, _bufferMin);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice O(1) Create Earn. Principal ditransfer ke Pool, platform fee ke Fee Treasury[cite: 2].
     */
    function createEarn(address user, uint256 amount, uint8 termCode) external onlyRouter nonReentrant whenNotPaused {
        if (amount < minDeposit) revert InvalidAmount();
        
        uint16 currentAprBps = aprConfigs[termCode];
        if (currentAprBps == 0) revert UnsupportedTerm();

        uint256 platformFee = (amount * platformFeeBps) / 10000;
        uint256 principal = amount - platformFee;

        // Principal ditransfer langsung dari User ke Pool secara atomic[cite: 2]
        assetToken.safeTransferFrom(user, address(this), amount);

        if (platformFee > 0) {
            assetToken.safeTransfer(feeTreasurySafe, platformFee);
        }

        // Kalkulasi reward deterministic saat pembuatan posisi[cite: 2]
        uint256 expectedReward = (principal * currentAprBps * termCode) / (365 * 10000);

        // Update kewajiban secara inkremental tanpa melakukan looping pada posisi sebelumnya[cite: 2]
        totalPrincipalLiability += principal;
        totalRewardLiability += expectedReward;

        uint64 maturityAt = uint64(block.timestamp + (termCode * 1 days));
        uint256 posId = nextPositionId++;

        positions[posId] = Position({
            principalRaw: principal,
            owner: user,
            maturityAt: maturityAt,
            aprBps: currentAprBps,
            termCode: termCode,
            status: 0
        });

        emit EarnPositionCreated(user, posId, principal, maturityAt, currentAprBps);
    }

    /**
     * @notice O(1) Claim. Pool mentransfer final payout ke user langsung[cite: 2]. 
     * Apabila terjadi shortfall, Pool otomatis mengambil saldo dari Reward Reserve melalui executetransaction[cite: 2].
     */
    function claim(address user, uint256 positionId) external onlyRouter nonReentrant whenNotPaused {
        Position storage pos = positions[positionId];
        
        if (pos.owner == address(0)) revert PositionNotFound();
        if (pos.owner != user) revert NotPositionOwner();
        if (pos.status == 1) revert AlreadyClaimed();
        
        // Memastikan dana baru dapat di-claim pada atau setelah masa jatuh tempo[cite: 2]
        if (block.timestamp < pos.maturityAt) revert PositionNotMatured(); 

        pos.status = 1;

        // Reward derived calculation, bukan mengambil dari dedicated storage slot[cite: 2]
        uint256 reward = (pos.principalRaw * pos.aprBps * pos.termCode) / (365 * 10000);
        uint256 totalPayout = pos.principalRaw + reward;

        // Penurunan kewajiban secara inkremental saat claim[cite: 2]
        totalPrincipalLiability -= pos.principalRaw;
        totalRewardLiability -= reward;

        uint256 liquidBalance = assetToken.balanceOf(address(this));
        
        // Meminta temporary reward/liquidity support dari Reward Reserve Safe jika Pool shortfall[cite: 2]
        if (liquidBalance < totalPayout) {
            uint256 shortfall = totalPayout - liquidBalance;
            
            bytes memory transferData = abi.encodeWithSignature("transfer(address,uint256)", address(this), shortfall);
            bool success = ISafe(rewardReserveSafe).execTransactionFromModule(address(assetToken), 0, transferData, 0);
            if (!success) revert SafeExecutionFailed();
            
            emit RewardReserveTopUp(shortfall);
        }

        assetToken.safeTransfer(user, totalPayout);

        emit EarnPositionClaimed(user, positionId, pos.principalRaw, reward);
    }

    /**
     * @notice Eksekusi Strategy Deployment oleh Safe 2/3. Pool memvalidasi hard enforcement boundary dari nilai backend recommendation[cite: 2].
     */
    function deployToStrategy(uint256 amount) external onlyStrategyOperator nonReentrant {
        // Revert transaksi apabila melebihi Contract Hard Max[cite: 2]
        if (totalDeployedPrincipal + amount > contractHardMaxDeployment) revert DeploymentCapExceeded();
        
        // Revert transaksi apabila melanggar Liquidity Buffer Min[cite: 2]
        uint256 liquidBalance = assetToken.balanceOf(address(this));
        if (liquidBalance - amount < liquidityBufferMin) revert DeploymentCapExceeded();

        totalDeployedPrincipal += amount;
        assetToken.safeTransfer(strategyTreasurySafe, amount);

        emit StrategyDeployed(amount);
    }

    /**
     * @notice Mencatat capital return dari Strategy Treasury kembali ke Pool. Memperbarui accounting tanpa plain ERC-20 transfer[cite: 2].
     */
    function returnFromStrategy(uint256 returnedPrincipal, uint256 realizedYield) external onlyStrategyOperator nonReentrant {
        uint256 totalReturn = returnedPrincipal + realizedYield;
        assetToken.safeTransferFrom(msg.sender, address(this), totalReturn);
        
        if (totalDeployedPrincipal >= returnedPrincipal) {
            totalDeployedPrincipal -= returnedPrincipal;
        } else {
            totalDeployedPrincipal = 0;
        }

        emit StrategyCapitalReturned(returnedPrincipal, realizedYield);
    }
}
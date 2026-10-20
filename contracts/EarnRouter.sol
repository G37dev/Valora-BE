// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IEarnPool {
    function createEarn(address user, uint256 amount, uint16 termCode) external;
    function claim(address user, uint256 positionId) external;
}

/**
 * @title EarnRouter
 * @notice Router contract for VIVALORA Earn Module. 
 * Mematuhi arsitektur Thin Router tanpa custody dana secara permanen[cite: 2].
 */
contract EarnRouter is Ownable, Pausable {
    
    // Mapping token asset ke kontrak Pool yang sesuai[cite: 2]
    mapping(address => address) public assetPools;

    event PoolUpdated(address indexed token, address indexed pool);
    event EarnRouted(address indexed user, address indexed token, uint256 amount, uint16 termCode);
    event ClaimRouted(address indexed user, address indexed token, uint256 positionId);

    error InvalidAddress();
    error PoolNotSupported();

    constructor(address _governanceSafe) Ownable(_governanceSafe) {
        if (_governanceSafe == address(0)) revert InvalidAddress();
    }

    function setAssetPool(address token, address pool) external onlyOwner {
        if (token == address(0) || pool == address(0)) revert InvalidAddress();
        assetPools[token] = pool;
        emit PoolUpdated(token, pool);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice User memanggil fungsi ini untuk membuka posisi Earn. Router mengorkestrasi principal routing[cite: 2].
     */
    function createEarn(address token, uint256 amount, uint16 termCode) external whenNotPaused {
        address pool = assetPools[token];
        if (pool == address(0)) revert PoolNotSupported();

        emit EarnRouted(msg.sender, token, amount, termCode);
        
        IEarnPool(pool).createEarn(msg.sender, amount, termCode);
    }

    /**
     * @notice User memanggil fungsi ini untuk mencairkan dana saat maturity[cite: 2].
     */
    function claim(address token, uint256 positionId) external whenNotPaused {
        address pool = assetPools[token];
        if (pool == address(0)) revert PoolNotSupported();

        emit ClaimRouted(msg.sender, token, positionId);
        IEarnPool(pool).claim(msg.sender, positionId);
    }
}
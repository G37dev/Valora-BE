// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RewardReserve
 * @notice Kontrak tiruan pengganti Safe{Global} untuk menyimulasikan brankas Reward Reserve.
 */
contract RewardReserve {
    
    event MockTransactionExecuted(address indexed to, uint256 value, bytes data);

    /**
     * @notice Fungsi ini adalah replika persis dari fungsi bawaan Safe{Global}.
     * Saat EarnAssetPool kehabisan dana dan meminta top-up, ia akan memanggil fungsi ini.
     */
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        uint8 /* operation */
    ) external returns (bool success) {
        
        // Mengeksekusi data payload (berisi perintah transfer token ERC-20)
        (success, ) = to.call(data);
        require(success, "Mock: Eksekusi transfer gagal");

        emit MockTransactionExecuted(to, value, data);
        return success;
    }

    // Menerima native token (ETH/BNB) jika diperlukan
    receive() external payable {}
}
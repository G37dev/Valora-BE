// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract SwapAssetPool is
    Ownable,
    AccessControl,
    ReentrancyGuard,
    Pausable
{
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE =
        keccak256("OPERATOR_ROLE");

    mapping(address => bool) public supportedTokens;

    address[] private supportedTokenList;

    event TokenSupported(
        address indexed token,
        bool supported
    );

    event Deposited(
        address indexed token,
        address indexed from,
        uint256 amount
    );

    event Withdrawn(
        address indexed token,
        address indexed to,
        uint256 amount
    );

    event OperatorUpdated(
        address indexed account,
        bool enabled
    );

    error InvalidAddress();
    error InvalidAmount();
    error UnsupportedToken();
    error InsufficientBalance();
    error TransferFailed();

    constructor(
        address initialOwner,
        address initialOperator,
        address[] memory tokens
    ) Ownable(initialOwner) {
        if (initialOwner == address(0)) {
            revert InvalidAddress();
        }

        if (initialOperator == address(0)) {
            revert InvalidAddress();
        }

        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
        _grantRole(OPERATOR_ROLE, initialOperator);

        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) {
                revert InvalidAddress();
            }

            if (!supportedTokens[tokens[i]]) {
                supportedTokens[tokens[i]] = true;
                supportedTokenList.push(tokens[i]);

                emit TokenSupported(tokens[i], true);
            }
        }
    }

    modifier onlySupportedToken(address token) {
        if (!supportedTokens[token]) {
            revert UnsupportedToken();
        }

        _;
    }

    // =============================================================
    // ADMIN
    // =============================================================

    function setSupportedToken(
        address token,
        bool supported
    ) external onlyOwner {
        if (token == address(0)) {
            revert InvalidAddress();
        }

        supportedTokens[token] = supported;

        if (supported) {
            bool exists = false;

            for (uint256 i = 0; i < supportedTokenList.length; i++) {
                if (supportedTokenList[i] == token) {
                    exists = true;
                    break;
                }
            }

            if (!exists) {
                supportedTokenList.push(token);
            }
        }

        emit TokenSupported(token, supported);
    }

    function setOperator(
        address account,
        bool enabled
    ) external onlyOwner {
        if (account == address(0)) {
            revert InvalidAddress();
        }

        if (enabled) {
            _grantRole(OPERATOR_ROLE, account);
        } else {
            _revokeRole(OPERATOR_ROLE, account);
        }

        emit OperatorUpdated(account, enabled);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // =============================================================
    // DEPOSIT
    // =============================================================

    function deposit(
        address token,
        uint256 amount
    )
        external
        nonReentrant
        whenNotPaused
        onlySupportedToken(token)
    {
        if (amount == 0) {
            revert InvalidAmount();
        }

        IERC20(token).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );

        emit Deposited(
            token,
            msg.sender,
            amount
        );
    }

    // =============================================================
    // WITHDRAW
    // =============================================================

    function withdraw(
        address token,
        address to,
        uint256 amount
    )
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
        onlySupportedToken(token)
    {
        if (to == address(0)) {
            revert InvalidAddress();
        }

        if (amount == 0) {
            revert InvalidAmount();
        }

        uint256 balance = IERC20(token).balanceOf(
            address(this)
        );

        if (balance < amount) {
            revert InsufficientBalance();
        }

        IERC20(token).safeTransfer(
            to,
            amount
        );

        emit Withdrawn(
            token,
            to,
            amount
        );
    }

    // =============================================================
    // VIEW
    // =============================================================

    function tokenBalance(
        address token
    )
        external
        view
        onlySupportedToken(token)
        returns (uint256)
    {
        return IERC20(token).balanceOf(
            address(this)
        );
    }

    function getSupportedTokens()
        external
        view
        returns (address[] memory)
    {
        return supportedTokenList;
    }

    function hasOperatorRole(
        address account
    )
        external
        view
        returns (bool)
    {
        return hasRole(
            OPERATOR_ROLE,
            account
        );
    }
}
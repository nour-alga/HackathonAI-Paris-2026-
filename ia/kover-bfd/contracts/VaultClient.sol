// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title VaultClient
 * @notice Treasury vault protected by KOVER.IA Behavioral Flow Detection circuit breaker.
 * @dev    Inherits Pausable + Ownable. Only the off-chain `koverSecurityBot` EOA may
 *         trigger `emergencyHalt()`. Owner retains administrative rotation powers.
 *
 *         Threat model: in the event of an anomalous liquidity-drain pattern detected
 *         by the off-chain ML inference engine, the bot front-runs the malicious tx
 *         by calling `emergencyHalt()` with aggressive priority fees, atomically
 *         pausing all user-facing entrypoints.
 */
contract VaultClient is Ownable, Pausable, ReentrancyGuard {
    /// @notice Authorized off-chain agent permitted to trigger the circuit breaker.
    address public koverSecurityBot;

    /// @notice Per-user deposited balances (wei).
    mapping(address => uint256) public balances;

    /// @notice Total value locked in the vault.
    uint256 public totalValueLocked;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Deposit(address indexed user, uint256 amount, uint256 timestamp);
    event Withdraw(address indexed user, uint256 amount, uint256 timestamp);
    event CircuitBreakerTriggered(address indexed origin, uint256 timestamp);
    event SecurityBotRotated(address indexed previous, address indexed current);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotSecurityBot();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance();
    error TransferFailed();

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlySecurityBot() {
        if (msg.sender != koverSecurityBot) revert NotSecurityBot();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @param _koverSecurityBot Address of the KOVER.IA off-chain bot. Immutable role,
     *                          but may be rotated post-deployment by the owner.
     */
    constructor(address _koverSecurityBot) Ownable(msg.sender) {
        if (_koverSecurityBot == address(0)) revert ZeroAddress();
        koverSecurityBot = _koverSecurityBot;
    }

    /*//////////////////////////////////////////////////////////////
                            CORE TREASURY
    //////////////////////////////////////////////////////////////*/

    /// @notice Deposit native ETH into the vault. Disabled when paused.
    function deposit() external payable whenNotPaused nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        balances[msg.sender] += msg.value;
        totalValueLocked += msg.value;
        emit Deposit(msg.sender, msg.value, block.timestamp);
    }

    /// @notice Withdraw native ETH from the vault. Disabled when paused.
    /// @param amount Amount in wei to withdraw.
    function withdraw(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balances[msg.sender];
        if (bal < amount) revert InsufficientBalance();

        // CEI pattern.
        balances[msg.sender] = bal - amount;
        totalValueLocked -= amount;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdraw(msg.sender, amount, block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                          CIRCUIT BREAKER
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Pauses the vault upon detection of anomalous behavioral flow.
     * @dev    Restricted to `koverSecurityBot`. Emits `CircuitBreakerTriggered`
     *         with `tx.origin` so on-chain forensics can trace the actual EOA
     *         that authorized the halt (relayer-aware).
     */
    function emergencyHalt() external onlySecurityBot {
        _pause();
        emit CircuitBreakerTriggered(tx.origin, block.timestamp);
    }

    /// @notice Owner-only resume after incident review.
    function resume() external onlyOwner {
        _unpause();
    }

    /// @notice Rotate the off-chain security bot key (e.g. HSM rotation).
    function rotateSecurityBot(address newBot) external onlyOwner {
        if (newBot == address(0)) revert ZeroAddress();
        emit SecurityBotRotated(koverSecurityBot, newBot);
        koverSecurityBot = newBot;
    }
}

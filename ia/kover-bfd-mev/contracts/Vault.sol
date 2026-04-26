// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  Vault
 * @notice Treasury vault protected by the KOVER.IA off-chain sentinel.
 * @dev    Hardened layout:
 *           - Pausable: emergency halt suspends every user-facing entrypoint.
 *           - Ownable: admin-only functions for resume + bot rotation.
 *           - ReentrancyGuard on every state-changing user-facing function.
 *           - Custom errors instead of require strings (gas-cheap reverts).
 *           - 6-hour cooldown between bot key rotations (defence against a
 *             compromised owner silently disarming the circuit-breaker).
 *           - Per-user deposit cap (`maxDepositPerUser`) to bound blast radius.
 *           - Global TVL cap (`maxTotalValueLocked`) to bound institutional
 *             exposure if the protocol is later embedded in a larger product.
 *           - Donation accounting: `selfdestruct` and direct base-fee refunds
 *             credit `address(this).balance` without touching `totalValueLocked`.
 *             A `recoverDust()` lets the owner sweep the unaccounted residue
 *             to a beneficiary; user balances are never affected.
 *           - `forceWithdraw` for the owner to refund a single user when the
 *             vault is paused (incident-recovery escape hatch).
 *
 *         Threat model: see SECURITY.md. The on-chain attack surface is
 *         minimal by design — the heavy lifting is off-chain.
 *
 * @author KOVER.IA platform team
 * @custom:security-contact security@kover.ia
 */
contract Vault is Ownable, Pausable, ReentrancyGuard {
    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Off-chain agent permitted to call `emergencyHalt()`.
    address public securityBot;

    /// @notice Earliest timestamp at which `rotateSecurityBot` may be called again.
    uint256 public botRotationUnlockAt;

    /// @notice Mandatory delay between consecutive bot rotations.
    uint256 public constant ROTATION_DELAY = 6 hours;

    /// @notice Per-address deposit ceiling. 0 means uncapped.
    uint256 public maxDepositPerUser;

    /// @notice Global TVL ceiling. 0 means uncapped.
    uint256 public maxTotalValueLocked;

    /// @notice Per-user deposited balances (wei).
    mapping(address => uint256) public balances;

    /// @notice Sum of all user balances. Always <= address(this).balance.
    uint256 public totalValueLocked;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance();
    error TransferFailed();
    error RotationLocked(uint256 unlockAt);
    error DepositCapExceeded(uint256 attempted, uint256 cap);
    error TvlCapExceeded(uint256 attempted, uint256 cap);
    error MustBePaused();
    error NoDustToSweep();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);
    event ForceWithdraw(address indexed user, uint256 amount, address indexed by);
    event CircuitBreakerTriggered(address indexed origin, address indexed bot, uint256 timestamp);
    event Resumed(address indexed by, uint256 timestamp);
    event SecurityBotRotated(address indexed previous, address indexed current);
    event LimitsUpdated(uint256 maxDepositPerUser, uint256 maxTotalValueLocked);
    event DustSwept(address indexed beneficiary, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlySecurityBot() {
        if (msg.sender != securityBot) revert Unauthorized();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @param _securityBot         off-chain bot allowed to call emergencyHalt()
     * @param _maxDepositPerUser   per-user deposit cap (wei). 0 = uncapped.
     * @param _maxTotalValueLocked global TVL cap (wei). 0 = uncapped.
     */
    constructor(
        address _securityBot,
        uint256 _maxDepositPerUser,
        uint256 _maxTotalValueLocked
    ) Ownable(msg.sender) {
        if (_securityBot == address(0)) revert ZeroAddress();
        securityBot = _securityBot;
        maxDepositPerUser = _maxDepositPerUser;
        maxTotalValueLocked = _maxTotalValueLocked;
        emit LimitsUpdated(_maxDepositPerUser, _maxTotalValueLocked);
    }

    /*//////////////////////////////////////////////////////////////
                            CORE TREASURY
    //////////////////////////////////////////////////////////////*/

    /// @notice Deposit native ETH into the vault. Disabled when paused.
    function deposit() external payable whenNotPaused nonReentrant {
        if (msg.value == 0) revert ZeroAmount();

        uint256 newUserBalance = balances[msg.sender] + msg.value;
        if (maxDepositPerUser != 0 && newUserBalance > maxDepositPerUser) {
            revert DepositCapExceeded(newUserBalance, maxDepositPerUser);
        }
        uint256 newTvl = totalValueLocked + msg.value;
        if (maxTotalValueLocked != 0 && newTvl > maxTotalValueLocked) {
            revert TvlCapExceeded(newTvl, maxTotalValueLocked);
        }

        // Safe arithmetic enforced by caps + Solidity 0.8 default checks.
        balances[msg.sender] = newUserBalance;
        totalValueLocked   = newTvl;

        emit Deposit(msg.sender, msg.value);
    }

    /// @notice Withdraw native ETH from the vault. Disabled when paused.
    /// @param amount Amount in wei to withdraw.
    function withdraw(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balances[msg.sender];
        if (bal < amount) revert InsufficientBalance();

        // Effects before interactions (CEI).
        unchecked {
            balances[msg.sender] = bal - amount;
            totalValueLocked   -= amount;
        }

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdraw(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                          CIRCUIT BREAKER
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Off-chain riposte entrypoint. Pauses every user-facing function.
     * @dev    The event includes BOTH `tx.origin` (the EOA that signed,
     *         useful for forensics in relayer scenarios) AND the bot address
     *         (for unambiguous attribution to the responding KOVER node).
     */
    function emergencyHalt() external onlySecurityBot {
        _pause();
        emit CircuitBreakerTriggered(tx.origin, msg.sender, block.timestamp);
    }

    /// @notice Owner-only resume after incident review.
    function resume() external onlyOwner {
        _unpause();
        emit Resumed(msg.sender, block.timestamp);
    }

    /**
     * @notice Rotate the off-chain security bot key (e.g. HSM rotation).
     * @dev    Subject to the {ROTATION_DELAY} cooldown — even an attacker
     *         who steals the owner key cannot silently disarm the breaker
     *         immediately after a rotation.
     */
    function rotateSecurityBot(address newBot) external onlyOwner {
        if (newBot == address(0)) revert ZeroAddress();
        if (block.timestamp < botRotationUnlockAt) revert RotationLocked(botRotationUnlockAt);

        emit SecurityBotRotated(securityBot, newBot);
        securityBot = newBot;
        botRotationUnlockAt = block.timestamp + ROTATION_DELAY;
    }

    /*//////////////////////////////////////////////////////////////
                          OPERATIONAL ADMIN
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update the deposit caps. Tightening is always safe; loosening
     *         retroactively only affects future deposits — existing balances
     *         are unaffected even if `maxDepositPerUser` is lowered below
     *         a user's current balance.
     */
    function setLimits(uint256 _maxDepositPerUser, uint256 _maxTotalValueLocked) external onlyOwner {
        maxDepositPerUser   = _maxDepositPerUser;
        maxTotalValueLocked = _maxTotalValueLocked;
        emit LimitsUpdated(_maxDepositPerUser, _maxTotalValueLocked);
    }

    /**
     * @notice Owner-only refund of a specific user's balance. Available ONLY
     *         while the vault is paused — i.e. during incident recovery.
     *         Lets the team unwind individual exposures without lifting the
     *         circuit breaker for the whole user base.
     */
    function forceWithdraw(address user) external onlyOwner whenPaused nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        uint256 bal = balances[user];
        if (bal == 0) revert ZeroAmount();

        unchecked {
            balances[user]   = 0;
            totalValueLocked -= bal;
        }
        (bool ok, ) = payable(user).call{value: bal}("");
        if (!ok) revert TransferFailed();
        emit ForceWithdraw(user, bal, msg.sender);
    }

    /**
     * @notice Sweeps any unaccounted ETH residue (donations, base-fee
     *         refunds, selfdestruct gifts) to a beneficiary. NEVER touches
     *         user balances — only the difference between `address(this).balance`
     *         and `totalValueLocked`. Available regardless of pause state.
     */
    function recoverDust(address payable beneficiary) external onlyOwner nonReentrant {
        if (beneficiary == address(0)) revert ZeroAddress();
        uint256 dust = address(this).balance - totalValueLocked;
        if (dust == 0) revert NoDustToSweep();
        (bool ok, ) = beneficiary.call{value: dust}("");
        if (!ok) revert TransferFailed();
        emit DustSwept(beneficiary, dust);
    }

    /*//////////////////////////////////////////////////////////////
                          DEFAULT REJECTORS
    //////////////////////////////////////////////////////////////*/

    /// @dev Rejects bare ETH transfers — users must go through `deposit()`
    ///      so accounting stays consistent. Unaccounted ETH from selfdestruct
    ///      or block-reward refunds is recoverable via `recoverDust()`.
    receive() external payable {
        revert("use deposit()");
    }

    fallback() external payable {
        revert("unknown function");
    }
}

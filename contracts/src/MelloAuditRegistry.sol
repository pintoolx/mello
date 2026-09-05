// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title MelloAuditRegistry
/// @notice Anchors the minimum evidence needed to audit a Mello purchase.
/// @dev This contract never holds payment assets or performs x402 settlement.
contract MelloAuditRegistry is AccessControl, Pausable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    enum PurchaseStatus {
        NONE,
        AUTHORIZED,
        FINALIZED,
        FAILED
    }

    struct PurchaseRecord {
        address buyer;
        address seller;
        address token;
        uint96 maxAmount;
        uint96 actualAmount;
        uint64 expiresAt;
        PurchaseStatus status;
        bytes32 mandateHash;
        bytes32 policyHash;
        bytes32 paymentAuthorizationHash;
        bytes32 settlementTxHash;
        bytes32 receiptHash;
        bytes32 invoiceHash;
        bytes32 reconciliationHash;
    }

    error PurchaseAlreadyExists(bytes32 purchaseId);
    error InvalidPurchaseStatus(
        bytes32 purchaseId,
        PurchaseStatus expected,
        PurchaseStatus actual
    );
    error ZeroAddress();
    error ZeroAmount();
    error AmountExceedsUint96(uint256 amount);
    error MandateExpired(uint64 expiresAt, uint256 currentTimestamp);
    error ZeroEvidenceHash(bytes32 field);
    error ActualAmountExceedsMaximum(uint256 actualAmount, uint256 maxAmount);

    event PurchaseAuthorized(
        bytes32 indexed purchaseId,
        address indexed buyer,
        address indexed seller,
        address token,
        uint256 maxAmount,
        uint64 expiresAt,
        bytes32 mandateHash,
        bytes32 policyHash,
        bytes32 paymentAuthorizationHash
    );

    event PurchaseFinalized(
        bytes32 indexed purchaseId,
        uint256 actualAmount,
        bytes32 settlementTxHash,
        bytes32 receiptHash,
        bytes32 invoiceHash,
        bytes32 reconciliationHash
    );

    event PurchaseFailed(bytes32 indexed purchaseId, bytes32 reasonHash);

    bytes32 private constant PAYMENT_AUTHORIZATION_FIELD =
        keccak256("paymentAuthorizationHash");
    bytes32 private constant SETTLEMENT_TX_FIELD = keccak256("settlementTxHash");
    bytes32 private constant INVOICE_FIELD = keccak256("invoiceHash");
    bytes32 private constant RECONCILIATION_FIELD = keccak256("reconciliationHash");

    mapping(bytes32 purchaseId => PurchaseRecord record) private purchases;

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }

    /// @notice Records the policy-approved mandate before x402 settlement.
    function authorizePurchase(
        bytes32 purchaseId,
        address buyer,
        address seller,
        address token,
        uint256 maxAmount,
        uint64 expiresAt,
        bytes32 mandateHash,
        bytes32 policyHash,
        bytes32 paymentAuthorizationHash
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused {
        if (purchases[purchaseId].status != PurchaseStatus.NONE) {
            revert PurchaseAlreadyExists(purchaseId);
        }
        if (buyer == address(0) || seller == address(0) || token == address(0)) {
            revert ZeroAddress();
        }
        if (maxAmount == 0) {
            revert ZeroAmount();
        }
        if (maxAmount > type(uint96).max) {
            revert AmountExceedsUint96(maxAmount);
        }
        if (expiresAt <= block.timestamp) {
            revert MandateExpired(expiresAt, block.timestamp);
        }
        if (paymentAuthorizationHash == bytes32(0)) {
            revert ZeroEvidenceHash(PAYMENT_AUTHORIZATION_FIELD);
        }

        purchases[purchaseId] = PurchaseRecord({
            buyer: buyer,
            seller: seller,
            token: token,
            maxAmount: uint96(maxAmount),
            actualAmount: 0,
            expiresAt: expiresAt,
            status: PurchaseStatus.AUTHORIZED,
            mandateHash: mandateHash,
            policyHash: policyHash,
            paymentAuthorizationHash: paymentAuthorizationHash,
            settlementTxHash: bytes32(0),
            receiptHash: bytes32(0),
            invoiceHash: bytes32(0),
            reconciliationHash: bytes32(0)
        });

        emit PurchaseAuthorized(
            purchaseId,
            buyer,
            seller,
            token,
            maxAmount,
            expiresAt,
            mandateHash,
            policyHash,
            paymentAuthorizationHash
        );
    }

    /// @notice Finalizes an authorized purchase after delivery, invoicing, and reconciliation.
    function finalizePurchase(
        bytes32 purchaseId,
        uint256 actualAmount,
        bytes32 settlementTxHash,
        bytes32 receiptHash,
        bytes32 invoiceHash,
        bytes32 reconciliationHash
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused {
        PurchaseRecord storage purchase = purchases[purchaseId];

        if (purchase.status != PurchaseStatus.AUTHORIZED) {
            revert InvalidPurchaseStatus(
                purchaseId,
                PurchaseStatus.AUTHORIZED,
                purchase.status
            );
        }
        if (actualAmount > purchase.maxAmount) {
            revert ActualAmountExceedsMaximum(actualAmount, purchase.maxAmount);
        }
        if (settlementTxHash == bytes32(0)) {
            revert ZeroEvidenceHash(SETTLEMENT_TX_FIELD);
        }
        if (invoiceHash == bytes32(0)) {
            revert ZeroEvidenceHash(INVOICE_FIELD);
        }
        if (reconciliationHash == bytes32(0)) {
            revert ZeroEvidenceHash(RECONCILIATION_FIELD);
        }

        purchase.actualAmount = uint96(actualAmount);
        purchase.status = PurchaseStatus.FINALIZED;
        purchase.settlementTxHash = settlementTxHash;
        purchase.receiptHash = receiptHash;
        purchase.invoiceHash = invoiceHash;
        purchase.reconciliationHash = reconciliationHash;

        emit PurchaseFinalized(
            purchaseId,
            actualAmount,
            settlementTxHash,
            receiptHash,
            invoiceHash,
            reconciliationHash
        );
    }

    /// @notice Marks an authorized purchase as irrecoverably failed.
    /// @dev Failure reasons are emitted as hashes and are intentionally not stored as plaintext.
    function markFailed(
        bytes32 purchaseId,
        bytes32 reasonHash
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused {
        PurchaseRecord storage purchase = purchases[purchaseId];

        if (purchase.status != PurchaseStatus.AUTHORIZED) {
            revert InvalidPurchaseStatus(
                purchaseId,
                PurchaseStatus.AUTHORIZED,
                purchase.status
            );
        }

        purchase.status = PurchaseStatus.FAILED;
        emit PurchaseFailed(purchaseId, reasonHash);
    }

    function getPurchase(
        bytes32 purchaseId
    ) external view returns (PurchaseRecord memory) {
        return purchases[purchaseId];
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}

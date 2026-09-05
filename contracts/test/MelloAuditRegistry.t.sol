// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MelloAuditRegistry} from "../src/MelloAuditRegistry.sol";

interface Vm {
    function prank(address sender) external;
    function expectRevert() external;
    function expectRevert(bytes calldata revertData) external;
    function expectEmit(
        bool checkTopic1,
        bool checkTopic2,
        bool checkTopic3,
        bool checkData,
        address emitter
    ) external;
}

abstract contract TestBase {
    Vm internal constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool condition, string memory message) internal pure {
        require(condition, message);
    }

    function assertEq(uint256 actual, uint256 expected, string memory message) internal pure {
        require(actual == expected, message);
    }

    function assertEq(address actual, address expected, string memory message) internal pure {
        require(actual == expected, message);
    }

    function assertEq(bytes32 actual, bytes32 expected, string memory message) internal pure {
        require(actual == expected, message);
    }
}

contract MelloAuditRegistryTest is TestBase {
    MelloAuditRegistry internal registry;

    address internal constant BUYER = address(0xB0B);
    address internal constant SELLER = address(0x5E11E2);
    address internal constant TOKEN = address(0xC0FFEE);
    address internal constant OUTSIDER = address(0xBAD);

    uint256 internal constant MAX_AMOUNT = 100_000;
    uint256 internal constant ACTUAL_AMOUNT = 50_000;

    bytes32 internal purchaseId;
    bytes32 internal mandateHash;
    bytes32 internal policyHash;
    bytes32 internal paymentAuthorizationHash;
    bytes32 internal settlementTxHash;
    bytes32 internal receiptHash;
    bytes32 internal invoiceHash;
    bytes32 internal reconciliationHash;
    bytes32 internal failureReasonHash;

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

    function setUp() public {
        registry = new MelloAuditRegistry();
        purchaseId = keccak256("purchase-1");
        mandateHash = keccak256("mandate");
        policyHash = keccak256("policy");
        paymentAuthorizationHash = keccak256("erc3009-authorization");
        settlementTxHash = keccak256("settlement-transaction");
        receiptHash = keccak256("delivery-receipt");
        invoiceHash = keccak256("demo-invoice");
        reconciliationHash = keccak256("reconciliation");
        failureReasonHash = keccak256("failure-reason");
    }

    function testDeployerHasAdminAndOperatorRoles() public view {
        assertTrue(
            registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), address(this)),
            "deployer missing admin role"
        );
        assertTrue(
            registry.hasRole(registry.OPERATOR_ROLE(), address(this)),
            "deployer missing operator role"
        );
    }

    function testNonOperatorCannotAuthorize() public {
        vm.expectRevert();
        vm.prank(OUTSIDER);
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());
    }

    function testDuplicatePurchaseReverts() public {
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());

        vm.expectRevert(
            abi.encodeWithSelector(
                MelloAuditRegistry.PurchaseAlreadyExists.selector,
                purchaseId
            )
        );
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());
    }

    function testZeroBuyerReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(MelloAuditRegistry.ZeroAddress.selector)
        );
        registry.authorizePurchase(
            purchaseId,
            address(0),
            SELLER,
            TOKEN,
            MAX_AMOUNT,
            _futureExpiry(),
            mandateHash,
            policyHash,
            paymentAuthorizationHash
        );
    }

    function testZeroSellerReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(MelloAuditRegistry.ZeroAddress.selector)
        );
        registry.authorizePurchase(
            purchaseId,
            BUYER,
            address(0),
            TOKEN,
            MAX_AMOUNT,
            _futureExpiry(),
            mandateHash,
            policyHash,
            paymentAuthorizationHash
        );
    }

    function testZeroTokenReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(MelloAuditRegistry.ZeroAddress.selector)
        );
        registry.authorizePurchase(
            purchaseId,
            BUYER,
            SELLER,
            address(0),
            MAX_AMOUNT,
            _futureExpiry(),
            mandateHash,
            policyHash,
            paymentAuthorizationHash
        );
    }

    function testZeroAmountReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(MelloAuditRegistry.ZeroAmount.selector)
        );
        _authorize(purchaseId, 0, _futureExpiry());
    }

    function testAmountAboveUint96Reverts() public {
        uint256 oversizedAmount = uint256(type(uint96).max) + 1;

        vm.expectRevert(
            abi.encodeWithSelector(
                MelloAuditRegistry.AmountExceedsUint96.selector,
                oversizedAmount
            )
        );
        _authorize(purchaseId, oversizedAmount, _futureExpiry());
    }

    function testExpiredMandateReverts() public {
        uint64 expiredAt = uint64(block.timestamp);

        vm.expectRevert(
            abi.encodeWithSelector(
                MelloAuditRegistry.MandateExpired.selector,
                expiredAt,
                block.timestamp
            )
        );
        _authorize(purchaseId, MAX_AMOUNT, expiredAt);
    }

    function testZeroPaymentAuthorizationHashReverts() public {
        vm.expectRevert();
        registry.authorizePurchase(
            purchaseId,
            BUYER,
            SELLER,
            TOKEN,
            MAX_AMOUNT,
            _futureExpiry(),
            mandateHash,
            policyHash,
            bytes32(0)
        );
    }

    function testAuthorizeStoresCompleteRecord() public {
        uint64 expiresAt = _futureExpiry();
        _authorize(purchaseId, MAX_AMOUNT, expiresAt);

        MelloAuditRegistry.PurchaseRecord memory record = registry.getPurchase(
            purchaseId
        );

        assertEq(record.buyer, BUYER, "buyer mismatch");
        assertEq(record.seller, SELLER, "seller mismatch");
        assertEq(record.token, TOKEN, "token mismatch");
        assertEq(record.maxAmount, MAX_AMOUNT, "max amount mismatch");
        assertEq(record.actualAmount, 0, "actual amount not empty");
        assertEq(record.expiresAt, expiresAt, "expiry mismatch");
        assertEq(
            uint256(record.status),
            uint256(MelloAuditRegistry.PurchaseStatus.AUTHORIZED),
            "status mismatch"
        );
        assertEq(record.mandateHash, mandateHash, "mandate hash mismatch");
        assertEq(record.policyHash, policyHash, "policy hash mismatch");
        assertEq(
            record.paymentAuthorizationHash,
            paymentAuthorizationHash,
            "authorization hash mismatch"
        );
    }

    function testActualAmountAboveMaximumReverts() public {
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());

        vm.expectRevert(
            abi.encodeWithSelector(
                MelloAuditRegistry.ActualAmountExceedsMaximum.selector,
                MAX_AMOUNT + 1,
                MAX_AMOUNT
            )
        );
        _finalize(purchaseId, MAX_AMOUNT + 1);
    }

    function testCannotFinalizeUnknownPurchase() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                MelloAuditRegistry.InvalidPurchaseStatus.selector,
                purchaseId,
                MelloAuditRegistry.PurchaseStatus.AUTHORIZED,
                MelloAuditRegistry.PurchaseStatus.NONE
            )
        );
        _finalize(purchaseId, ACTUAL_AMOUNT);
    }

    function testFinalizeRejectsZeroRequiredEvidenceHashes() public {
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());

        vm.expectRevert();
        registry.finalizePurchase(
            purchaseId,
            ACTUAL_AMOUNT,
            bytes32(0),
            receiptHash,
            invoiceHash,
            reconciliationHash
        );

        vm.expectRevert();
        registry.finalizePurchase(
            purchaseId,
            ACTUAL_AMOUNT,
            settlementTxHash,
            receiptHash,
            bytes32(0),
            reconciliationHash
        );

        vm.expectRevert();
        registry.finalizePurchase(
            purchaseId,
            ACTUAL_AMOUNT,
            settlementTxHash,
            receiptHash,
            invoiceHash,
            bytes32(0)
        );
    }

    function testFinalizeStoresCompletionEvidence() public {
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());
        _finalize(purchaseId, ACTUAL_AMOUNT);

        MelloAuditRegistry.PurchaseRecord memory record = registry.getPurchase(
            purchaseId
        );

        assertEq(record.actualAmount, ACTUAL_AMOUNT, "actual amount mismatch");
        assertEq(
            uint256(record.status),
            uint256(MelloAuditRegistry.PurchaseStatus.FINALIZED),
            "status mismatch"
        );
        assertEq(
            record.settlementTxHash,
            settlementTxHash,
            "settlement hash mismatch"
        );
        assertEq(record.receiptHash, receiptHash, "receipt hash mismatch");
        assertEq(record.invoiceHash, invoiceHash, "invoice hash mismatch");
        assertEq(
            record.reconciliationHash,
            reconciliationHash,
            "reconciliation hash mismatch"
        );
    }

    function testFinalizedPurchaseCannotBeFinalizedAgainOrFailed() public {
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());
        _finalize(purchaseId, ACTUAL_AMOUNT);

        vm.expectRevert();
        _finalize(purchaseId, ACTUAL_AMOUNT);

        vm.expectRevert();
        registry.markFailed(purchaseId, failureReasonHash);
    }

    function testMarkFailedIsFinal() public {
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());
        registry.markFailed(purchaseId, failureReasonHash);

        MelloAuditRegistry.PurchaseRecord memory record = registry.getPurchase(
            purchaseId
        );
        assertEq(
            uint256(record.status),
            uint256(MelloAuditRegistry.PurchaseStatus.FAILED),
            "status mismatch"
        );

        vm.expectRevert();
        _finalize(purchaseId, ACTUAL_AMOUNT);

        vm.expectRevert();
        registry.markFailed(purchaseId, failureReasonHash);
    }

    function testPauseBlocksAllWritesAndUnpauseRestoresWrites() public {
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());
        registry.pause();

        vm.expectRevert();
        _authorize(keccak256("purchase-2"), MAX_AMOUNT, _futureExpiry());

        vm.expectRevert();
        _finalize(purchaseId, ACTUAL_AMOUNT);

        vm.expectRevert();
        registry.markFailed(purchaseId, failureReasonHash);

        registry.unpause();
        _finalize(purchaseId, ACTUAL_AMOUNT);
    }

    function testNonAdminCannotPause() public {
        vm.expectRevert();
        vm.prank(OUTSIDER);
        registry.pause();
    }

    function testPurchaseAuthorizedEventParameters() public {
        uint64 expiresAt = _futureExpiry();

        vm.expectEmit(true, true, true, true, address(registry));
        emit PurchaseAuthorized(
            purchaseId,
            BUYER,
            SELLER,
            TOKEN,
            MAX_AMOUNT,
            expiresAt,
            mandateHash,
            policyHash,
            paymentAuthorizationHash
        );
        _authorize(purchaseId, MAX_AMOUNT, expiresAt);
    }

    function testPurchaseFinalizedEventParameters() public {
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());

        vm.expectEmit(true, false, false, true, address(registry));
        emit PurchaseFinalized(
            purchaseId,
            ACTUAL_AMOUNT,
            settlementTxHash,
            receiptHash,
            invoiceHash,
            reconciliationHash
        );
        _finalize(purchaseId, ACTUAL_AMOUNT);
    }

    function testPurchaseFailedEventParameters() public {
        _authorize(purchaseId, MAX_AMOUNT, _futureExpiry());

        vm.expectEmit(true, false, false, true, address(registry));
        emit PurchaseFailed(purchaseId, failureReasonHash);
        registry.markFailed(purchaseId, failureReasonHash);
    }

    function testFuzzActualAmountNeverExceedsMaximum(
        uint96 rawMaximum,
        uint96 rawActual
    ) public {
        uint256 maximum = (uint256(rawMaximum) % type(uint96).max) + 1;
        uint256 actual = uint256(rawActual) % (maximum + 1);
        bytes32 fuzzPurchaseId = keccak256(
            abi.encodePacked("fuzz-purchase", rawMaximum, rawActual)
        );

        _authorize(fuzzPurchaseId, maximum, _futureExpiry());
        _finalize(fuzzPurchaseId, actual);

        MelloAuditRegistry.PurchaseRecord memory record = registry.getPurchase(
            fuzzPurchaseId
        );
        assertTrue(record.actualAmount <= record.maxAmount, "amount invariant broken");
        assertEq(record.actualAmount, actual, "actual amount mismatch");
    }

    function _authorize(
        bytes32 id,
        uint256 maxAmount,
        uint64 expiresAt
    ) internal {
        registry.authorizePurchase(
            id,
            BUYER,
            SELLER,
            TOKEN,
            maxAmount,
            expiresAt,
            mandateHash,
            policyHash,
            paymentAuthorizationHash
        );
    }

    function _finalize(bytes32 id, uint256 actualAmount) internal {
        registry.finalizePurchase(
            id,
            actualAmount,
            settlementTxHash,
            receiptHash,
            invoiceHash,
            reconciliationHash
        );
    }

    function _futureExpiry() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }
}

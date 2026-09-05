// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface VmReplay {
    function addr(uint256 privateKey) external returns (address);
    function sign(
        uint256 privateKey,
        bytes32 digest
    ) external returns (uint8 v, bytes32 r, bytes32 s);
    function expectRevert(bytes calldata revertData) external;
}

/// @dev Small EIP-3009 test token: it verifies the real EIP-712 signature and
///      consumes authorization nonces exactly where a compliant token does.
contract Erc3009TestToken {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    mapping(address account => uint256 balance) public balanceOf;
    mapping(address authorizer => mapping(bytes32 nonce => bool used))
        public authorizationState;

    error AuthorizationUsed(address authorizer, bytes32 nonce);
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error InvalidSignature();
    error InsufficientBalance();

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function domainSeparator() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH,
                    keccak256(bytes("USD Coin")),
                    keccak256(bytes("2")),
                    block.chainid,
                    address(this)
                )
            );
    }

    function authorizationDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        return
            keccak256(
                abi.encodePacked("\x19\x01", domainSeparator(), structHash)
            );
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (authorizationState[from][nonce]) {
            revert AuthorizationUsed(from, nonce);
        }
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        bytes32 digest = authorizationDigest(
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce
        );
        if (ecrecover(digest, v, r, s) != from) revert InvalidSignature();
        if (balanceOf[from] < value) revert InsufficientBalance();

        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

contract Erc3009ReplayTest {
    VmReplay internal constant vm =
        VmReplay(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant BUYER_KEY = 0xA11CE;
    uint256 internal constant STARTING_BALANCE = 1_000_000;
    uint256 internal constant PAYMENT_AMOUNT = 50_000;

    function testSameNonceCannotSettleTwice() public {
        Erc3009TestToken token = new Erc3009TestToken();
        address buyer = vm.addr(BUYER_KEY);
        address seller = address(0x5E11E2);
        bytes32 nonce = keccak256("mello-payment-nonce");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 300;
        token.mint(buyer, STARTING_BALANCE);

        bytes32 digest = token.authorizationDigest(
            buyer,
            seller,
            PAYMENT_AMOUNT,
            validAfter,
            validBefore,
            nonce
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);

        token.transferWithAuthorization(
            buyer,
            seller,
            PAYMENT_AMOUNT,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                Erc3009TestToken.AuthorizationUsed.selector,
                buyer,
                nonce
            )
        );
        token.transferWithAuthorization(
            buyer,
            seller,
            PAYMENT_AMOUNT,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        require(
            token.balanceOf(buyer) == STARTING_BALANCE - PAYMENT_AMOUNT,
            "buyer was debited twice"
        );
        require(
            token.balanceOf(seller) == PAYMENT_AMOUNT,
            "seller was paid twice"
        );
    }
}

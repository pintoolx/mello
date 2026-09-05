// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MelloAuditRegistry} from "../src/MelloAuditRegistry.sol";

interface Vm {
    function envUint(string calldata name) external returns (uint256 value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Foundry deployment script for Base Sepolia.
contract DeployMelloAuditRegistry {
    Vm private constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (MelloAuditRegistry registry) {
        uint256 operatorPrivateKey = vm.envUint("CONTRACT_OPERATOR_PRIVATE_KEY");

        vm.startBroadcast(operatorPrivateKey);
        registry = new MelloAuditRegistry();
        vm.stopBroadcast();
    }
}

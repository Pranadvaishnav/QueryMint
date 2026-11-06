// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QueryMintSettlement} from "../src/QueryMintSettlement.sol";

interface VmDeployment {
    function envAddress(string calldata name) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Deployment entry point. It is intentionally never run by the app's
///         build or validation scripts; broadcasting requires an explicit user action.
contract DeployQueryMint {
    VmDeployment private constant vm = VmDeployment(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant WHITECHAIN_SEPOLIA_CHAIN_ID = 1874;
    address private constant OFFICIAL_WHITECHAIN_USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;

    error WrongChain(uint256 actualChainId);
    error WrongUsdtAddress(address configuredAddress);

    function run() external returns (QueryMintSettlement settlement) {
        uint256 activeChainId = block.chainid;
        if (activeChainId != WHITECHAIN_SEPOLIA_CHAIN_ID) revert WrongChain(activeChainId);
        address usdt = vm.envAddress("WHITECHAIN_USDT_ADDRESS");
        if (usdt != OFFICIAL_WHITECHAIN_USDT) revert WrongUsdtAddress(usdt);
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        settlement = new QueryMintSettlement(usdt);
        vm.stopBroadcast();
    }
}

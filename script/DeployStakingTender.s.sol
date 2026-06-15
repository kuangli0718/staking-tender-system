// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {StakingTender} from "../src/StakingTender.sol";

contract DeployStakingTenderScript is Script {
    function run() external returns (StakingTender deployed) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        deployed = new StakingTender();
        vm.stopBroadcast();
    }
}

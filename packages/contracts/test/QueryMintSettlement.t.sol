// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QueryMintSettlement} from "../src/QueryMintSettlement.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function warp(uint256 timestamp) external;
}

contract MockUSDT {
    uint8 public constant decimals = 6;
    string public constant symbol = "USDT";
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failPayoutTransfer;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setBalance(address account, uint256 amount) external { balanceOf[account] = amount; }
    function setFailPayoutTransfer(bool value) external { failPayoutTransfer = value; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (failPayoutTransfer) return false;
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract QueryMintSettlementTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant COORDINATOR_KEY = 0xA11CE;
    uint256 private constant BUYER_KEY = 0xB0B;
    uint256 private constant PUBLISHER_A_KEY = 0xA001;
    uint256 private constant PUBLISHER_B_KEY = 0xB001;
    uint256 private constant PUBLISHER_C_KEY = 0xC001;
    uint256 private constant PUBLISHER_D_KEY = 0xD001;
    uint256 private constant PUBLISHER_E_KEY = 0xE001;
    uint128 private constant PRICE = 2_000_000; // 2 USDT at verified 6 decimals
    uint64 private constant QUOTE_SECONDS = 300;

    MockUSDT private token;
    QueryMintSettlement private settlement;
    address private buyer;
    address private coordinator;

    event GasMeasured(uint256 allocations, uint256 records, uint256 settleGas);

    function setUp() public {
        token = new MockUSDT();
        settlement = new QueryMintSettlement(address(token));
        buyer = vm.addr(BUYER_KEY);
        coordinator = vm.addr(COORDINATOR_KEY);
        _registerPublisher(0);
        _registerPublisher(1);
        _registerPublisher(2);
        _registerPublisher(3);
        _registerPublisher(4);
        token.mint(buyer, 1_000_000_000);
    }

    function testExactApprovalAndTwoPublisherPayouts() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(2, 1);
        uint256 total = manifest.totalAmount;
        _approve(total);
        require(token.allowance(buyer, address(settlement)) == total, "approval not exact");

        uint256 payoutA = token.balanceOf(_payout(0));
        uint256 payoutB = token.balanceOf(_payout(1));
        uint256 buyerBalance = token.balanceOf(buyer);
        vm.prank(buyer);
        settlement.settle(manifest);

        require(token.balanceOf(_payout(0)) == payoutA + PRICE, "publisher A payout");
        require(token.balanceOf(_payout(1)) == payoutB + PRICE, "publisher B payout");
        require(token.balanceOf(buyer) == buyerBalance - total, "buyer charged exact total");
        require(token.allowance(buyer, address(settlement)) == 0, "exact allowance consumed");
        require(settlement.settledQueries(manifest.queryId), "query not marked settled");
    }

    function testRejectsIncorrectTotal() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(2, 1);
        manifest.totalAmount += 1;
        manifest.coordinatorSignature = _coordinatorSignature(manifest);
        vm.expectRevert(QueryMintSettlement.InvalidTotal.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsInsufficientBuyerBalance() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(2, 1);
        token.setBalance(buyer, manifest.totalAmount - 1);
        _approve(manifest.totalAmount);
        vm.expectRevert();
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsInsufficientAllowance() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(2, 1);
        _approve(manifest.totalAmount - 1);
        vm.expectRevert();
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsUnauthorizedCoordinator() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        manifest.coordinator = vm.addr(0xBAD);
        manifest.coordinatorSignature = _sign(0xBAD, settlement.hashManifest(manifest));
        vm.expectRevert(QueryMintSettlement.CoordinatorUnauthorized.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsRevokedCoordinator() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        vm.prank(_publisher(0));
        settlement.revokeCoordinator(manifest.allocations[0].datasetId, coordinator);
        vm.expectRevert(QueryMintSettlement.CoordinatorUnauthorized.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsExpiredGrantAndDeadline() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        vm.warp(manifest.deadline);
        vm.expectRevert(QueryMintSettlement.QueryExpired.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsStalePolicyNonce() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        vm.prank(_publisher(0));
        settlement.updateDatasetPolicy(manifest.allocations[0].datasetId, PRICE + 1, 50, 100_000_000, 0, uint64(block.timestamp + 3_600));
        vm.expectRevert(QueryMintSettlement.InvalidPolicy.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsStalePublisherNonceAfterPayoutChange() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        vm.prank(_publisher(0));
        settlement.updatePublisherPayout(address(0xCAFE));
        vm.expectRevert(QueryMintSettlement.InvalidPublisherNonce.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsStaleGrantNonce() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        vm.prank(_publisher(0));
        settlement.authorizeCoordinator(manifest.allocations[0].datasetId, coordinator, uint64(block.timestamp + 1_800));
        vm.expectRevert(QueryMintSettlement.CoordinatorUnauthorized.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsInvalidCoordinatorSignature() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        manifest.coordinatorSignature = _sign(0xBAD, settlement.hashManifest(manifest));
        vm.expectRevert(QueryMintSettlement.InvalidCoordinatorSignature.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsMissingHighValuePublisherSignature() public {
        bytes32 datasetId = bytes32(uint256(0x100));
        vm.prank(_publisher(0));
        settlement.updateDatasetPolicy(datasetId, PRICE, 50, 100_000_000, PRICE, uint64(block.timestamp + 3_600));
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        vm.expectRevert(QueryMintSettlement.InvalidPublisherSignature.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testAcceptsRequiredHighValuePublisherSignature() public {
        bytes32 datasetId = bytes32(uint256(0x100));
        vm.prank(_publisher(0));
        settlement.updateDatasetPolicy(datasetId, PRICE, 50, 100_000_000, PRICE, uint64(block.timestamp + 3_600));
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        QueryMintSettlement.Allocation memory allocation = manifest.allocations[0];
        allocation.publisherSignature = _sign(PUBLISHER_A_KEY, settlement.hashPublisherApproval(manifest.queryId, allocation, manifest.deadline));
        manifest.allocations[0].publisherSignature = allocation.publisherSignature;
        _approve(manifest.totalAmount);
        vm.prank(buyer);
        settlement.settle(manifest);
        require(settlement.settledQueries(manifest.queryId), "signed query not settled");
    }

    function testRejectsQuoteBeyondGrantExpiry() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        (uint64 grantExpiry,,) = settlement.coordinatorGrants(manifest.allocations[0].datasetId, coordinator);
        manifest.deadline = grantExpiry + 1;
        manifest.coordinatorSignature = _coordinatorSignature(manifest);
        vm.expectRevert(QueryMintSettlement.CoordinatorUnauthorized.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsQuoteBeyondDatasetExpiry() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        (, , , , uint64 datasetExpiry,,) = settlement.datasetPolicies(manifest.allocations[0].datasetId);
        manifest.deadline = datasetExpiry + 1;
        manifest.coordinatorSignature = _coordinatorSignature(manifest);
        vm.expectRevert(QueryMintSettlement.InvalidExpiry.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsDuplicateQueryId() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        _approve(uint256(manifest.totalAmount) * 2);
        vm.prank(buyer);
        settlement.settle(manifest);
        vm.expectRevert(QueryMintSettlement.QueryAlreadySettled.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsDuplicateRecordHashes() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 2);
        manifest.allocations[0].recordHashes[1] = manifest.allocations[0].recordHashes[0];
        manifest.coordinatorSignature = _coordinatorSignature(manifest);
        vm.expectRevert(QueryMintSettlement.DuplicateRecordHash.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testRejectsIncorrectPayout() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(1, 1);
        manifest.allocations[0].payoutAmount += 1;
        manifest.totalAmount += 1;
        manifest.resultRoot = settlement.computeResultRoot(manifest.allocations);
        manifest.coordinatorSignature = _coordinatorSignature(manifest);
        vm.expectRevert(QueryMintSettlement.InvalidPayout.selector);
        vm.prank(buyer);
        settlement.settle(manifest);
    }

    function testPayoutTransferFailureRollsBackCollection() public {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(2, 1);
        _approve(manifest.totalAmount);
        uint256 buyerBalance = token.balanceOf(buyer);
        token.setFailPayoutTransfer(true);
        vm.expectRevert();
        vm.prank(buyer);
        settlement.settle(manifest);
        require(token.balanceOf(buyer) == buyerBalance, "buyer balance changed on revert");
        require(!settlement.settledQueries(manifest.queryId), "query marked settled on revert");
    }

    function testGasOnePublisherOneRecord() public { _measureGas(1, 1); }
    function testGasTwoPublishersTwoRecordsEach() public { _measureGas(2, 2); }
    function testGasFivePublishersTenRecordsEach() public { _measureGas(5, 10); }

    function _measureGas(uint8 publisherCount, uint8 recordsEach) private {
        QueryMintSettlement.QueryManifest memory manifest = _buildManifest(publisherCount, recordsEach);
        _approve(manifest.totalAmount);
        vm.prank(buyer);
        uint256 beforeGas = gasleft();
        settlement.settle(manifest);
        emit GasMeasured(publisherCount, publisherCount * recordsEach, beforeGas - gasleft());
    }

    function _buildManifest(uint8 publisherCount, uint8 recordsEach)
        private
        returns (QueryMintSettlement.QueryManifest memory manifest)
    {
        QueryMintSettlement.Allocation[] memory allocations = new QueryMintSettlement.Allocation[](publisherCount);
        uint256 total;
        for (uint256 i; i < publisherCount; ++i) {
            bytes32[] memory hashes = new bytes32[](recordsEach);
            for (uint256 j; j < recordsEach; ++j) hashes[j] = bytes32(uint256(10_000 + i * 100 + j));
            (, uint64 publisherNonce,) = settlement.publishers(_publisher(i));
            (, , , , , uint64 policyNonce, ) = settlement.datasetPolicies(bytes32(uint256(0x100 + i)));
            (uint64 grantExpiry, uint64 grantNonce,) = settlement.coordinatorGrants(bytes32(uint256(0x100 + i)), coordinator);
            require(grantExpiry > block.timestamp, "grant not configured");
            uint128 payout = uint128(uint256(PRICE) * recordsEach);
            allocations[i] = QueryMintSettlement.Allocation({
                publisher: _publisher(i),
                datasetId: bytes32(uint256(0x100 + i)),
                publisherNonce: publisherNonce,
                policyNonce: policyNonce,
                grantNonce: grantNonce,
                recordCount: recordsEach,
                recordHashes: hashes,
                payoutAmount: payout,
                publisherSignature: bytes("")
            });
            total += payout;
        }
        manifest = QueryMintSettlement.QueryManifest({
            queryId: keccak256(abi.encode("query", publisherCount, recordsEach, block.timestamp, address(this))),
            buyer: buyer,
            coordinator: coordinator,
            token: address(token),
            totalAmount: uint128(total),
            deadline: uint64(block.timestamp + QUOTE_SECONDS),
            resultRoot: bytes32(0),
            allocations: allocations,
            coordinatorSignature: bytes("")
        });
        manifest.resultRoot = settlement.computeResultRoot(allocations);
        manifest.coordinatorSignature = _coordinatorSignature(manifest);
    }

    function _coordinatorSignature(QueryMintSettlement.QueryManifest memory manifest) private returns (bytes memory) {
        return _sign(COORDINATOR_KEY, settlement.hashManifest(manifest));
    }

    function _approve(uint256 amount) private {
        vm.prank(buyer);
        token.approve(address(settlement), amount);
    }

    function _sign(uint256 privateKey, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _registerPublisher(uint256 index) private {
        address publisher = _publisher(index);
        bytes32 datasetId = bytes32(uint256(0x100 + index));
        vm.prank(publisher);
        settlement.registerPublisher(_payout(index));
        vm.prank(publisher);
        settlement.registerDataset(datasetId, PRICE, 50, 100_000_000, 0, uint64(block.timestamp + 3_600));
        vm.prank(publisher);
        settlement.authorizeCoordinator(datasetId, coordinator, uint64(block.timestamp + 1_800));
    }

    function _publisher(uint256 index) private returns (address) {
        if (index == 0) return vm.addr(PUBLISHER_A_KEY);
        if (index == 1) return vm.addr(PUBLISHER_B_KEY);
        if (index == 2) return vm.addr(PUBLISHER_C_KEY);
        if (index == 3) return vm.addr(PUBLISHER_D_KEY);
        return vm.addr(PUBLISHER_E_KEY);
    }

    function _payout(uint256 index) private pure returns (address) {
        return address(uint160(0xD000 + index));
    }
}

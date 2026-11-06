// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title QueryMintSettlement
/// @notice Publisher-owned dataset policy, scoped coordinator grants, and USDT settlement.
/// @dev Arkiv keys and record hashes are supplied off-chain. This contract enforces the signed
///      allocation and payment constraints but cannot query Arkiv or prove query completeness.
contract QueryMintSettlement is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_PUBLISHERS_PER_QUERY = 10;
    uint256 public constant MAX_RECORDS_PER_QUERY = 50;

    bytes32 private constant ALLOCATION_TYPEHASH = keccak256(
        "Allocation(address publisher,bytes32 datasetId,uint64 publisherNonce,uint64 policyNonce,uint64 grantNonce,uint32 recordCount,bytes32 recordHashesHash,uint128 payoutAmount)"
    );
    bytes32 private constant QUERY_TYPEHASH = keccak256(
        "QueryManifest(bytes32 queryId,address buyer,address coordinator,address token,uint128 totalAmount,uint64 deadline,bytes32 resultRoot,bytes32 allocationsHash)"
    );
    bytes32 private constant PUBLISHER_APPROVAL_TYPEHASH = keccak256(
        "PublisherApproval(bytes32 queryId,address publisher,bytes32 datasetId,uint64 publisherNonce,uint64 policyNonce,uint64 grantNonce,uint32 recordCount,bytes32 recordHashesHash,uint128 payoutAmount,uint64 deadline)"
    );

    IERC20 public immutable usdt;

    struct Publisher {
        address payout;
        uint64 nonce;
        bool registered;
    }

    struct DatasetPolicy {
        uint128 pricePerRecord;
        uint128 maxPayoutPerQuery;
        uint128 publisherSignatureThreshold;
        uint32 maxRecordsPerQuery;
        uint64 expiresAt;
        uint64 nonce;
        bool active;
    }

    struct CoordinatorGrant {
        uint64 expiresAt;
        uint64 nonce;
        bool active;
    }

    struct Allocation {
        address publisher;
        bytes32 datasetId;
        uint64 publisherNonce;
        uint64 policyNonce;
        uint64 grantNonce;
        uint32 recordCount;
        bytes32[] recordHashes;
        uint128 payoutAmount;
        bytes publisherSignature;
    }

    struct QueryManifest {
        bytes32 queryId;
        address buyer;
        address coordinator;
        address token;
        uint128 totalAmount;
        uint64 deadline;
        bytes32 resultRoot;
        Allocation[] allocations;
        bytes coordinatorSignature;
    }

    mapping(address publisher => Publisher) public publishers;
    mapping(bytes32 datasetId => address publisher) public datasetPublisher;
    mapping(bytes32 datasetId => DatasetPolicy) public datasetPolicies;
    mapping(bytes32 datasetId => mapping(address coordinator => CoordinatorGrant)) public coordinatorGrants;
    mapping(bytes32 queryId => bool settled) public settledQueries;

    error ZeroAddress();
    error AlreadyRegistered();
    error NotRegistered();
    error NotDatasetPublisher();
    error DatasetAlreadyRegistered();
    error InvalidPolicy();
    error InvalidExpiry();
    error DatasetInactive();
    error CoordinatorUnauthorized();
    error QueryExpired();
    error InvalidManifest();
    error QueryAlreadySettled();
    error TooManyAllocations();
    error TooManyRecords();
    error DuplicateDataset();
    error DuplicateRecordHash();
    error InvalidRecordHashOrder();
    error InvalidPublisherNonce();
    error InvalidRecordCount();
    error InvalidPayout();
    error InvalidTotal();
    error InvalidResultRoot();
    error InvalidCoordinatorSignature();
    error InvalidPublisherSignature();

    event PublisherRegistered(address indexed publisher, address indexed payout);
    event PublisherPayoutUpdated(address indexed publisher, address indexed payout, uint64 nonce);
    event DatasetRegistered(bytes32 indexed datasetId, address indexed publisher, uint64 policyNonce);
    event DatasetPolicyUpdated(bytes32 indexed datasetId, uint64 policyNonce);
    event DatasetRevoked(bytes32 indexed datasetId, uint64 policyNonce);
    event CoordinatorAuthorized(
        bytes32 indexed datasetId,
        address indexed coordinator,
        uint64 expiresAt,
        uint64 grantNonce
    );
    event CoordinatorRevoked(bytes32 indexed datasetId, address indexed coordinator, uint64 grantNonce);
    event AllocationPaid(bytes32 indexed queryId, bytes32 indexed datasetId, address indexed publisher, address payout, uint256 amount, uint32 recordCount);
    event QuerySettled(
        bytes32 indexed queryId,
        address indexed buyer,
        address indexed coordinator,
        uint256 totalAmount,
        bytes32 resultRoot,
        bytes32 manifestDigest
    );

    constructor(address usdtAddress) EIP712("QueryMint", "1") {
        if (usdtAddress == address(0) || usdtAddress.code.length == 0) revert ZeroAddress();
        usdt = IERC20(usdtAddress);
    }

    function registerPublisher(address payout) external {
        if (payout == address(0)) revert ZeroAddress();
        if (publishers[msg.sender].registered) revert AlreadyRegistered();
        publishers[msg.sender] = Publisher({payout: payout, nonce: 1, registered: true});
        emit PublisherRegistered(msg.sender, payout);
    }

    function updatePublisherPayout(address payout) external {
        Publisher storage publisher = publishers[msg.sender];
        if (!publisher.registered) revert NotRegistered();
        if (payout == address(0)) revert ZeroAddress();
        publisher.payout = payout;
        publisher.nonce++;
        emit PublisherPayoutUpdated(msg.sender, payout, publisher.nonce);
    }

    function registerDataset(
        bytes32 datasetId,
        uint128 pricePerRecord,
        uint32 maxRecordsPerQuery,
        uint128 maxPayoutPerQuery,
        uint128 publisherSignatureThreshold,
        uint64 expiresAt
    ) external {
        if (!publishers[msg.sender].registered) revert NotRegistered();
        if (datasetId == bytes32(0)) revert InvalidPolicy();
        if (datasetPublisher[datasetId] != address(0)) revert DatasetAlreadyRegistered();
        _validatePolicy(pricePerRecord, maxRecordsPerQuery, maxPayoutPerQuery, expiresAt);
        datasetPublisher[datasetId] = msg.sender;
        datasetPolicies[datasetId] = DatasetPolicy({
            pricePerRecord: pricePerRecord,
            maxPayoutPerQuery: maxPayoutPerQuery,
            publisherSignatureThreshold: publisherSignatureThreshold,
            maxRecordsPerQuery: maxRecordsPerQuery,
            expiresAt: expiresAt,
            nonce: 1,
            active: true
        });
        emit DatasetRegistered(datasetId, msg.sender, 1);
    }

    function updateDatasetPolicy(
        bytes32 datasetId,
        uint128 pricePerRecord,
        uint32 maxRecordsPerQuery,
        uint128 maxPayoutPerQuery,
        uint128 publisherSignatureThreshold,
        uint64 expiresAt
    ) external {
        _requireDatasetPublisher(datasetId);
        if (!datasetPolicies[datasetId].active) revert DatasetInactive();
        _validatePolicy(pricePerRecord, maxRecordsPerQuery, maxPayoutPerQuery, expiresAt);
        DatasetPolicy storage policy = datasetPolicies[datasetId];
        policy.pricePerRecord = pricePerRecord;
        policy.maxRecordsPerQuery = maxRecordsPerQuery;
        policy.maxPayoutPerQuery = maxPayoutPerQuery;
        policy.publisherSignatureThreshold = publisherSignatureThreshold;
        policy.expiresAt = expiresAt;
        policy.nonce++;
        emit DatasetPolicyUpdated(datasetId, policy.nonce);
    }

    function revokeDataset(bytes32 datasetId) external {
        _requireDatasetPublisher(datasetId);
        DatasetPolicy storage policy = datasetPolicies[datasetId];
        policy.active = false;
        policy.nonce++;
        emit DatasetRevoked(datasetId, policy.nonce);
    }

    function authorizeCoordinator(bytes32 datasetId, address coordinator, uint64 expiresAt) external {
        _requireDatasetPublisher(datasetId);
        if (!datasetPolicies[datasetId].active) revert DatasetInactive();
        if (coordinator == address(0) || coordinator == msg.sender) revert ZeroAddress();
        if (expiresAt <= block.timestamp || expiresAt > datasetPolicies[datasetId].expiresAt) revert InvalidExpiry();
        CoordinatorGrant storage grant = coordinatorGrants[datasetId][coordinator];
        grant.expiresAt = expiresAt;
        grant.nonce++;
        grant.active = true;
        emit CoordinatorAuthorized(datasetId, coordinator, expiresAt, grant.nonce);
    }

    function revokeCoordinator(bytes32 datasetId, address coordinator) external {
        _requireDatasetPublisher(datasetId);
        if (coordinator == address(0)) revert ZeroAddress();
        CoordinatorGrant storage grant = coordinatorGrants[datasetId][coordinator];
        grant.active = false;
        grant.nonce++;
        emit CoordinatorRevoked(datasetId, coordinator, grant.nonce);
    }

    function hashManifest(QueryManifest calldata manifest) external view returns (bytes32) {
        return _hashTypedDataV4(_queryStructHash(manifest));
    }

    function hashPublisherApproval(
        bytes32 queryId,
        Allocation calldata allocation,
        uint64 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(_publisherApprovalStructHash(queryId, allocation, deadline));
    }

    function computeResultRoot(Allocation[] calldata allocations) public pure returns (bytes32) {
        uint256 recordTotal;
        for (uint256 i; i < allocations.length; ++i) recordTotal += allocations[i].recordHashes.length;
        bytes32[] memory leaves = new bytes32[](recordTotal);
        uint256 cursor;
        for (uint256 i; i < allocations.length; ++i) {
            Allocation calldata allocation = allocations[i];
            for (uint256 j; j < allocation.recordHashes.length; ++j) {
                leaves[cursor++] = keccak256(abi.encode(allocation.publisher, allocation.datasetId, allocation.recordHashes[j]));
            }
        }
        return keccak256(abi.encodePacked(leaves));
    }

    function settle(QueryManifest calldata manifest) external nonReentrant {
        if (manifest.queryId == bytes32(0) || manifest.buyer == address(0) || manifest.coordinator == address(0)) {
            revert InvalidManifest();
        }
        if (manifest.buyer != msg.sender || manifest.token != address(usdt) || manifest.totalAmount == 0) {
            revert InvalidManifest();
        }
        if (manifest.deadline <= block.timestamp) revert QueryExpired();
        if (settledQueries[manifest.queryId]) revert QueryAlreadySettled();
        uint256 allocationCount = manifest.allocations.length;
        if (allocationCount == 0 || allocationCount > MAX_PUBLISHERS_PER_QUERY) revert TooManyAllocations();

        bytes32[] memory allocationHashes = new bytes32[](allocationCount);
        uint256 totalRecords;
        uint256 totalPayout;
        bytes32 previousDatasetId;

        for (uint256 i; i < allocationCount; ++i) {
            Allocation calldata allocation = manifest.allocations[i];
            if (i > 0 && uint256(allocation.datasetId) <= uint256(previousDatasetId)) revert DuplicateDataset();
            previousDatasetId = allocation.datasetId;
            _validateAllocation(manifest, allocation, i);
            totalRecords += allocation.recordHashes.length;
            if (totalRecords > MAX_RECORDS_PER_QUERY) revert TooManyRecords();
            totalPayout += allocation.payoutAmount;
            allocationHashes[i] = _allocationStructHash(allocation);
        }

        if (totalPayout != manifest.totalAmount) revert InvalidTotal();
        if (computeResultRoot(manifest.allocations) != manifest.resultRoot) revert InvalidResultRoot();

        bytes32 digest = _hashTypedDataV4(_queryStructHashFromHashes(manifest, allocationHashes));
        if (manifest.coordinatorSignature.length != 65 || ECDSA.recover(digest, manifest.coordinatorSignature) != manifest.coordinator) {
            revert InvalidCoordinatorSignature();
        }

        // Effects before external token calls. Any failed transfer reverts the entire transaction.
        settledQueries[manifest.queryId] = true;
        usdt.safeTransferFrom(manifest.buyer, address(this), manifest.totalAmount);
        for (uint256 i; i < allocationCount; ++i) {
            Allocation calldata allocation = manifest.allocations[i];
            address payout = publishers[allocation.publisher].payout;
            usdt.safeTransfer(payout, allocation.payoutAmount);
            emit AllocationPaid(
                manifest.queryId,
                allocation.datasetId,
                allocation.publisher,
                payout,
                allocation.payoutAmount,
                allocation.recordCount
            );
        }
        emit QuerySettled(
            manifest.queryId,
            manifest.buyer,
            manifest.coordinator,
            manifest.totalAmount,
            manifest.resultRoot,
            digest
        );
    }

    function _validateAllocation(
        QueryManifest calldata manifest,
        Allocation calldata allocation,
        uint256 allocationIndex
    ) private view {
        address registeredPublisher = datasetPublisher[allocation.datasetId];
        if (registeredPublisher == address(0) || registeredPublisher != allocation.publisher) revert NotDatasetPublisher();
        Publisher storage publisher = publishers[allocation.publisher];
        if (!publisher.registered) revert NotRegistered();
        if (publisher.nonce != allocation.publisherNonce) revert InvalidPublisherNonce();

        DatasetPolicy storage policy = datasetPolicies[allocation.datasetId];
        if (!policy.active) revert DatasetInactive();
        if (policy.nonce != allocation.policyNonce) revert InvalidPolicy();
        if (block.timestamp >= policy.expiresAt || manifest.deadline > policy.expiresAt) revert InvalidExpiry();

        CoordinatorGrant storage grant = coordinatorGrants[allocation.datasetId][manifest.coordinator];
        if (!grant.active || grant.nonce != allocation.grantNonce || block.timestamp >= grant.expiresAt || manifest.deadline > grant.expiresAt) {
            revert CoordinatorUnauthorized();
        }

        uint256 recordCount = allocation.recordHashes.length;
        if (recordCount == 0 || recordCount != allocation.recordCount || recordCount > policy.maxRecordsPerQuery) {
            revert InvalidRecordCount();
        }
        for (uint256 i; i < recordCount; ++i) {
            bytes32 current = allocation.recordHashes[i];
            if (current == bytes32(0)) revert InvalidRecordHashOrder();
            if (i > 0) {
                uint256 currentHash = uint256(current);
                uint256 previousHash = uint256(allocation.recordHashes[i - 1]);
                if (currentHash == previousHash) revert DuplicateRecordHash();
                if (currentHash < previousHash) revert InvalidRecordHashOrder();
            }
            for (uint256 a; a < allocationIndex; ++a) {
                bytes32[] calldata previousHashes = manifest.allocations[a].recordHashes;
                for (uint256 j; j < previousHashes.length; ++j) {
                    if (current == previousHashes[j]) revert DuplicateRecordHash();
                }
            }
        }

        uint256 expectedPayout = uint256(policy.pricePerRecord) * recordCount;
        if (
            expectedPayout == 0 ||
            expectedPayout > policy.maxPayoutPerQuery ||
            expectedPayout > type(uint128).max ||
            allocation.payoutAmount != expectedPayout
        ) revert InvalidPayout();

        bool publisherApprovalRequired =
            policy.publisherSignatureThreshold != 0 && expectedPayout >= policy.publisherSignatureThreshold;
        if (publisherApprovalRequired || allocation.publisherSignature.length != 0) {
            if (allocation.publisherSignature.length != 65) revert InvalidPublisherSignature();
            bytes32 approvalDigest = _hashTypedDataV4(
                _publisherApprovalStructHash(manifest.queryId, allocation, manifest.deadline)
            );
            if (ECDSA.recover(approvalDigest, allocation.publisherSignature) != allocation.publisher) {
                revert InvalidPublisherSignature();
            }
        }
    }

    function _requireDatasetPublisher(bytes32 datasetId) private view {
        if (datasetPublisher[datasetId] != msg.sender) revert NotDatasetPublisher();
    }

    function _validatePolicy(
        uint128 pricePerRecord,
        uint32 maxRecordsPerQuery,
        uint128 maxPayoutPerQuery,
        uint64 expiresAt
    ) private view {
        if (
            pricePerRecord == 0 ||
            maxRecordsPerQuery == 0 ||
            maxRecordsPerQuery > MAX_RECORDS_PER_QUERY ||
            maxPayoutPerQuery < pricePerRecord
        ) revert InvalidPolicy();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();
    }

    function _queryStructHash(QueryManifest calldata manifest) private pure returns (bytes32) {
        bytes32[] memory allocationHashes = new bytes32[](manifest.allocations.length);
        for (uint256 i; i < manifest.allocations.length; ++i) {
            allocationHashes[i] = _allocationStructHash(manifest.allocations[i]);
        }
        return _queryStructHashFromHashes(manifest, allocationHashes);
    }

    function _queryStructHashFromHashes(
        QueryManifest calldata manifest,
        bytes32[] memory allocationHashes
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                QUERY_TYPEHASH,
                manifest.queryId,
                manifest.buyer,
                manifest.coordinator,
                manifest.token,
                manifest.totalAmount,
                manifest.deadline,
                manifest.resultRoot,
                keccak256(abi.encodePacked(allocationHashes))
            )
        );
    }

    function _allocationStructHash(Allocation calldata allocation) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ALLOCATION_TYPEHASH,
                allocation.publisher,
                allocation.datasetId,
                allocation.publisherNonce,
                allocation.policyNonce,
                allocation.grantNonce,
                allocation.recordCount,
                keccak256(abi.encode(allocation.recordHashes)),
                allocation.payoutAmount
            )
        );
    }

    function _publisherApprovalStructHash(
        bytes32 queryId,
        Allocation calldata allocation,
        uint64 deadline
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PUBLISHER_APPROVAL_TYPEHASH,
                queryId,
                allocation.publisher,
                allocation.datasetId,
                allocation.publisherNonce,
                allocation.policyNonce,
                allocation.grantNonce,
                allocation.recordCount,
                keccak256(abi.encode(allocation.recordHashes)),
                allocation.payoutAmount,
                deadline
            )
        );
    }
}

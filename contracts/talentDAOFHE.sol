pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract TalentAgencyFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool isOpen;
    }
    Batch public currentBatch;

    uint256 public constant MAX_CREATORS_PER_BATCH = 100;
    uint256 public numCreatorsInCurrentBatch;

    struct CreatorData {
        euint32 encryptedCreatorId;
        euint32 encryptedWorkId;
        euint32 encryptedRoyaltyRate; // e.g., 1000 for 10.00%
        euint32 encryptedMinFee;      // e.g., 100 for 1.00 FHE-ETH
    }
    mapping(uint256 => mapping(uint256 => CreatorData)) public batchCreatorData; // batchId -> creatorIndex -> CreatorData
    mapping(uint256 => uint256) public batchCreatorCount; // batchId -> count

    struct Deal {
        uint256 batchId;
        euint32 encryptedTotalRoyaltyRate; // Sum of selected creators' rates
        euint32 encryptedTotalMinFee;      // Sum of selected creators' min fees
        euint32 encryptedNumSelected;      // Number of creators selected for this deal
        bool isActive;
    }
    mapping(uint256 => Deal) public deals; // dealId -> Deal
    uint256 public nextDealId;

    struct DecryptionContext {
        uint256 batchId;
        uint256 dealId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchFull();
    error InvalidDeal();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error AlreadyInitialized();

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool paused);
    event CooldownSecondsSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event CreatorRegistered(uint256 indexed batchId, uint256 indexed creatorIndex, address indexed provider);
    event DealCreated(uint256 indexed dealId, uint256 indexed batchId);
    event DealFinalized(uint256 indexed dealId, uint256 indexed batchId, uint256 totalRoyaltyRate, uint256 totalMinFee, uint256 numSelected);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, uint256 indexed dealId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed dealId, uint256 totalRoyaltyRate, uint256 totalMinFee, uint256 numSelected);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[msg.sender] = true;
        emit ProviderAdded(msg.sender);
        cooldownSeconds = 60; // Default 1 minute cooldown
        _openNewBatch(1); // Start with batch 1
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, _cooldownSeconds);
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        uint256 newBatchId = currentBatch.id + 1;
        _openNewBatch(newBatchId);
    }

    function _openNewBatch(uint256 newBatchId) private {
        currentBatch = Batch({ id: newBatchId, isOpen: true });
        numCreatorsInCurrentBatch = 0;
        emit BatchOpened(newBatchId);
    }

    function closeCurrentBatch() external onlyOwner whenNotPaused {
        if (!currentBatch.isOpen) revert BatchClosed();
        currentBatch.isOpen = false;
        emit BatchClosed(currentBatch.id);
    }

    function registerCreator(
        euint32 encryptedCreatorId,
        euint32 encryptedWorkId,
        euint32 encryptedRoyaltyRate,
        euint32 encryptedMinFee
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!currentBatch.isOpen) revert BatchClosed();
        if (numCreatorsInCurrentBatch >= MAX_CREATORS_PER_BATCH) revert BatchFull();

        lastSubmissionTime[msg.sender] = block.timestamp;

        uint256 creatorIndex = numCreatorsInCurrentBatch;
        batchCreatorData[currentBatch.id][creatorIndex] = CreatorData({
            encryptedCreatorId: encryptedCreatorId,
            encryptedWorkId: encryptedWorkId,
            encryptedRoyaltyRate: encryptedRoyaltyRate,
            encryptedMinFee: encryptedMinFee
        });
        numCreatorsInCurrentBatch++;

        emit CreatorRegistered(currentBatch.id, creatorIndex, msg.sender);
    }

    function createDealForBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (batchId == 0 || batchId >= currentBatch.id) revert InvalidDeal(); // Cannot create deal for current or future batch
        if (batchCreatorCount[batchId] == 0) revert InvalidDeal();

        uint256 dealId = nextDealId++;
        deals[dealId] = Deal({
            batchId: batchId,
            encryptedTotalRoyaltyRate: FHE.asEuint32(0),
            encryptedTotalMinFee: FHE.asEuint32(0),
            encryptedNumSelected: FHE.asEuint32(0),
            isActive: true
        });
        emit DealCreated(dealId, batchId);
    }

    function finalizeDeal(uint256 dealId) external onlyOwner whenNotPaused checkDecryptionCooldown {
        if (dealId >= nextDealId) revert InvalidDeal();
        Deal storage deal = deals[dealId];
        if (!deal.isActive) revert InvalidDeal();

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        // Prepare ciphertexts for decryption
        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(deal.encryptedTotalRoyaltyRate);
        cts[1] = FHE.toBytes32(deal.encryptedTotalMinFee);
        cts[2] = FHE.toBytes32(deal.encryptedNumSelected);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: deal.batchId,
            dealId: dealId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, deal.batchId, dealId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        if (ctx.processed) revert ReplayAttempt();
        if (cleartexts.length != 3 * 32) revert InvalidProof(); // Expecting 3 uint256 values

        // Rebuild ciphertexts from current contract storage
        Deal storage deal = deals[ctx.dealId];
        bytes32[] memory currentCts = new bytes32[](3);
        currentCts[0] = FHE.toBytes32(deal.encryptedTotalRoyaltyRate);
        currentCts[1] = FHE.toBytes32(deal.encryptedTotalMinFee);
        currentCts[2] = FHE.toBytes32(deal.encryptedNumSelected);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != ctx.stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode cleartexts
        uint256 totalRoyaltyRate = abi.decode(cleartexts[:32], (uint256));
        uint256 totalMinFee = abi.decode(cleartexts[32:64], (uint256));
        uint256 numSelected = abi.decode(cleartexts[64:96], (uint256));

        ctx.processed = true;
        deal.isActive = false; // Mark deal as finalized

        emit DecryptionCompleted(requestId, ctx.dealId, totalRoyaltyRate, totalMinFee, numSelected);
        emit DealFinalized(ctx.dealId, ctx.batchId, totalRoyaltyRate, totalMinFee, numSelected);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 encryptedValue) internal {
        if (!FHE.isInitialized(encryptedValue)) revert AlreadyInitialized();
    }
}
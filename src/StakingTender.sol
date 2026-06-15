// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StakingTender
/// @notice A staged on-chain tender system with commit-reveal bidding and escrowed funds.
contract StakingTender {
    enum TaskStatus {
        None,
        Bidding,
        Reveal,
        Selection,
        InProgress,
        Delivered,
        Completed,
        Cancelled,
        Expired
    }

    struct Task {
        uint256 id;
        address publisher;
        TaskStatus status;
        bytes32 detailsHash;
        bytes32 resultHash;
        uint96 reward;
        uint96 publisherStake;
        uint64 createdAt;
        uint64 biddingDeadline;
        uint64 revealDeadline;
        uint64 selectionDeadline;
        uint64 deliveryDeadline;
        uint64 reviewDeadline;
        address selectedBidder;
        uint32 bidCount;
        uint32 revealCount;
        bool settled;
    }

    struct Bid {
        address bidder;
        bytes32 commitment;
        bytes32 qualificationHash;
        uint96 bidderStake;
        uint96 revealedPrice;
        bool committed;
        bool revealed;
        bool selected;
        bool processed;
    }

    uint256 public nextTaskId = 1;
    uint256 public constant MAX_BIDDERS = 128;

    mapping(uint256 => Task) public tasks;
    mapping(uint256 => mapping(address => Bid)) public bids;
    mapping(uint256 => address[]) public bidderList;
    mapping(address => uint256) public pendingWithdrawals;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _reentrancyStatus = _NOT_ENTERED;

    event TaskCreated(uint256 indexed taskId, address indexed publisher, uint256 reward, uint256 publisherStake);
    event BidCommitted(uint256 indexed taskId, address indexed bidder, uint256 bidderStake);
    event BidRevealed(uint256 indexed taskId, address indexed bidder, uint256 bidAmount);
    event WinnerSelected(uint256 indexed taskId, address indexed bidder, uint256 bidAmount);
    event WorkSubmitted(uint256 indexed taskId, address indexed bidder, bytes32 resultHash);
    event WorkApproved(uint256 indexed taskId, address indexed bidder, uint256 winnerPayout, uint256 publisherRefund);
    event TimeoutClaimed(uint256 indexed taskId, TaskStatus previousStatus, address indexed caller);
    event TaskReclaimed(uint256 indexed taskId, address indexed caller);
    event TaskStatusSynced(uint256 indexed taskId, TaskStatus newStatus);
    event WithdrawalQueued(address indexed account, uint256 amount);
    event WithdrawalClaimed(address indexed account, uint256 amount);

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "reentrant call");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    /// @notice Creates a new tender task and escrows the reward plus publisher stake.
    /// @param detailsHash Hash of the off-chain task description.
    /// @param reward Reward paid to the selected bidder on successful completion.
    /// @param publisherStake Stake locked by the publisher to discourage bad behavior.
    /// @param biddingDeadline End of the commit phase.
    /// @param revealDeadline End of the reveal phase.
    /// @param selectionDeadline End of the winner selection phase.
    /// @param deliveryDeadline End of the delivery phase for the selected bidder.
    /// @param reviewDeadline End of the publisher review phase.
    function createTask(
        bytes32 detailsHash,
        uint96 reward,
        uint96 publisherStake,
        uint64 biddingDeadline,
        uint64 revealDeadline,
        uint64 selectionDeadline,
        uint64 deliveryDeadline,
        uint64 reviewDeadline
    ) external payable nonReentrant returns (uint256 taskId) {
        require(detailsHash != bytes32(0), "details hash required");
        require(reward > 0, "reward must be > 0");
        require(publisherStake > 0, "publisher stake must be > 0");
        require(msg.value == uint256(reward) + uint256(publisherStake), "incorrect escrow amount");
        require(biddingDeadline > block.timestamp, "bidding deadline must be in future");
        require(revealDeadline > biddingDeadline, "reveal deadline invalid");
        require(selectionDeadline > revealDeadline, "selection deadline invalid");
        require(deliveryDeadline > selectionDeadline, "delivery deadline invalid");
        require(reviewDeadline > deliveryDeadline, "review deadline invalid");

        taskId = nextTaskId++;
        Task storage task = tasks[taskId];
        task.id = taskId;
        task.publisher = msg.sender;
        task.status = TaskStatus.Bidding;
        task.detailsHash = detailsHash;
        task.reward = reward;
        task.publisherStake = publisherStake;
        task.createdAt = uint64(block.timestamp);
        task.biddingDeadline = biddingDeadline;
        task.revealDeadline = revealDeadline;
        task.selectionDeadline = selectionDeadline;
        task.deliveryDeadline = deliveryDeadline;
        task.reviewDeadline = reviewDeadline;

        emit TaskCreated(taskId, msg.sender, reward, publisherStake);
    }

    /// @notice Computes the effective task status directly from timestamps and task fields.
    /// @dev This view does not queue payouts or transfer funds. It only derives the current status.
    function getTaskEffectiveStatus(uint256 taskId) public view returns (TaskStatus) {
        Task storage task = tasks[taskId];
        if (task.publisher == address(0)) {
            return TaskStatus.None;
        }

        if (task.settled) {
            return task.status;
        }

        if (task.selectedBidder == address(0)) {
            if (block.timestamp < task.biddingDeadline) {
                return TaskStatus.Bidding;
            }
            if (block.timestamp < task.revealDeadline) {
                return TaskStatus.Reveal;
            }
            if (block.timestamp <= task.selectionDeadline) {
                return TaskStatus.Selection;
            }
            return TaskStatus.Expired;
        }

        if (task.resultHash == bytes32(0)) {
            if (block.timestamp <= task.deliveryDeadline) {
                return TaskStatus.InProgress;
            }
            return TaskStatus.Expired;
        }

        if (block.timestamp <= task.reviewDeadline) {
            return TaskStatus.Delivered;
        }

        return TaskStatus.Completed;
    }

    /// @notice Returns true only when a terminal settlement has already been queued on-chain.
    function isTaskSettled(uint256 taskId) external view returns (bool) {
        Task storage task = tasks[taskId];
        if (!task.settled) {
            return false;
        }

        return
            task.status == TaskStatus.Completed || task.status == TaskStatus.Expired || task.status == TaskStatus.Cancelled;
    }

    /// @notice Commits a sealed bid using keccak256(abi.encode(bidAmount, salt)).
    /// @param taskId Id of the target task.
    /// @param commitment Commitment hash built from bidAmount and salt.
    /// @param qualificationHash Hash of off-chain bidder qualification data.
    function commitBid(uint256 taskId, bytes32 commitment, bytes32 qualificationHash) external payable nonReentrant {
        Task storage task = tasks[taskId];

        require(task.publisher != address(0), "task not found");
        require(getTaskEffectiveStatus(taskId) == TaskStatus.Bidding, "task not in bidding");
        require(msg.sender != task.publisher, "publisher cannot bid");
        require(commitment != bytes32(0), "commitment required");
        require(qualificationHash != bytes32(0), "qualification hash required");
        require(msg.value > 0, "bidder stake must be > 0");
        require(task.bidCount < MAX_BIDDERS, "too many bidders");

        Bid storage bid = bids[taskId][msg.sender];
        require(!bid.committed, "bid already committed");

        bid.bidder = msg.sender;
        bid.commitment = commitment;
        bid.qualificationHash = qualificationHash;
        bid.bidderStake = uint96(msg.value);
        bid.committed = true;

        bidderList[taskId].push(msg.sender);
        task.bidCount += 1;

        emit BidCommitted(taskId, msg.sender, msg.value);
    }

    /// @notice Reveals the previously committed bid amount and salt.
    /// @param taskId Id of the target task.
    /// @param bidAmount Revealed bid amount.
    /// @param salt Salt used when creating the commitment.
    function revealBid(uint256 taskId, uint96 bidAmount, bytes32 salt) external nonReentrant {
        Task storage task = tasks[taskId];

        require(task.publisher != address(0), "task not found");
        require(getTaskEffectiveStatus(taskId) == TaskStatus.Reveal, "task not in reveal");

        Bid storage bid = bids[taskId][msg.sender];
        require(bid.committed, "bid not committed");
        require(!bid.revealed, "bid already revealed");
        require(keccak256(abi.encode(bidAmount, salt)) == bid.commitment, "invalid commitment reveal");

        bid.revealed = true;
        bid.revealedPrice = bidAmount;
        task.revealCount += 1;

        emit BidRevealed(taskId, msg.sender, bidAmount);
    }

    /// @notice Selects a revealed bidder as the winner and moves the task into execution.
    /// @param taskId Id of the target task.
    /// @param bidder Address of the winning bidder.
    function selectWinner(uint256 taskId, address bidder) external nonReentrant {
        Task storage task = tasks[taskId];

        require(task.publisher != address(0), "task not found");
        require(msg.sender == task.publisher, "only publisher");
        require(getTaskEffectiveStatus(taskId) == TaskStatus.Selection, "task not in selection");
        require(task.selectedBidder == address(0), "winner already selected");

        Bid storage bid = bids[taskId][bidder];
        require(bid.committed, "bid not found");
        require(bid.revealed, "bid not revealed");
        require(_isLowestRevealedBid(taskId, bidder), "winner must be lowest revealed bid");

        bid.selected = true;
        task.selectedBidder = bidder;
        task.status = TaskStatus.InProgress;

        emit WinnerSelected(taskId, bidder, bid.revealedPrice);
    }

    /// @notice Lets the selected bidder submit the off-chain result hash.
    /// @param taskId Id of the target task.
    /// @param resultHash Hash of the delivered work.
    function submitWork(uint256 taskId, bytes32 resultHash) external nonReentrant {
        Task storage task = tasks[taskId];

        require(task.publisher != address(0), "task not found");
        require(getTaskEffectiveStatus(taskId) == TaskStatus.InProgress, "task not in progress");
        require(block.timestamp <= task.deliveryDeadline, "delivery window closed");
        require(msg.sender == task.selectedBidder, "only selected bidder");
        require(resultHash != bytes32(0), "result hash required");

        task.resultHash = resultHash;
        task.status = TaskStatus.Delivered;

        emit WorkSubmitted(taskId, msg.sender, resultHash);
    }

    /// @notice Approves delivered work, pays the selected bidder, refunds revealed losing bidders, and returns publisher stake.
    /// @param taskId Id of the target task.
    function approveWork(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];

        require(task.publisher != address(0), "task not found");
        require(msg.sender == task.publisher, "only publisher");
        require(getTaskEffectiveStatus(taskId) == TaskStatus.Delivered, "task not delivered");
        require(!task.settled, "task already settled");

        task.status = TaskStatus.Completed;
        task.settled = true;

        Bid storage winningBid = bids[taskId][task.selectedBidder];
        uint256 winnerPayout = uint256(task.reward) + uint256(winningBid.bidderStake);
        uint256 publisherRefund = uint256(task.publisherStake);

        winningBid.processed = true;
        uint256 unrevealedPenalty = _queueNonWinnerBidSettlements(taskId);
        _queueWithdrawal(task.selectedBidder, winnerPayout);
        _queueWithdrawal(task.publisher, publisherRefund + unrevealedPenalty);

        emit WorkApproved(taskId, task.selectedBidder, winnerPayout, publisherRefund);
    }

    /// @notice Resolves timeout cases so funds cannot remain locked in the contract.
    /// @dev If the winner misses delivery, escrow returns to the publisher.
    ///      If the publisher misses review, escrow is released to the selected bidder.
    /// @param taskId Id of the target task.
    function claimTimeout(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        TaskStatus effectiveStatus = getTaskEffectiveStatus(taskId);

        require(task.publisher != address(0), "task not found");
        require(!task.settled, "task already settled");

        if (effectiveStatus == TaskStatus.Expired && task.selectedBidder == address(0)) {
            task.status = TaskStatus.Expired;
            task.settled = true;

            uint256 unrevealedPenalty = _queueNonWinnerBidSettlements(taskId);
            uint256 publisherPayout = uint256(task.reward) + unrevealedPenalty;

            if (task.revealCount == 0) {
                publisherPayout += uint256(task.publisherStake);
            } else {
                _distributePublisherStakeToRevealedBidders(taskId, task.publisherStake);
            }

            _queueWithdrawal(task.publisher, publisherPayout);

            emit TimeoutClaimed(taskId, TaskStatus.Selection, msg.sender);
            return;
        }

        if (effectiveStatus == TaskStatus.Expired && task.selectedBidder != address(0)) {
            require(task.resultHash == bytes32(0), "work already submitted");

            task.status = TaskStatus.Expired;
            task.settled = true;

            Bid storage winningBid = bids[taskId][task.selectedBidder];
            uint256 publisherPayout =
                uint256(task.reward) + uint256(task.publisherStake) + uint256(winningBid.bidderStake);

            winningBid.processed = true;
            uint256 unrevealedPenalty = _queueNonWinnerBidSettlements(taskId);
            _queueWithdrawal(task.publisher, publisherPayout + unrevealedPenalty);

            emit TimeoutClaimed(taskId, TaskStatus.InProgress, msg.sender);
            return;
        }

        if (effectiveStatus == TaskStatus.Completed) {
            require(task.selectedBidder != address(0), "winner not selected");
            require(task.resultHash != bytes32(0), "work not submitted");

            task.status = TaskStatus.Completed;
            task.settled = true;

            Bid storage winningBid = bids[taskId][task.selectedBidder];
            uint256 winnerPayout =
                uint256(task.reward) + uint256(task.publisherStake) + uint256(winningBid.bidderStake);

            winningBid.processed = true;
            uint256 unrevealedPenalty = _queueNonWinnerBidSettlements(taskId);
            _queueWithdrawal(task.selectedBidder, winnerPayout + unrevealedPenalty);

            emit TimeoutClaimed(taskId, TaskStatus.Delivered, msg.sender);
            return;
        }

        revert("no timeout claim available");
    }

    /// @notice Reclaims a task that reached the selection deadline without a chosen winner.
    /// @dev Revealed bidders are refunded, unrevealed bidders are penalized to the publisher.
    /// @param taskId Id of the target task.
    function reclaimTask(uint256 taskId) external pure {
        taskId;
        revert("reclaimTask deprecated; use claimTimeout with effective status");
    }

    /// @notice Lets any participant withdraw funds already assigned to them by the settlement logic.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "nothing to withdraw");

        pendingWithdrawals[msg.sender] = 0;
        (bool success,) = payable(msg.sender).call{value: amount}("");
        require(success, "withdraw transfer failed");

        emit WithdrawalClaimed(msg.sender, amount);
    }

    /// @notice Returns a specific bid in a frontend-friendly shape.
    function getBid(uint256 taskId, address bidder)
        external
        view
        returns (
            bytes32 commitment,
            bytes32 qualificationHash,
            uint96 bidderStake,
            uint96 revealedPrice,
            bool committed,
            bool revealed,
            bool selected,
            bool processed
        )
    {
        Bid storage bid = bids[taskId][bidder];
        return (
            bid.commitment,
            bid.qualificationHash,
            bid.bidderStake,
            bid.revealedPrice,
            bid.committed,
            bid.revealed,
            bid.selected,
            bid.processed
        );
    }

    /// @notice Returns the bidder addresses for a task.
    function getBidders(uint256 taskId) external view returns (address[] memory) {
        return bidderList[taskId];
    }

    /// @notice Helper for frontend code to build a valid commitment hash.
    function buildCommitment(uint96 bidAmount, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encode(bidAmount, salt));
    }

    function _syncTaskStatus(uint256 taskId) internal pure {
        taskId;
    }

    function _queueNonWinnerBidSettlements(uint256 taskId) internal returns (uint256 penaltyAmount) {
        address[] storage bidders = bidderList[taskId];

        for (uint256 i = 0; i < bidders.length; i++) {
            Bid storage bid = bids[taskId][bidders[i]];
            if (bid.processed) {
                continue;
            }

            bid.processed = true;

            if (bid.selected) {
                continue;
            }

            if (bid.revealed) {
                _queueWithdrawal(bid.bidder, bid.bidderStake);
            } else {
                penaltyAmount += bid.bidderStake;
            }
        }
    }

    function _isParticipant(uint256 taskId, address account) internal view returns (bool) {
        if (tasks[taskId].publisher == account) {
            return true;
        }
        return bids[taskId][account].committed;
    }

    function _isLowestRevealedBid(uint256 taskId, address bidder) internal view returns (bool) {
        Bid storage candidate = bids[taskId][bidder];
        address[] storage bidders = bidderList[taskId];

        for (uint256 i = 0; i < bidders.length; i++) {
            Bid storage other = bids[taskId][bidders[i]];
            if (other.revealed && other.revealedPrice < candidate.revealedPrice) {
                return false;
            }
        }

        return true;
    }

    function _distributePublisherStakeToRevealedBidders(uint256 taskId, uint96 publisherStake) internal {
        uint32 revealCount = tasks[taskId].revealCount;
        require(revealCount > 0, "no revealed bidders");

        uint256 baseShare = uint256(publisherStake) / uint256(revealCount);
        uint256 remainder = uint256(publisherStake) % uint256(revealCount);
        address[] storage bidders = bidderList[taskId];

        for (uint256 i = 0; i < bidders.length; i++) {
            Bid storage bid = bids[taskId][bidders[i]];
            if (!bid.revealed || bid.selected) {
                continue;
            }

            uint256 share = baseShare;
            if (remainder > 0) {
                share += 1;
                remainder -= 1;
            }

            _queueWithdrawal(bid.bidder, share);
        }
    }

    function _queueWithdrawal(address to, uint256 amount) internal {
        if (amount == 0) {
            return;
        }
        pendingWithdrawals[to] += amount;
        emit WithdrawalQueued(to, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StakingTender} from "../src/StakingTender.sol";

contract StakingTenderTest is Test {
    StakingTender internal tender;

    address internal publisher = makeAddr("publisher");
    address internal bidderA = makeAddr("bidderA");
    address internal bidderB = makeAddr("bidderB");

    uint96 internal constant REWARD = 10 ether;
    uint96 internal constant PUBLISHER_STAKE = 2 ether;
    uint96 internal constant BIDDER_STAKE = 1 ether;

    function setUp() public {
        tender = new StakingTender();
        vm.deal(publisher, 100 ether);
        vm.deal(bidderA, 100 ether);
        vm.deal(bidderB, 100 ether);
    }

    function test_CreateTaskStoresCoreFields() public {
        uint256 taskId = _createTask();

        (address taskPublisher, uint96 reward, uint96 publisherStake,,,,,,,,,,) = tender.tasks(taskId);
        (,,, uint64 biddingDeadline, uint64 revealDeadline, uint64 executionDeadline, uint64 reviewDeadline,,,,,,) =
            tender.tasks(taskId);
        (,,,,,,, StakingTender.TaskStatus status, address winner, bytes32 detailsHash, bytes32 submissionHash,,) =
            tender.tasks(taskId);
        (,,,,,,,,,,, uint32 totalBids, uint32 revealedBids) = tender.tasks(taskId);

        assertEq(taskPublisher, publisher);
        assertEq(reward, REWARD);
        assertEq(publisherStake, PUBLISHER_STAKE);
        assertEq(uint256(biddingDeadline), block.timestamp + 1 days);
        assertEq(uint256(revealDeadline), block.timestamp + 2 days);
        assertEq(uint256(executionDeadline), block.timestamp + 5 days);
        assertEq(uint256(reviewDeadline), block.timestamp + 6 days);
        assertEq(uint256(status), uint256(StakingTender.TaskStatus.Open));
        assertEq(winner, address(0));
        assertEq(detailsHash, keccak256("task-details"));
        assertEq(submissionHash, bytes32(0));
        assertEq(totalBids, 0);
        assertEq(revealedBids, 0);
    }

    function test_FullHappyPathAndLosingBidderRefund() public {
        uint256 taskId = _createTask();
        (, uint64 revealDeadline,,) = _taskDeadlines(taskId);
        (uint96 quoteA, bytes32 saltA, bytes32 commitmentA) = _quote(6 ether, "A");
        (uint96 quoteB, bytes32 saltB, bytes32 commitmentB) = _quote(5 ether, "B");

        vm.prank(bidderA);
        tender.commitBid{value: BIDDER_STAKE}(taskId, commitmentA, keccak256("proof-A"));

        vm.prank(bidderB);
        tender.commitBid{value: BIDDER_STAKE}(taskId, commitmentB, keccak256("proof-B"));

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(bidderA);
        tender.revealBid(taskId, quoteA, saltA);

        vm.prank(bidderB);
        tender.revealBid(taskId, quoteB, saltB);

        vm.warp(uint256(revealDeadline) + 1);

        vm.prank(publisher);
        tender.selectWinner(taskId, bidderB);

        vm.prank(bidderB);
        tender.submitWork(taskId, keccak256("submission-1"));

        uint256 bidderBalanceBefore = bidderB.balance;
        uint256 publisherBalanceBefore = publisher.balance;
        uint256 losingBidderBalanceBefore = bidderA.balance;

        vm.prank(publisher);
        tender.approveWork(taskId);

        vm.prank(bidderA);
        tender.claimBidRefund(taskId);

        assertEq(bidderB.balance, bidderBalanceBefore + REWARD + BIDDER_STAKE);
        assertEq(publisher.balance, publisherBalanceBefore + PUBLISHER_STAKE);
        assertEq(bidderA.balance, losingBidderBalanceBefore + BIDDER_STAKE);

        (,,,,,,, StakingTender.TaskStatus status, address winner,, bytes32 submissionHash,,) = tender.tasks(taskId);
        assertEq(uint256(status), uint256(StakingTender.TaskStatus.Completed));
        assertEq(winner, bidderB);
        assertEq(submissionHash, keccak256("submission-1"));
    }

    function test_WinnerCanClaimWhenPublisherDoesNotReview() public {
        uint256 taskId = _createAndAwardBidderA();
        (,,, uint64 reviewDeadline) = _taskDeadlines(taskId);

        vm.prank(bidderA);
        tender.submitWork(taskId, keccak256("submission-timeout"));

        uint256 bidderBalanceBefore = bidderA.balance;

        vm.warp(uint256(reviewDeadline) + 1);

        vm.prank(bidderA);
        tender.claimReviewTimeout(taskId);

        assertEq(bidderA.balance, bidderBalanceBefore + REWARD + BIDDER_STAKE + PUBLISHER_STAKE);
        (,,,,,,, StakingTender.TaskStatus status,,,,,) = tender.tasks(taskId);
        assertEq(uint256(status), uint256(StakingTender.TaskStatus.Completed));
    }

    function test_PublisherClaimsWhenWinnerDoesNotSubmit() public {
        uint256 taskId = _createAndAwardBidderA();
        (,, uint64 executionDeadline,) = _taskDeadlines(taskId);
        uint256 publisherBalanceBefore = publisher.balance;

        vm.warp(uint256(executionDeadline) + 1);

        vm.prank(publisher);
        tender.claimExecutionDefault(taskId);

        assertEq(publisher.balance, publisherBalanceBefore + REWARD + PUBLISHER_STAKE + BIDDER_STAKE);
        (,,,,,,, StakingTender.TaskStatus status,,,,,) = tender.tasks(taskId);
        assertEq(uint256(status), uint256(StakingTender.TaskStatus.Expired));
    }

    function test_RevealedBidderCanRefundAfterIdleTaskReclaim() public {
        uint256 taskId = _createTask();
        (, uint64 revealDeadline,,) = _taskDeadlines(taskId);
        (uint96 quoteA, bytes32 saltA, bytes32 commitmentA) = _quote(7 ether, "A");

        vm.prank(bidderA);
        tender.commitBid{value: BIDDER_STAKE}(taskId, commitmentA, keccak256("proof-A"));

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(bidderA);
        tender.revealBid(taskId, quoteA, saltA);

        vm.warp(uint256(revealDeadline) + 1);

        uint256 publisherBalanceBefore = publisher.balance;
        uint256 bidderBalanceBefore = bidderA.balance;

        vm.prank(publisher);
        tender.reclaimIdleTask(taskId);

        vm.prank(bidderA);
        tender.claimBidRefund(taskId);

        assertEq(publisher.balance, publisherBalanceBefore + REWARD + PUBLISHER_STAKE);
        assertEq(bidderA.balance, bidderBalanceBefore + BIDDER_STAKE);
        (,,,,,,, StakingTender.TaskStatus status,,,,,) = tender.tasks(taskId);
        assertEq(uint256(status), uint256(StakingTender.TaskStatus.Expired));
    }

    function _createTask() internal returns (uint256 taskId) {
        vm.prank(publisher);
        taskId = tender.createTask{value: REWARD + PUBLISHER_STAKE}(
            keccak256("task-details"),
            REWARD,
            PUBLISHER_STAKE,
            uint64(block.timestamp + 1 days),
            uint64(block.timestamp + 2 days),
            uint64(block.timestamp + 5 days),
            uint64(block.timestamp + 6 days)
        );
    }

    function _createAndAwardBidderA() internal returns (uint256 taskId) {
        taskId = _createTask();
        (, uint64 revealDeadline,,) = _taskDeadlines(taskId);
        (uint96 quoteA, bytes32 saltA, bytes32 commitmentA) = _quote(4 ether, "A");

        vm.prank(bidderA);
        tender.commitBid{value: BIDDER_STAKE}(taskId, commitmentA, keccak256("proof-A"));

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(bidderA);
        tender.revealBid(taskId, quoteA, saltA);

        vm.warp(uint256(revealDeadline) + 1);

        vm.prank(publisher);
        tender.selectWinner(taskId, bidderA);
    }

    function _quote(uint96 quote, string memory saltSeed)
        internal
        pure
        returns (uint96 actualQuote, bytes32 salt, bytes32 commitment)
    {
        actualQuote = quote;
        salt = keccak256(bytes(saltSeed));
        commitment = keccak256(abi.encode(quote, salt));
    }

    function _taskDeadlines(uint256 taskId)
        internal
        view
        returns (uint64 biddingDeadline, uint64 revealDeadline, uint64 executionDeadline, uint64 reviewDeadline)
    {
        (,,, biddingDeadline, revealDeadline, executionDeadline, reviewDeadline,,,,,,) = tender.tasks(taskId);
    }
}

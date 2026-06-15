import React from "https://esm.sh/react@18.3.1";
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm";

const { useEffect, useState } = React;

function normalizeBid(taskId, address, bid, orderIndex) {
  return {
    taskId: taskId.toString(),
    address,
    commitmentHash: bid.commitment ?? bid[0],
    proofHash: bid.qualificationHash ?? bid[1],
    stake: ethers.formatEther(bid.bidderStake ?? bid[2]),
    revealed: Boolean(bid.revealed ?? bid[5]),
    revealedPrice: ethers.formatEther(bid.revealedPrice ?? bid[3]),
    isSelected: Boolean(bid.selected ?? bid[6]),
    orderIndex,
    loadError: "",
  };
}

function toFriendlyError(error) {
  return error?.shortMessage || error?.reason || error?.message || "读取投标信息失败";
}

export function useTaskBidders(taskId, contract, refreshKey = 0) {
  const [bidders, setBidders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!contract || taskId === undefined || taskId === null) {
        setBidders([]);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const bidderAddresses = await contract.getBidders(taskId);
        if (!bidderAddresses.length) {
          if (!cancelled) {
            setBidders([]);
          }
          return;
        }

        const rows = await Promise.all(
          bidderAddresses.map(async (address, index) => {
            try {
              const bid = await contract.getBid(taskId, address);
              return normalizeBid(taskId, address, bid, index);
            } catch (bidError) {
              return {
                taskId: taskId.toString(),
                address,
                commitmentHash: "-",
                proofHash: "-",
                stake: "-",
                revealed: false,
                revealedPrice: "0.0",
                isSelected: false,
                orderIndex: index,
                loadError: toFriendlyError(bidError),
              };
            }
          })
        );

        if (!cancelled) {
          setBidders(rows);
        }
      } catch (loadError) {
        if (!cancelled) {
          setBidders([]);
          setError(toFriendlyError(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [contract, taskId?.toString?.() ?? String(taskId ?? ""), refreshKey]);

  return { bidders, loading, error };
}

import React from "https://esm.sh/react@18.3.1";
import { useTaskBidders } from "./useTaskBidders.js";

const { useMemo, useState } = React;
const h = React.createElement;

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function compareBySort(left, right, sortMode) {
  if (sortMode === "price") {
    if (left.revealed !== right.revealed) {
      return left.revealed ? -1 : 1;
    }
    if (!left.revealed && !right.revealed) {
      return left.orderIndex - right.orderIndex;
    }

    const leftPrice = Number(left.revealedPrice);
    const rightPrice = Number(right.revealedPrice);
    if (leftPrice !== rightPrice) {
      return leftPrice - rightPrice;
    }
    return left.orderIndex - right.orderIndex;
  }

  if (sortMode === "time") {
    return left.orderIndex - right.orderIndex;
  }

  if (left.revealed !== right.revealed) {
    return left.revealed ? -1 : 1;
  }

  return left.orderIndex - right.orderIndex;
}

function buildCell(className, content) {
  return h("td", { className }, content);
}

export function BidderListPanel({
  taskId,
  contract,
  task,
  refreshKey,
  onSelectWinner,
  onRefresh,
}) {
  const [sortMode, setSortMode] = useState("revealed");
  const [actingBidder, setActingBidder] = useState("");
  const { bidders, loading, error } = useTaskBidders(taskId, contract, refreshKey);

  const sortedBidders = useMemo(() => {
    return [...bidders].sort((left, right) => compareBySort(left, right, sortMode));
  }, [bidders, sortMode]);

  const canSelect = Number(task?.status ?? -1) === 3;

  async function handleSelect(address) {
    if (!onSelectWinner) return;
    setActingBidder(address);
    try {
      await onSelectWinner(address);
    } finally {
      setActingBidder("");
    }
  }

  return h(
    "section",
    { className: "bidder-panel-shell" },
    h(
      "div",
      { className: "bidder-panel-head" },
      h(
        "div",
        null,
        h("h3", { className: "bidder-panel-title" }, "投标人列表（Bidder List）"),
        h(
          "p",
          { className: "subtle bidder-panel-subtle" },
          "这里会展示当前任务下的所有投标人、揭标结果和中标状态，方便招标人直接比较。"
        )
      ),
      h(
        "div",
        { className: "bidder-toolbar" },
        h(
          "label",
          { className: "sort-field" },
          h("span", null, "排序方式"),
          h(
            "select",
            {
              value: sortMode,
              onChange: (event) => setSortMode(event.target.value),
            },
            h("option", { value: "revealed" }, "先看已揭标"),
            h("option", { value: "price" }, "按报价升序"),
            h("option", { value: "time" }, "按投标顺序")
          )
        ),
        h(
          "button",
          {
            className: "button ghost compact",
            type: "button",
            onClick: () => onRefresh?.(),
          },
          "刷新投标人列表"
        )
      )
    ),
    error ? h("div", { className: "bidder-state error" }, error) : null,
    loading ? h("div", { className: "bidder-state" }, "正在读取投标人列表...") : null,
    !loading && !error && !sortedBidders.length
      ? h("div", { className: "bidder-state" }, "这个任务下暂时还没有投标人。")
      : null,
    !loading && !error && sortedBidders.length
      ? h(
          "div",
          { className: "bidder-table-wrap" },
          h(
            "table",
            { className: "bidder-table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", null, "投标人地址"),
                h("th", null, "是否已揭标"),
                h("th", null, "揭标报价"),
                h("th", null, "投标押金"),
                h("th", null, "是否中标"),
                h("th", null, "操作")
              )
            ),
            h(
              "tbody",
              null,
              ...sortedBidders.map((bidder) =>
                h(
                  "tr",
                  { key: bidder.address },
                  buildCell(
                    "mono",
                    h(
                      "div",
                      { className: "bidder-address-block" },
                      h("strong", null, shortAddress(bidder.address)),
                      h("span", { className: "subtle mini" }, bidder.address),
                      bidder.loadError
                        ? h("span", { className: "row-warning" }, `读取异常：${bidder.loadError}`)
                        : null
                    )
                  ),
                  buildCell(
                    "",
                    h(
                      "span",
                      { className: `badge ${bidder.revealed ? "success" : "muted"}` },
                      bidder.revealed ? "✔ 已揭标" : "❌ 未揭标"
                    )
                  ),
                  buildCell("", bidder.revealed ? `${bidder.revealedPrice} ETH` : "未揭标"),
                  buildCell("", bidder.stake === "-" ? "-" : `${bidder.stake} ETH`),
                  buildCell(
                    "",
                    bidder.isSelected
                      ? h("span", { className: "badge selected" }, "已中标")
                      : h("span", { className: "badge muted" }, "未中标")
                  ),
                  buildCell(
                    "actions-cell",
                    canSelect && bidder.revealed
                      ? h(
                          "button",
                          {
                            className: "button compact",
                            type: "button",
                            disabled: actingBidder === bidder.address,
                            onClick: () => handleSelect(bidder.address),
                          },
                          actingBidder === bidder.address ? "处理中..." : "选择该投标人为中标人"
                        )
                      : h(
                          "span",
                          { className: "subtle mini" },
                          canSelect ? "仅可选择已揭标投标人" : "当前阶段不可选标"
                        )
                  )
                )
              )
            )
          )
        )
      : null
  );
}

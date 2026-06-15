# Frontend Preview

这个前端是一个不依赖 npm 的轻量页面，目的是先快速验证合约交互体验。

推荐预览方式：

```bash
cd ~/staking-tender-system
python3 -m http.server 4173
```

然后在浏览器打开：

```text
http://127.0.0.1:4173/frontend/index.html
```

使用方式：

1. 先部署 `StakingTender` 合约。
2. 点击“连接钱包”和“加载平台”。
3. 开始创建任务、投标、揭标和查看链上状态。

默认 ABI 路径使用：

```text
/out/StakingTender.sol/StakingTender.json
```

页面依赖浏览器联网加载 `ethers` ESM CDN。

## Encoding Rule

- 所有前端文件必须保持 UTF-8 编码。
- 不允许把中文 UI 文案保存成 GBK、ANSI 或混合编码。
- 后续如果没有明确需求，不要改写现有中文 UI 文案。
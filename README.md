# 中际联合实时波段看板

这是一个可直接部署到 GitHub Pages 的静态页面，用于跟踪中际联合（605305.SH）的实时股价、RSI 动态、估值区间、买卖点和波段操作区间。

## 功能

- 实时显示股价、涨跌幅、成交额、换手率
- 自动计算 RSI6 / RSI12 / RSI14 / RSI24
- 按目标 PE 和安全边际动态估算合理估值
- 生成理想买点、回踩买区、压力位、风控位
- 自动刷新行情，默认每 30 秒一次
- GitHub Actions 定时检查买卖点，并通过微信推送提醒
- 支持 GitHub Pages 静态托管

## 微信买卖点提醒

提醒任务由 `.github/workflows/wechat-alert.yml` 定时运行，默认在 A 股交易日交易时段附近每 10 分钟检查一次。触发以下信号时会推送：

- 理想买点
- 低吸观察
- 分批止盈
- 高位控仓
- 风控优先

先在 GitHub 仓库 `Settings` -> `Secrets and variables` -> `Actions` 添加以下任意一个 Secret：

- `SERVERCHAN_SENDKEY`：Server 酱 SendKey，适合个人微信提醒
- `WECHAT_WEBHOOK`：企业微信群机器人 webhook，适合群提醒

跟踪股票和参数在 `alert-config.json` 里配置：

```json
{
  "checkMarketHours": true,
  "cooldownMinutes": 120,
  "stocks": [
    {
      "query": "605305",
      "targetPe": 22,
      "safetyMargin": 12,
      "planSize": 30
    }
  ]
}
```

`query` 可以写股票代码或公司名称。添加多只股票时，在 `stocks` 数组里继续追加对象即可。

## 本地使用

直接用浏览器打开 `index.html` 即可。

## GitHub Pages 部署

推送到 GitHub 后，在仓库设置里启用 Pages：

1. 进入仓库 `Settings`
2. 打开 `Pages`
3. Source 选择 `GitHub Actions`
4. 推送到 `main` 分支后会自动部署

页面仅作个人跟踪和规则化复盘，不构成投资建议。

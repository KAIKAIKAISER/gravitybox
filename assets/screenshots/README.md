# GravityBox 高清实机截图资产说明

本目录保存 `README.md` 与 `README_EN.md` 所引用的全部 **2x Retina 高清实机截图（共 30 张，含深色/浅色双主题自适应版本）**。

## 隐私脱敏规范

所有账号、邮箱、额度与用量均源自隔离沙盒测试固件（`Alex`、`example.invalid` 保留域与模拟会话样本），**不包含任何真实个人凭据、真实 Token、本地项目名称或生产账号信息**。

## 资产生成方式

- **原生 Swift / AppKit 窗口与菜单栏截图**：由 `npm run test:native-ui` 在临时沙盒目录采集后，经 `swift tools/generate-screenshots.swift` 添加 macOS 圆角裁剪、交通灯按钮与全景 Hero 合成，输出 20 张 PNG。
- **IDE 对话状态栏（Telemetry HUD）截图**：在无头 Chromium (`deviceScaleFactor: 2`) 中加载项目真实 `runtime/hud-*.js` 模块渲染浅/深双色实景交互图，输出 HUD 总览图（`hud*.png`）、三胶囊常驻条近景（`hud-capsules*.png`）与三张展开详情卡片（`hud-card-*.png`）共 10 张 PNG。

## 截图清单

| 场景 | 浅色模式 (Light) | 深色模式 (Dark) | 分辨率 | 说明 |
| --- | --- | --- | --- | --- |
| **全景 Hero 首图** | `hero.png` | `hero-dark.png` | `2560×1440` | 主控制台总览与菜单栏面板合成视图 |
| **对话状态栏 (HUD) 总览** | `hud.png` | `hud-dark.png` | `2160×1080` | 嵌入 IDE 对话输入区底部的三胶囊状态条与向上弹出层 |
| **HUD 常驻三胶囊近景** | `hud-capsules.png` | `hud-capsules-dark.png` | `1600×352` | 输入框正下方的对话速度、Token 缓存、压缩与上下文水位三枚胶囊 |
| **HUD 卡片 1 · 对话统计** | `hud-card-session.png` | `hud-card-session-dark.png` | `1760×792` | 点击第 1 枚胶囊向上展开的对话轮次、用时、TTFT/TPS 与子智能体明细 |
| **HUD 卡片 2 · Token 用量** | `hud-card-tokens.png` | `hud-card-tokens-dark.png` | `1760×792` | 点击第 2 枚胶囊向上展开的缓存命中、思维链/回复拆分与等效费用明细 |
| **HUD 卡片 3 · 当前上下文** | `hud-card-context.png` | `hud-card-context-dark.png` | `1760×792` | 点击第 3 枚胶囊向上展开的压缩徽章、双色分段进度条、峰值与模型明细 |
| **主窗口 · 总览** | `overview.png` | `dark-overview.png` | `2200×1520` | 账号配额双周期看板、当日消耗趋势与活跃模型 Top |
| **主窗口 · 账号** | `accounts.png` | `dark-accounts.png` | `2200×1520` | 多账号卡片、状态徽标与原子事务安全切换入口 |
| **主窗口 · 用量** | `usage.png` | `dark-usage.png` | `2200×1520` | 分周期 Token 核算、API 费用估算与缓存命中率趋势 |
| **主窗口 · 设置** | `settings.png` | `dark-settings.png` | `2200×1520` | 显示语言（跟随系统 / 简体中文 / English）、界面汉化、对话状态栏、自动更新价格基准与存储管理 |
| **主窗口 · 关于** | `about.png` | `dark-about.png` | `2200×1520` | 版本信息（v1.1.4）、应用内更新检测与目标版本状态 |
| **菜单栏 · 用量** | `menubar.png` | `dark-menubar.png` | `792×1288` | 菜单栏面板默认“用量”视图 |
| **菜单栏 · 配额** | `menubar-quota.png` | `dark-menubar-quota.png` | `792×1118` | 菜单栏面板“配额”与备用账号推荐 |
| **菜单栏 · 账号** | `menubar-accounts.png` | `dark-menubar-accounts.png` | `792×1162` | 菜单栏面板一键安全切号入口 |
| **存储瘦身与清理** | `maintenance.png` | `dark-maintenance.png` | `1480×1448` | 无损缓存评估、废纸篓移入清理与快照一键还原 |

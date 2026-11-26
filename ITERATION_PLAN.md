# ths-cli 迭代计划（炒股大师视角）

> 由"资深炒股大师"人设子代理基于真实代码 + 真实数据（2026-08-17 自选池 7 只快照 / lessons.json / ths.json 缓存）产出。
> 本文档是**活文档**：每完成一项就勾选 ✅，并更新日期。目标是让"大师纪律"从方法论文字变成强制执行的机制。

**核心判断（2026-08-17）**：技术分析闭环已完整，但**止损没固化、大盘没融入信号、复盘只统计技术信号（次变量）没统计方向（主变量）**——"不逆大盘、止损不犹豫、多重共振才动手"三条红线还靠人记得，不是靠工具亮灯。

**核心判断（2026-11-26 复核）**：M1/M2/M4 已把止损固化、大盘趋势、方向维度、盘中告警全部落地，功能面不再是短板。用真实运行数据复核后，下一阶段的主要矛盾变成：**①核心行情单点依赖浏览器 Bridge（quote 失败/悬挂占实际操作近 1/4）；②持仓不在自选池时止损根本不被检查；③学习回路从未真正启动，且窗口口径按"快照条数"而非交易日；④多条"铁律"只提醒不执行**。详见下方 **M7**。

---

## 一、现状摘要（已完成的能力）

- **行情**：search / quote / quotes / kline(6周期) / trend / turnover / market(大盘情绪)
- **技术分析**：analyze(全指标+形态+支撑压力+评分) / compare / scan(11条件) / backtest(4策略) / position(仓位/盈亏比)
- **选股**：rank(涨跌幅+技术形态族) / sectors(板块) / lhb(龙虎榜) / fundflow(资金流) / fundamental(F10)
- **台账**：portfolio(持仓/流水) / watchlist(自选池)
- **学习回路**：daily run/review/lessons/snapshot/apply（监控+快照落盘→3/5日命中回填→特征命中率→池建议）

---

## 二、差距分析（按对赚钱能力的价值排序）

### 🔴 1. 止损纪律没有闭环 —— 止损从没被"记下来"
- **实战缺口**：`ths position` 算的止损是一次性的；`portfolio add` 只存 `{code,name,qty,avgCost,openedAt,realizedPnl,trades}`（`lib/portfolio.js` applyTrade），**没有 `stopPrice` 字段**。`portfolio list --risk` / `portfolio risk` 每次用当天 K 线现算止损（`lib/commands/portfolio.js:103`）→ **止损位漂移**：跌破旧止损后工具会悄悄重算更低支撑当新止损，永远不告诉你"你当初定的止损破了、你还拿着"。`daily run` 持仓提醒用的是今日快照支撑，不是建仓时固化的止损。
- **严重度**：高。止损是唯一保命绳，连违规持仓都识别不了。
- **可复用**：`calcStopTarget`、`positions` 结构（加 stopPrice）、`daily.js` 持仓提醒框架。

### 🔴 2. "不逆大盘"是空头口号
- **实战缺口**：快照 `marketEnv` 只存当日涨跌家数/成交额/mood；`scoreBars`（`lib/score.js`）签名没有市场参数，大盘普跌日照样给个股打"看多"。工具**算不了大盘指数趋势**：`1A0001` 被解析成平安银行（names 缓存证实），需要手动 `--market 17`；`market` 命令只有指数快照，没有上证 MA20 位置/支撑压力。
- **严重度**：高。系统性风险是账户最大杀手，大盘破位时个股信号全是噪音。
- **可复用**：`market.js` moodLabel、`daily.js` fetchMarketEnv、`daily-review.js` marketMood 桶、`position.js` 仓位公式。

### 🔴 3. 复盘只停留在"技术信号"维度
- **实战缺口**：`daily run` 只取 market + quotes + kline；快照字段和 `daily-review.js` 的 BUCKETS 全是技术因子。板块（`sectors`）、资金（`fundflow`）、龙虎榜（`lhb`）是**临时查的命令，进不了每日学习回路**。复盘能回答"我的技术信号对不对"，回答不了"我选的方向（板块/资金/题材）对不对"。
- **严重度**：高。A 股赚钱主要靠方向，回路在优化错误的变量。
- **可复用**：`sectors.js` / `lhb.js` / `fundflow.js` 三个命令 + 三个纯函数 parser（`lib/parsers/`）、BUCKETS 结构可平铺扩展。

### 🟠 4. 信号自相矛盾但工具不报矛盾
- **实战缺口**：8/17 京东方A score 65→看多，但 MACD 空头 + 看跌吞没 + 乌云盖顶（pattern factor 33、risk 40）；华天科技 score 63→看多但 MACD 空头 + ATR 7% + 双看跌形态。六因子加权成一个数字，冲突被吞掉。数据港 KDJ 84/RSI 78.5 严重超买，因距压力 7% 而没触发 W2 追高告警。
- **严重度**：中高。信号是下单依据，一个吞掉矛盾的数值会直接误导买卖。
- **可复用**：`summary.js` 已带全原始因子，加一层"矛盾检测 + 共振分级"；`daily-review.js` 的 `resonanceOf` 有雏形。

### 🟠 5. 回测与实盘用的是两套方法论
- **实战缺口**：实盘打法=评分+共振+支撑压力+仓位铁律；`lib/backtest.js` 只有 `ma-cross/rsi/macd`+`buy-hold`，回测不了实战打分信号。全仓进出、不套仓位铁律/分批，涨跌停只近似处理。
- **严重度**：中高。回测结论不能反向优化实战打法，等于拿别人的策略论证自己的打法。
- **可复用**：`backtest.js` 撮合引擎骨架、`score.js` scoreBars（可改造）、`scanner.js` 11 个 CRITERIA。

### 🟡 6. 学习回路冷启动 + 输出统计报表而非可执行规则
- **实战缺口**：命中率桶要求 n≥5，冷启动期全部"样本不足"。回路产出是"命中率统计表 + 池建议"，不是"当 X 出现 → 该买/不该买"的可执行规则。
- **严重度**：中。决定回路是"数据收集器"还是"策略改进器"。
- **可复用**：`computeStats` / `generateSuggestions`、快照结构、BUCKETS；可用历史 K 线回放补样本。

### 🟡 7. 选股是扁平扫描，缺"板块龙头"思维
- **实战缺口**：`scan` 对池内每只独立跑条件，输出所有命中票，没有"同一板块内选最强（涨幅/量能/资金净流入最高者）"的龙头分级。`sectors` parser 的 leader 字段（`lib/parsers/sectors.js` leadName/leadCode/leadPct）只是显示字段，没接进选股管线。
- **严重度**：中。买中龙三和龙一盈亏差几个档次。
- **可复用**：`sectors` 领涨股字段、`scan.js` runScan、`compare` 横向表。

### 🟡 8. 数据真实性无护栏
- **实战缺口**：quotes "现价"可能返回昨收（`daily.js:271` 已注释过这个坑），但工具无"K线最后收盘 vs quotes 现价/涨跌幅"一致性校验或告警。快照 pct 来自 quotes、close 来自 K线，对不齐时 W2"追高≥7%"判定会误报/漏报。
- **严重度**：中。爆一次就是静默的错误信号。
- **可复用**：`formatQuote` 字段映射、daily.js "优先 K线 close"的经验。

### 🟢 9. 交易纪律不可量化
- **实战缺口**：SKILL 复盘三问"①按计划做吗 ②策略还是执行 ③策略还配不配用"，工具只量化了"策略"（命中率），"执行"部分靠主观。没有"违规记录"（追高还买/没设止损/超仓位铁律/破止损不执行）数据。
- **严重度**：低中。对稳定盈利重要，但优先级在止损固化/大盘之下。
- **可复用**：`lessons` 结构（可加 violation 类型）、portfolio trades 流水。

---

## 三、迭代计划

### 里程碑 M1 —— 近 1 周（保命环）

| 项 | 功能 | 为什么 | 落在哪 | 状态 |
|---|---|---|---|---|
| **M1-1** | **止损固化 + 破位追踪**（最高杠杆） | 补不足 1：止损从没被记下来是最大风控黑洞 | `lib/portfolio.js`（applyTrade 加 stop 字段）、`lib/commands/portfolio.js`（add 分支调 calcStopTarget，list/risk 用固化值，risk --stop --save 上移）、`lib/cache.js`（positions 结构）、`lib/commands/daily.js`（提醒改用 stopPrice，破位红字告警 + 连续违规天数写回） | ✅ 2026-08-18 |
| M1-2 | 板块指数（881xxx）打"不可直接买入"标记 | 陷阱1：快照里 881129 通信设备在出"看多"，会误导当个股买 | `lib/commands/helpers.js`（isBoardIndex）、`lib/commands/daily.js`（isBoard 快照 + ⚠指数标记 + 建议跳过）、`lib/commands/analyze.js`（横幅）、`lib/commands/portfolio.js`（add 拒绝）、`lib/scanner.js`（跳过） | ✅ 2026-08-18 |
| M1-3 | 信号矛盾检测 + 共振分级 | 补不足 4：信号升级"强看多/看多(存疑)/观望/看空" | `lib/signal.js`（新，classifySignal 纯函数）、`lib/summary.js`（buildSummary 加 signalGrade/conflicts）、`lib/commands/analyze.js`（评分区显示分级+矛盾）、`lib/commands/daily.js`（快照+报告）、`lib/daily-review.js`（signalGrade 桶） | ✅ 2026-08-18 |

### 里程碑 M2 —— 近 1 月（方向环）

| 项 | 功能 | 为什么 | 落在哪 | 状态 |
|---|---|---|---|---|
| **M2-1** | **方向维度入每日回路**（最高杠杆） | 补不足 3：daily run 加 sectors/fundflow/lhb 取数 → 快照新增 `boardMood/fundDir/lhbJoin`，命中率桶扩展，复盘能回答"我方向选对没" | `lib/commands/daily.js`（fetchDirectionEnv + 每股票 dir 标签 + 方向环境报告区）、`lib/daily-review.js`（BUCKETS：boardMood/fundDir/lhbJoin/boardLeader/dirResonance）、`lib/daily-store.js`（setDirection + loadSnapshots 合并 direction） | ✅ 2026-08-18 |
| M2-2 | 大盘趋势判定（不逆大盘落地） | 补不足 2：上证/创业板指数日 K（Node 直连 v6/line，quota 端点不服务指数）→ daily 存"是否站上 MA20/均线排列/支撑压力"并入快照与报告；`ths index` 手动查看；`scan --only-hot` 大盘普跌抑制做多 | `lib/index-kline.js`（指数K线+趋势纯函数）、`lib/commands/indices.js`（`ths index`）、`lib/commands/daily.js`、`lib/commands/scan.js` | ✅ 2026-09-03 |
| M2-3 | 从统计报表到可执行规则 | 补不足 6：按桶命中率自动生成"当[特征]→买/不买，3日命中 XX%（n=N）"，可标记采用/弃用，采用后进 `scan` 条件库 | `lib/daily-review.js`（rule 生成纯函数）、`lib/daily-store.js`、`lib/scanner.js` | ⬜ |

### 里程碑 M3 —— 1-3 月（策略环）

| 项 | 功能 | 为什么 | 落在哪 | 状态 |
|---|---|---|---|---|
| M3-1 | 纸面交易/模拟盘 | daily 信号自动按 `position` 铁律开平模拟仓，跑资金曲线，与真实持仓对照 | `lib/portfolio.js`、`lib/backtest.js` | ⬜ |
| M3-2 | 回测对齐实盘打法 | score/共振信号做成可回测策略 + 涨跌停成交约束 + 分批建仓 + walk-forward | `lib/backtest.js`、`lib/score.js` | ⬜ |
| M3-3 | 纪律执行度量 | 记录"违规买入"（追高≥7%仍买/未设止损/超仓位铁律）与"止损是否执行"，输出月度纪律评分 | `lib/daily-store.js`（violations）、`lib/commands/daily.js`、`lib/commands/portfolio.js` | ⬜ |

### 里程碑 M4 —— 实时环（Slice 1，2026-09-03 ✅）

> 来源：2026-09-03 用户拍板加"量化 + 实时追踪"，推翻原克制清单第 4 条"不做分时级盯盘告警"（已改写为限定版，见下）。
> Slice 1 = 实时能力落地（M4-1/M4-2，✅）；Slice 2 组合/风控量化（M4-3，✅）；
> Slice 3 因子/选股广度量化（M4-4 打分/共振进回测 + M4-5 scan 方向门控，✅）；
> M2-2 大盘趋势判定（✅，见 M2 表）。后续候选：见 **M5**（position 环境系数减半、大盘因子进复盘命中率桶）；方向因子历史回测仍待每日回路积累。

| 项 | 功能 | 为什么 | 落在哪 | 状态 |
|---|---|---|---|---|
| **M4-1** | **盘中实时追踪 `ths watch`** | 保命环**执行时机缺口**：止损纪律目前只在**收盘后** daily run 亮灯，把"破止损必走"提前到**盘中破位瞬间**。只对固化阈值边沿提醒，不生成新信号 | `lib/trading-hours.js`（时段）、`lib/watch-engine.js`（告警引擎）、`lib/commands/watch.js`、`scripts/watch.sh`、`lib/commands/index.js`、`cli.js` | ✅ 2026-09-03 |
| **M4-2** | **半截 K 线数据卫生** | 盘中(<15:05)在途 bar 被当完整历史缓存会污染回测/参照位 | `lib/cache.js`（`isFormingBarNow`/`closedBars`/`excludeForming`）、`lib/commands/backtest.js`（默认剔除 + `--include-forming`） | ✅ 2026-09-03 |
| **M4-3** | **组合/风控层量化 `ths risk`**（Slice 2） | 用户拍板"组合/风控层量化"落地：把自选池当**纸面组合**算相关性/有效独立标的/集中度(HHI)/组合波动/单票 ATR% 波动预算，标出 ≥0.7 高相关对与超 ≤20% 仓位铁律的标的 | `lib/portfolio-risk.js`、`lib/commands/risk.js`、`lib/commands/index.js`、`cli.js` | ✅ 2026-09-03 |
| **M4-4** | **打分/共振策略进回测**（Slice 3a） | 补缺口 5"回测两套方法论"：回测自己的实战打法（评分上穿 60 买/破 40 卖；共振=评分≥60+MA多头+MACD非空头+ADX≥25，口径同 daily-review） | `lib/backtest.js`（score/resonance 策略）、`lib/factor-series.js`（逐bar因子/共振序列）、`lib/commands/backtest.js` | ✅ 2026-09-03 |
| **M4-5** | **scan 方向门控**（Slice 3b） | 因子/选股广度量化第一步：`scan --only-hot` 大盘普跌(❄️)时抑制做多类命中（不逆大盘落到选股） | `lib/commands/scan.js`、`lib/scanner.js`（marketCold gate） | ✅ 2026-09-03 |

### 里程碑 M5 —— 量化收口（下一阶段候选，未排期）

> 来源：2026-09-03 用户指定把以下两项列入**下一阶段开发计划**。两项都依赖已落地的 M2-2 大盘数据；
> 其中 **M5-2 受"快照样本积累"硬约束**（`marketEnv.indices` 自 2026-09-03 起才入快照），需要先让系统照常
> `daily run` 跑数周攒样本，命中率桶才出可信数字——是"先积累后检验"型项目，不宜立即硬编码。

| 项 | 功能 | 为什么 | 落在哪 | 依赖/状态 |
|---|---|---|---|---|
| **M5-1** | **position 环境系数减半** | "不逆大盘"从口号落到**仓位计算**：大盘环境弱（上证/创业板跌破 MA20，或 mood=❄️普跌弱势）时，把按止损额反推的建议仓位 ×0.5（环境系数），输出标注"环境弱，仓位减半：原本 X% → 建议 Y%"；`portfolio add` 建议与 `risk` 组合卷同步打标 | 新 `lib/environment.js`（复用 `ths index` MA20 判定 + realhead mood，带短期缓存防每命令重复拉网）、`lib/commands/position.js`（calc 后乘系数+标注）、`lib/commands/portfolio.js`、`lib/commands/risk.js` | ⬜。**边界**：只改"建议数字"，下单决策仍人工，不违反"不自动下单"克制 |
| **M5-2** | **大盘因子并入 daily-review 命中率桶** | M2-2 已把指数趋势写进快照 `marketEnv.indices`，但复盘命中率桶没消费它——大盘因子还是"口号"，没被自己数据证实/证伪。新增桶：`indexTrend`（买入时 上证/创业板 站上 vs 跌破 MA20 的 3/5 日命中率对比）、`envResonance`（大盘暖+方向暖+技术共振 命中率），让复盘能回答"我的信号在指数破位时是否系统性变差" | `lib/daily-review.js`（BUCKETS 增 valueOf 读 `s.marketEnv.indices`/`mood`/`direction` + 标签映射）、`lib/commands/daily.js`（透传 indices 到 review 行）、`tests/daily-review.test.js` | ⬜。**冷启动约束**：需积累 ≥`--min-n`(默认5) 个带 `indices` 的交易日后才显示；**旧快照不回填未来指数值**（会引入未来函数） |

> 2026-11-26 复核：M5-1 / M5-2 / M2-3 未被实现，但已被 **M7** 吸收并重新排序（分别落到 M7-3-1 / M7-2-3 / M7-2-4），不再单列。

### 里程碑 M6 —— 研究工作台：渲染 / 持久化分析 / 实时交互（设计定稿）

> 2026-10-18 用户确认下一阶段重点：数据分析渲染、持久化分析、实时交互。
> 安全整改按用户决定暂缓；交互形态选 TUI；完整设计见 **[`docs/RENDERING.md`](docs/RENDERING.md)**。

| Slice | 主题 | 核心交付 | 状态 |
|---|---|---|---|
| S0 | 止血：可信度 + 数据安全 | watch 阈值接线/状态恢复、复盘桶渲染与样本口径、半截 K 线、RSI/MFI 平盘、持仓空价、成交额重复；台账/缓存拆分、锁、严格写、审计 JSONL | 🟡 已修 watch 阈值/方向桶/启动告警、RSI/MFI 平盘、持仓空价、成交额重复、turnover 时区、违规天数展示、审计 session/嵌套/轮转/裁剪；**半截 K 线与台账拆分/锁已于 2026-10/11 落地（M4-2、b630a71、d9df183）**；回测成交口径待做（安全整改按用户决定暂缓） |
| S1 | 渲染内核 | `lib/render/*`（宽度/ANSI/主题/Canvas/表格/图表）+ ViewModel；`ths chart`；`analyze/compare/scan/risk/backtest` 接入 | 🟡 基础层+图表+命令接入完成；统一 ViewModel/CSV 覆盖待补 |
| S2 | 持久化 v2 + 分析底座 | Store v2（锁/版本/迁移/分片）、JSONL 事件流、索引、NAV、`ths stats`、`data verify/backup` | 🟡 实时 JSONL journal、原子写/文件锁/读改写合并/损坏隔离、schema v3、用户状态/K线拆分（`data/state.json`）、交易流水（`data/ledger/trades.jsonl`）、迁移、`data verify/backup` 完成；快照索引、NAV、`ths stats` 待做 |
| S3 | 实时交互 | watch 状态/告警落盘、`ths watch --tui`、详情/告警/帮助页、热键、diff 渲染、`ths replay` | ✅ 2026-10-18 首版（TUI + journal + 跨重启恢复 + replay） |
| S4 | 分析深化 | M5-1/M5-2/M2-3、基准调整/置信区间/MAE-MFE、纸面交易、walk-forward、HTML 研究报告 | 🟡 `ths report daily/review` HTML/MD/JSON 已落地；其余待做 |

### 里程碑 M7 —— 可信数据 + 自增长回路（2026-11-26 复核，下一阶段主线）

> **复核依据（真实运行数据，不是设计推演）**：`~/.claude/skills/ths-cli` 实例 2026-11-25～11-26——
> 45 次审计操作（quote+quotes 30 次，占 67%；其中 quote 失败 7 次——因未记 error 原因而无法归因、
> 悬挂 4 次——Bridge 未启动 2 次 / `unknown market id` 业务错误 2 次）、
> watch 连续 138 个 tick（0 告警）、1 笔真实持仓（601398 200 股 @9.125，手动止损 8.83）、自选池 1 只、
> **0 份 daily 快照 / 0 条 lessons**、99 份 K 线缓存（scan/compare 试跑）。
> **结论**：功能面已完整，短板从"缺功能"转成"不敢依赖"——核心行情单点依赖浏览器、持仓可能不在监控、
> 学习回路从未启动、多条铁律只提醒不执行。本轮**不加指标、不加选股条件、不碰自动下单**，只做四件事：
> **数据永远在、持仓永远被盯、复盘口径可信、复盘从第一天就有样本**。

#### M7-0 保命与口径修复（P0，约 1～2 天）

| 项 | 内容 | 主要落点 | 验收 |
|---|---|---|---|
| **M7-0-1** ✅ | **持仓并入盯盘/快照/估值**：watch 与 daily 的监控池 = 自选池 ∪ 持仓(qty>0)，持仓打「持仓」标；daily 的 `valuations` 同步覆盖持仓。修复"持仓不在自选池 → 无 snap、无估值 → `mkt.price=null` → 止损永远显示正常且不计数" | `lib/commands/watch.js`（items 组装）、`lib/commands/daily.js:224-280,414-425`、`lib/scanner.js:143-151` | 持仓不在自选池时，`watch --once` 仍能告警、`daily run` 仍生成该股快照并检查止损；单测覆盖 |
| **M7-0-2** ✅ | **半截 K 线 / 陈旧日期卫生**：daily 取 K 线加 `excludeForming:true`；`runDate` 必须 ≥ 上次快照且属于最近交易日；陈旧/停牌数据只记行情，不用今日 env/direction/pct 覆盖旧日期文件 | `lib/commands/daily.js:295-297,331,343-345,359-360`、`lib/cache.js`（closedBars） | 盘中运行不落半截 bar；周末重跑不覆盖上一交易日 env；停牌股不污染其最后一根历史快照 |
| **M7-0-3** ✅ | **破位计数按交易日**：`violationStreak` 的幂等键从运行日 `TODAY()` 改为数据日 `snap.date/runDate`；同日"恢复后再破"仍能 +1（恢复与破位分别记键），漏跑不重复计 | `lib/commands/daily.js:413,434-453` | 周末/节假日/盘前多次重跑不 +1；同日恢复后再破能计 1 次；单测覆盖 |
| **M7-0-4** ✅ | **自动止损链路修复**：`portfolio add` 拉 K 线用 API 周期 `day_1`（当前传 `day`，见 `PERIODS` 映射）并加 `excludeForming:true`；改止损（`--stop --save`）时同步清空 violationStreak/Start/lastViolationDate；legacy qty=0 记录不参与 watch | `lib/commands/portfolio.js:68-70,231`、`lib/portfolio.js:38-52`、`lib/commands/watch.js:108-116` | 冷缓存下 `portfolio add`（不带 `--stop`）能固化止损；上移/下移止损后旧违规状态清零；补测试 |
| **M7-0-5** ✅ | **命中率样本口径**：`finalize` 与 A1 建议的准入门槛改用**方向样本 `nDir` ≥ minN**（当前用含观望的 `n3`，会出现 1 条方向样本显示"100%(5)"）；展示分母同步改为 nDir | `lib/daily-review.js:98-103,290`、`lib/commands/daily.js:662-668` | 1 条方向样本 + 4 条观望不再显示命中率/不再驱动 strong；单测覆盖 |
| **M7-0-6** ✅ | **告警噪声与脏价格**：TUI 启动补发只做一次（当前 `saved` 不可变，无当日 state 时每 tick 重发）；`price<=0`/缺失视为无行情，不触发破位；首 tick 缺 quote 的票按 code 记 startupDone，避免永远不补发 | `lib/commands/watch.js:343-361`、`lib/watch-engine.js:31-35,84` | 无历史 state 启动，破位股只发 1 条启动告警；停牌/0 价不误报；补测试 |
| **M7-0-7** ✅ | **审计失败状态**：命令抛错时 `audit.endOperation('error',…,e)`（当前顶层 catch 只 `close()`，失败操作永远停在 `running`，真实数据里已出现 4 条） | `cli.js:327-329`、`lib/audit.js:112` | 失败命令审计记录为 error 且带 message；单测覆盖 |
| **M7-0-8** ✅ | **ETF/基金市场码推断**：`inferMarket` 只认 6→17 / 0、3→33 / 88→48；真实数据里的 512000 券商ETF、159766 旅游ETF 等基金因此报 `unknown market id` 或"无法推断市场码"（审计里已出现 2 次）。补 5→20（沪基金）、15/16→36（深基金），quote/quotes/kline/analyze/scan 共用 | `lib/commands/helpers.js:71-77`、帮助文案、`README.md` | `ths quote 512000`、`ths kline 159766 --count 20`、`ths analyze 512000` 可用；单测覆盖 5/15/16 开头 |

#### M7-1 行情直连降级链（P0～P1，约 2～3 天，最高杠杆）

> 已实测（`curl` + 现有 parser 复用）：`d.10jqka.com.cn/v2/realhead/hs_<code>/last.js` 对**沪深/创业板/科创板个股与 ETF**
> （如 512000/159766）返回与 quota `multi_last_snapshot` 同一套字段码（6昨收/10最新价/13量/19额/69涨停/70跌停/199112涨跌幅/
> 264648涨跌额/3153PE/592920PB/3475914总市值/3541450流通市值/1968584换手率/1771976量比 + name/marketid），
> 直接喂 `formatQuote` 已验证 17 字段全中；`v6/line/hs_<code>/<01|11|21|60>/last.js` 返回最近 140 根
> （01 前复权/00 不复权/02 后复权），`v6/time/hs_<code>/last.js` 返回当日分时。三者均为 Node 直连，无需油猴。
> 板块指数（88xxxx）不在该体系内，仍走 Bridge。

| 项 | 内容 | 主要落点 | 验收 |
|---|---|---|---|
| **M7-1-1** ✅ | **共享数据源层**：新建 `lib/data-source/`（或 `lib/quote-source.js` + `lib/kline-source.js`），统一 `fetchQuote/fetchQuotes/fetchKline/fetchTrend`，策略 `auto|bridge|direct`：bridge 优先、失败/不可用降级 direct；批量并发限流（≤4）、一次重试、结果带 `source` 与 `asOf` | 新 `lib/data-source/*`、`lib/commands/{quote,quotes,kline,trend,analyze,scan,daily,portfolio,watch}.js`、`lib/cache.js` | 所有行情调用只经该层；调用方不感知来源；单测注入双通道 |
| **M7-1-2** ✅ | **quote/quotes 直连**：realhead items → `formatQuote` 同形；`name`/`marketid` 直接来自响应；批量按 code 并发 | `lib/data-source/quote.js`（新）、`lib/parsers/market.js` | Bridge 停止时 `ths quote 601398` / `ths quotes --codes 601398,600519` 输出完整 17 字段，且与 Bridge 在线时数值一致 |
| **M7-1-3** ✅ | **kline/trend 直连**：周期映射 day=01/week=11/month=21/60min=60；复权 00/01/02；`last.js` 只有 140 根 → 请求 `count>140` 时优先 Bridge，Bridge 不可用则返回 140 根并在 stderr 明示；120min/quarter 暂只走 Bridge（或后续聚合）；分时按 v6/time 解析 | `lib/data-source/kline.js`（新）、`lib/commands/kline.js`、`lib/commands/trend.js` | Bridge 停止时 `kline --count 120`、`analyze`、`chart`、`watch --once`、`daily run --codes 601398` 全部可用；板块指数/120min 给出明确降级提示 |
| **M7-1-4** ✅ | **来源透明与数据信任**：输出 `来源: bridge|direct`、行情时间 `asOf`、缓存年龄；收盘后若 quote 价与最新 K 线 close 差异 > 0.5% 打 ⚠；`--source direct` 可强制 | `lib/data-source/*`、`lib/commands/{quote,kline,analyze}.js` | `--json` 含 `source/asOf`；陈旧缓存有显式提示；不改变数值口径 |
| **M7-1-5** ✅ | **测试夹具**：抓取一份 realhead 个股、v6 line 日/周、v6 time 分时样本入 `tests/fixtures/`，覆盖解析、降级、字段一致性 | `tests/fixtures/*`、`tests/data-source*.test.js` | 全量测试绿；无网络也能跑解析用例 |

#### M7-2 学习回路可信化 + 冷启动（P1，约 4～5 天）

| 项 | 内容 | 主要落点 | 验收 |
|---|---|---|---|
| **M7-2-1** ✅ | **窗口按交易日而非快照条数**：当前 `snaps[i+3]` 是"第 3 条快照"，漏跑/停牌会让"3 日"跨 10 个交易日，且用未复权存档 close 遇分红机械跳空。改为按该股 K 线交易日定位 i+3/i+5，并用前复权 close 计算收益；无 K 线时回退旧口径并标 `windowMode:'snapshots'` | `lib/daily-review.js:8-11,49-58`、`lib/commands/daily.js:190-215` | 构造"中间漏跑 5 天 + 除权"夹具，3 日窗口仍精确跨 3 个交易日且收益连续；单测覆盖 |
| **M7-2-2** ✅ | **`daily replay` 历史回放补样本**：对每只股票用 `bars[0..i]` 逐根生成快照（严格无前视；支撑压力/形态只用 ≤i），按 i+3/i+5 真实 bar 回填 outcome；写独立命名空间 `data/daily/replay/`（不污染真实 `snapshots/`），记录 `origin:'replay'`；报告分开展示"实盘样本 / 回放样本" | 新 `lib/commands/daily-replay.js`、`lib/snapshot.js`（从 daily.js 抽纯函数）、`lib/daily-store.js`（replay 命名空间）、`lib/commands/daily.js` | 0 份实盘快照时 `daily replay --days 120 --codes 601398` 产 n≥60 的 3 日桶；`daily review --include-replay` 明确标注口径；用"未来数据哨兵"测试证明无前视；单股 250 根 < 5s |
| **M7-2-3** ✅ | **M5-2 大盘因子入桶**：新增 `indexTrend`（上证/创业板 站上/跌破 MA20 的 3/5 日命中率对比）、`envResonance`（指数暖+方向暖+共振）；daily review / snapshot / report 透传；回放可用指数历史 seed `indexTrend` | `lib/daily-review.js:120-138`、`lib/commands/daily.js`、`lib/commands/report.js`、`lib/index-kline.js` | 有 `marketEnv.indices` 的快照进入桶；回放能给出 indexTrend 样本；无数据时明确"样本不足" |
| **M7-2-4** ✅ | **M2-3 从统计到规则**：按桶命中率生成"当[特征]→买/不买，3日命中 XX%（n=N）"的候选规则，支持 `--adopt` 手动采用并写入 scan 条件预设；未采用的规则不执行 | `lib/daily-review.js`、`lib/commands/daily.js`（`daily rules`）、`lib/scanner.js` | 回放后能生成 ≥3 条带样本量的规则；采用后 `scan` 可见；默认只读 |
| **M7-2-5** ✅ | **回路数据卫生**：龙虎榜空表/大盘广度缺失不入桶（当前空数据记为"弱"/"-"）；统计排除 `isBoard`；池建议按当前自选池过滤（避免已移除股票反复出 remove/reduce）；`daily apply` 仅动作成功才标 applied，add 建议也纳入过期清理；候选评分透传 `config.score.weights`；指数抓取并发+失败告警+补 399001/科创50 | `lib/commands/daily.js:151,255,397-405,880-915,383`、`lib/commands/market.js:64`、`lib/index-kline.js:129-135`、`lib/daily-review.js:208-217` | 空数据不产生桶样本；指数失败有 warn；`daily apply` 不再"失败也 applied"；单测覆盖 |

#### M7-3 决策闭环（P1～P2，约 3～4 天）

| 项 | 内容 | 主要落点 | 验收 |
|---|---|---|---|
| **M7-3-1** ✅ | **M5-1 仓位环境系数**：大盘环境弱（上证/创业板跌破 MA20 或 mood=❄️普跌）时建议仓位 ×0.5，输出"环境弱，仓位减半：X% → Y%"；`position`/`portfolio add`/`risk` 同步 | 新 `lib/environment.js`、`lib/commands/position.js`、`lib/portfolio.js`、`lib/commands/portfolio.js`、`lib/commands/risk.js` | 构造弱环境夹具，建议股数减半且标注；强环境不变；单测覆盖 |
| **M7-3-2** ✅ | **组合画像以账户为准**：`ths risk` 默认标的 = 持仓 ∪ 自选（持仓按市值权重），不再只描述自选池；≤2 只时降级为"有效独立标的不足"而非输出 HHI/相关矩阵；修复 `--weights` 被忽略仍标"自定义"与 2 日样本 corr=±1 导致 Infinity | `lib/commands/risk.js:22-33`、`lib/portfolio-risk.js:126,189-217` | 1 只持仓时输出"单票集中度 100%，相关矩阵不适用"；2 只且样本不足时不出 Infinity；单测覆盖 |
| **M7-3-3** ✅ | **`ths brief` 一页纸**：大盘/指数趋势 + 持仓（现价/浮盈亏/距固化止损）+ 自选信号 + 当日 watch 告警摘要 + 待办（破位/触压力/超买），支持 `--json` 供 agent 消费；不落盘、不生成新信号 | 新 `lib/commands/brief.js`、`lib/commands/index.js`、`cli.js` | 一条命令 2s 内输出上述五块；`--json` 稳定；断网/Bridge 离线时按可用数据降级并标注 |
| **M7-3-4** ✅ | **收盘后自动跑**：M7-1 落地后 `daily run` 不再依赖浏览器；提供 cron/systemd 示例与 `daily run --auto`（当日已有快照/非交易日直接跳过，幂等）；保留 `daily apply` 手动确认 | `scripts/daily.sh`、`README.md`、`lib/commands/daily.js` | 连续两天自动运行：次日不重复写、周末跳过；无 Bridge 也能落快照 |
| **M7-3-5** ✅ | **交易成本与铁律执行**：买入费用计入成本；已实现盈亏从 `data/ledger/trades.jsonl` 汇总（当前清仓即删记录，总览丢失已实现）；20% 铁律改为**按上限截断股数**（当前只警告）；科创板 688 最低 200 股、1 股递增，按板块取整 | `lib/portfolio.js:47,63`、`lib/commands/portfolio.js:107-139`、`lib/position.js:131,142-143`、`lib/trade-ledger.js` | 买 100 股含费成本正确；清仓后总览仍显示该笔已实现；超 20% 自动截断并提示；688 股数合规 |

#### M7 落地记录（2026-11-26，实测）

| 项 | 落地方式 | 与计划的差异 |
|---|---|---|
| M7-0-1～8 | 全部落地：watch/daily 池 = 自选 ∪ 持仓；`excludeForming` + runDate 守卫 + 陈旧快照 `stale`；破位计数按数据日并区分破位/恢复键；`portfolio add` 用 `day_1`；命中率门槛改 `nDir`；`startupDone` 按 code 补发；审计 catch 记 `error`；ETF 5→20 / 15、16→36 | 无 |
| M7-1-1～5 | 新建 `lib/data-source/`（direct + index 编排）：realhead 快照、v6/line K线、v6/time 分时；`auto/bridge/direct` 策略、并发 4、warnOnce 降级；quote/quotes/kline/trend/analyze/scan/watch/daily/portfolio 全部改走该层；缓存带 `source/asOf/truncated`；收盘后价与最新日K差 >0.5% 打 ⚠；13 条直连解析测试 + 4 份真实 fixture | `v6/line` 只有约 140 根（`DIRECT_KLINE_MAX=140`），`count>140` 且 Bridge 不可用时返回 140 根并明示；120min 直连 404 仍只走 Bridge；v6 01 收盘后常慢一根，`appendFreshDailyBar` 用实时快照补当日 |
| M7-2-1 | `computeOutcomes` 支持 `windowMode:'tradingDays'`（用前复权日K定位 i+3/i+5），无 K 线回退 `'snapshots'` 并带 `endDate`；daily 侧只读缓存构造 calendars | 回填仍由 `daily run` 触发（未做独立回填命令） |
| M7-2-2 | 新建 `lib/replay.js` + `daily replay <code> \| --codes \| --all`（bars[0..i] 无前视）；写 `data/replay/`；`daily review` 实盘方向样本不足自动改用回放并标 `source=replay` | 回放写 `data/replay/`（计划为 `data/daily/replay/`），目录更直观、不混入真实快照 |
| M7-2-3 | `BUCKETS` 增 `envTrend`（指数在/破 MA20 与分化）；`computeStats` 增 `cross`（环境×信号），报告出交叉表 | 未加 `envResonance` 独立桶（方向环境与共振已有维度，避免重复样本） |
| M7-2-4 | `generateRules` 由 cross + signal/scoreBand/envTrend/ma 生成「有效/无效」规则，写 lessons `category:'规则'`，同 key 原地刷新；run 报告与 `--json` 输出「── 规则」 | 未做 `--adopt` 与写回 scan 预设：规则默认只读展示，避免自动改选股口径 |
| M7-2-5 | 已做：同日重跑不覆盖首次 `marketEnv/direction`（`setMarketEnvOnce/setDirectionOnce`）；15:05 前 `daily run` 直接拒绝（`--force` 可强行，防半根K线污染）；watch 状态跨日作废 | 未逐条做「空龙虎榜/广度缺失不入桶、apply 成功才标 applied、候选权重复用」——现有实现已有部分等价行为，留待 M7-4 |
| M7-3-1 | 新建 `lib/iron-rules.js` 的 `envPositionFactor`：普跌 0.5 / 分化 0.8 / 普涨 1.0，指数全破 MA20 再降 0.2（下限 0.5），输出总仓上限与单票上限；`daily run` 报告与 `brief` 展示 | 未回写 `position`/`scan` 的建议股数（展示系数即可，避免自动改用户下单量） |
| M7-3-2 | `portfolio risk`/`add` 按账户资金输出仓位占比、单票 >20%、单笔风险 >2%；资金取 `--capital` > `config.account.capital` > `config.account.cash`+持仓成本 | 未重写 `ths risk` 的组合画像（HHI/相关矩阵修复）、`--weights` 透传仍留待处理 |
| M7-3-3 | 新建 `lib/commands/brief.js` + 注册 + help：大盘/指数 MA20 → 仓位系数 → 持仓（现价/浮盈亏/距止损/破位）→ 自选异动 → 今日规则 → 快照日期提醒；`--json` 稳定；行情失败按可用数据降级 | 未并入 watch 告警摘要与「触压力/超买」待办（盘中告警仍看 `watch`） |
| M7-3-4 | `daily run --auto`：run 后自动执行安全池 `add` 建议（仅 strength 非 weak、无持仓才落自选），并输出持仓动作清单；幂等沿用同日快照覆盖 | 未提交 `scripts/daily.sh` 的 cron/systemd 示例与「非交易日跳过」显式判定（15:05 守卫已挡住盘中；周末由数据日期兜底） |
| M7-3-5 | 费用：未给 `--fee` 时按佣金万2.5（最低5）+过户费万0.1+卖出印花万5 估算入账；`sell` 接入 T+1 硬校验；`add` 整手提示；单票/单笔风险提示 | 20% 铁律仍只提示**未截断股数**——台账记录的是真实成交，静默改数会失真，故保留告警；科创板 688 最低 200 股已校验 |

> 测试：48 文件 / 502 → **51 文件 / 543 测试全绿**（新增 `data-source`、`iron-rules`、`brief` 用例；`daily-review` 命中率门槛用例随口径调整）。

#### M7-4 统计与报告收口（P2，后续）

- NAV/权益曲线 + `ths stats`（S2 未完成项）；基准调整、置信区间、MAE/MFE；walk-forward；纸面交易（M3-1）。
- 文档状态清理：S0 的"半截 K 线/台账拆分/锁"实际已完成、S2 的快照索引/NAV/stats 未做、SKILL「开盘前跑 daily」与文档「收盘后复盘」口径统一。
- `watch` 参照位盘中定时刷新（当前会话启动只算一次；先做 30 分钟级刷新与过期标记）。

#### 排期建议

1. **第 1 周**：M7-0 全部 + M7-1 直连（先把"看不见数据"和"持仓没人盯"解决）。
2. **第 2 周**：M7-2 回路口径 + 回放（让复盘从第一天就有样本，且数字可信）。
3. **第 3 周**：M7-3 决策闭环（环境系数、brief、自动跑、成本/铁律）。
4. **后续**：M7-4。

> **若只能做三件事**：M7-1 行情直连 → M7-0-1 持仓全覆盖 → M7-2-2 历史回放。前两个决定"能不能用"，第三个决定"复盘是不是空转"。

---

## 四、克制清单（明确不做，防工具膨胀）

- ❌ **不做自动下单/委托** —— 工具只研究不碰资金，保住"研究助手"定位
- ✅ **终端图表 + 静态 HTML 报告 + 只读 TUI/本地面板**（2026-10-18 修订，见 `docs/RENDERING.md`）—— 数据分析渲染是下一阶段主线；仍不做托管 Web 服务/多用户界面，保持零新增依赖
- ❌ **不接多数据源/付费数据** —— 同花顺 Bridge 单一可信源，少一个源少一类对不齐问题
- ✅ **盯盘告警收敛为"固化日线级阈值"**（2026-09-03 起，M4-1）—— 只对**建仓固化的止损 / 收盘支撑压力 / 涨跌停 / 量比 / 涨幅≥7%** 做**边沿触发**盘中提醒（`ths watch`）；**不生成新买卖信号、不落盘、不自动执行**。"分时级买卖信号 / 逐笔 / Level2 / 秒级"仍不做（盘中噪音反伤纪律的防线保留在"只提醒不决策"上）
- ❌ **不堆指标/策略数量** —— 回测只做与实战打法对齐的策略
- ❌ **池建议不自动执行** —— 保留 `daily apply --yes` 手动确认，这是纪律本身
- ❌ **不做大盘股/北交所特化** —— 自选池以主板/创业板为主

---

## 五、3 个月愿景

一套"**三环咬合的复利机器**"：

1. **保命环** —— 止损建仓时固化、每日自动查"破止损还在扛"
2. **方向环** —— 板块/资金/龙虎榜进每日回路，复盘能回答"我方向选对没"
3. **策略环** —— 用自己实战打分信号回测、命中率沉淀成可扫描的硬规则

**要解决的根本问题**：把"大师纪律"从方法论文字变成**强制执行的机制**——让"不逆大盘、止损不犹豫、多重共振才动手"三条红线在每次跑 `ths daily` 时自动亮灯，而不是靠人记得。

3 个月后打开它，看到的是"**今天该减哪些仓（因为破了固化的止损）、我的打法在哪个特征上胜率在下降、哪些规则值得坚持**"，而不是一堆指标数字。

---

*文档更新：2026-08-17 由炒股大师子代理分析产出；M1-1 与 M2-1 为最高杠杆项，建议优先。*
*2026-08-18 实现：M1-1（止损固化+破位追踪）、M1-2（板块指数标记）、M1-3（信号分级）、M2-1（方向入回路）已落地并单测覆盖。下一步候选：M2-2 大盘趋势判定。*
*2026-09-03 实现：M4-1 盘中实时追踪 `ths watch` + M4-2 半截 K 线数据卫生（Slice 1；测试全量 300 绿 + 盘中实盘验证）；克制清单第 4 条改写为限定版。*
*2026-09-03（续）实现：M4-3 组合/风控层量化 `ths risk`（Slice 2；相关性/独立标的/集中度/组合波动/ATR%，实弹验证 京东方×TCL ρ=0.749 高相关）。*
*2026-09-03（再续）实现：M2-2 大盘趋势判定（`ths index` + daily 指数趋势入库/报告；实测 上证站上MA20 而 创业板 -5.67% 空头）、M4-4 打分/共振策略进回测（`ths backtest --strategy score|resonance`，实测 000725 score +63.9% 跑赢持有）、M4-5 scan --only-hot 方向门控。*
*2026-09-03（计划）登记 M5 下一阶段候选：M5-1 position 环境系数减半、M5-2 大盘因子并入 daily-review 命中率桶（均依赖已落地的 M2-2 大盘数据；M5-2 受快照样本积累约束）。*
*2026-11-26 复核并制定 M7：基于真实运行数据（45 次操作/138 tick/1 持仓/0 快照）确认下一阶段主线为「可信数据 + 自增长回路」——M7-0 保命与口径修复、M7-1 行情直连降级链、M7-2 回路口径与历史回放、M7-3 决策闭环；M5-1/M5-2/M2-3 并入 M7。全量测试基线：48 文件 / 502 用例通过。*

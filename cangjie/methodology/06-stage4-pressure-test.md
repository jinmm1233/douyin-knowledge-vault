# 阶段 4 — 压力测试 (darwin 兼容)

## 目标

在能力真正交付之前,用一批测试 prompt 验证它**被调用的精准度**和**被调用后的输出质量**。

不通过的必须回炉 — 不是表面修补 `description` 字段,而是重做阶段 2 的 A2 / E / B。

**v2.1 分层测试对象**:
- **晋级能力（promoted）**: 按本文全部要求测触发精度,诱饵中必须含"应由来源路由入口处理"的场景
  （晋级 Skill 与路由入口互斥的近邻负例,方案 §4.6.3）;
- **路由能力（router）**: 测"经来源路由入口可达"——给定意图 prompt,路由表应指向正确的能力卡;
- **两类共同要求**: 实际完成代表任务并核对交付物；触发或可达通过不能替代执行通过。
- 评测用例格式见 `schemas/eval-suite.schema.json`,可用 `scripts/run_trigger_evals.py` 做机械判分与
  train/validation 切分（60/40,固定种子,validation 在选版前保持隐藏）。

## 为什么必须做

A2 决定能力能否被找到，E/B 决定找到后是否做得对。压力测试应分别记录触发、可达、实际执行和边界处理，不能只用一项好成绩概括整体质量。

## 评测原则: 独立 sub-agent 盲测优先

压力测试要尽量模拟真实调用: 一个没有参与蒸馏过程、看不到预期答案的 agent,面对用户 prompt 时是否会自然激活这个 skill。

优先做法:
- 对每条测试 prompt 启动一个干净的 sub-agent,或在资源有限时对同一个 skill 的一组 prompt 启动一个干净 sub-agent
- 只给 sub-agent: skill 路径或 skill 内容、用户 prompt、可选的相邻 skill 列表
- 不给 sub-agent: `type`、`expected_behavior`、`notes`、通过标准、主流程的判断
- 要求 sub-agent 输出: `would_trigger`、`reason`、`if_triggered_action`
- 主流程再把 sub-agent 输出和 `test-prompts.json` 的预期逐条对比,统计通过率

如果当前环境没有 sub-agent 能力,才退回到主流程自测,并在 `test-results.md` 里标明这是 fallback 结果,可信度低于独立 sub-agent 盲测。

## test-prompts.json 格式 (darwin-skill 兼容)

```json
{
  "skill": "inversion-thinking",
  "version": "0.1.0",
  "test_cases": [
    {
      "id": "should-trigger-01",
      "type": "should_trigger",
      "prompt": "我要决定要不要接这个新项目,列了一堆好处但还是没底",
      "expected_behavior": "调用 inversion-thinking, 反问'最不希望发生什么'",
      "notes": "正面场景: 决策纠结"
    },
    {
      "id": "should-not-trigger-01",
      "type": "should_not_trigger",
      "prompt": "帮我查一下这个 API 的参数",
      "expected_behavior": "纯信息查询, 不应调用任何决策 skill",
      "notes": "诱饵: 非决策场景"
    },
    {
      "id": "edge-01",
      "type": "edge_case",
      "prompt": "我在想晚饭吃什么",
      "expected_behavior": "日常琐事, 不应调用 (虽然字面是'决策')",
      "notes": "边界: 区分严肃决策和日常选择"
    }
  ]
}
```

## 三类测试缺一不可

| 类型 | 数量 | 目的 |
|---|---|---|
| `should_trigger` | 3–5 条 | 该调用时是否调用 |
| `should_not_trigger` (诱饵) | 2–3 条 | 不该调用时是否忍住 |
| `edge_case` | 1–3 条 | 边界模糊场景的判断是否合理 |

**没有诱饵测试的 skill 一律打回**。因为只测 positive case,skill 总会看起来"很好",但实际部署后会乱激活。

**跨 skill 混淆测试 (硬性要求)**: 诱饵中至少 1 条必须是"应该触发同书另一个 skill"的 prompt。同一本书拆出的 10+ 个 skill 之间互相抢调用,是部署后最常见的真实故障 — 只测"完全无关的场景"发现不了它。盲测时把整包所有 skill 的 name + description 列表给 sub-agent,让它做"该激活哪一个"的选择题,而不只是"要不要激活这一个"的判断题。

## 执行流程

1. 对每个 skill,按模板写 `test-prompts.json`
2. 对每个 test_case 做独立盲测: 隐藏 `type` / `expected_behavior` / `notes`,让 sub-agent 判断"是否会调用这个 skill",记录判断和理由
3. 主流程对照 `test-prompts.json` 判卷:
   - `should_trigger`: sub-agent 应明确调用该 skill,且执行动作符合 `expected_behavior`
   - `should_not_trigger`: sub-agent 不应调用该 skill,诱饵测试容错为 0
   - `edge_case`: sub-agent 的判断要符合 `expected_behavior` 中定义的边界理由
4. 按测试前固定的验收标准分别汇总各类结果，重要负例、关键计算和必需交付物不得以平均分掩盖失败；缺失样本不得从分母排除。
5. 在训练集修复；已看过的失败用例加入回归集。最终验收使用未参与调优的保留用例，并记录宿主/模型版本与实际运行条件。修改预期答案须独立理由和审计记录，不能为了通过而改答案。

## 实际输出评测（promoted 和 router 都适用）

1. 从原书关键任务清单选代表任务；每个 active 能力至少覆盖一个正常完成与一个边界/缺输入场景。没有代表任务的能力返回阶段 1.5 检查价值。
2. 预先固定输入、参考依据和输出检查项。用例写 `output_cases`，实际运行者只看任务与输入，不看断言、预期答案或版本映射；`prepare` 只生成任务包，**不会自动调用模型或完成盲测**。
3. 固定同一宿主、模型、工具、输入和预算，分别运行 `old_skill / new_skill / without_skill`（首次没有旧版可只比后两者）。执行者只安装指定版本；匿名标签本身不等于环境隔离，需要独立工作目录和干净上下文。
4. 每个变体完成实际任务，保存最终回答和文件；计算核对数值/单位，流程核对步骤/分支/交付物。先机械断言，再盲评语义；无法机械判定的项目保留人工核查，不能只问模型“会不会做”。
5. 同时报告计划数、完成数、全部断言通过数、失败原因、耗时及 Token（可得时）。不完整、静态自评与实际宿主结果分开标记；没有数据不宣称非劣或提升。

用法：

```sh
python3 scripts/run_output_evals.py prepare suite.json --out /tmp/cangjie-eval-run
# 每个任务在 <case_id>/<label>/ 中执行，回答写 output.md，交付物留在同目录。
python3 scripts/run_output_evals.py score suite.json --outputs /tmp/cangjie-eval-run --mapping /tmp/cangjie-eval-run/mapping.json --out report.md
```

- `json_path` 只检查字段存在；数值正确性用 `json_number`（`expected`、可选 `abs_tol/rel_tol`），单位/状态用 `json_equals`。JSON 回答应为完整 JSON 或单个 fenced JSON 块。
- `file_exists` 只检查各变体自己的目录，不认 case 级共享文件。兼容旧 `<case_id>/<label>.md` 回答，但其他产物仍放 `<case_id>/<label>/`。
- 退出码：`0` 全部断言通过；`1` 完成但有失败；`2` 输入无效或输出缺失。`0` 只证明配置的机械断言通过，不替代来源核查或语义评估。
- 三关分流回归材料见 `benchmarks/toolbook/README.md`；它是合成基准，不是群友原书问题的已验证修复。

## 判断"修 skill 还是修测试"

- 如果失败的 case 暴露了 skill **trigger 描述有歧义**: 修 skill
- 如果失败的 case 是一个你**之前没想到的合理场景**: 可能需要修 skill 以覆盖或明确排除
- 如果失败的 case 是你**为了凑诱饵而设计过狠的场景**: 修测试 (但必须记录理由)

## 输出

- `<skill-dir>/test-prompts.json` — darwin 兼容格式
- `<skill-dir>/test-results.md` — 本次测试的通过率和失败分析 (审计用)

## 下一步

所有 skill 全部通过后,进入阶段 5 (交付),见 `07-stage5-deliver.md`: 生成面向读者的 DIGEST.md 精华长文,并把 skill 安装到用户的 skills 目录 — 之后才向用户提 darwin-skill 自动进化。

# 阶段 2 — RIA++ 构造能力卡

## 目标

把阶段 1.5 通过的每个方法论单元,构造成一张 RIA 能力卡,并在 Capability Bundle 中登记。

**v2.1 产出位置（ADR-002）**:
- 能力卡正文（R/I/A1/A2/E/B 六段,**不带 frontmatter**）→ `books/<slug>/.cangjie/capabilities/cards/<slug>.md`
- 能力元数据（稳定 `capability_id`、intents、keywords、one_liner、importance + 依据、`frontmatter.description`）→ `verified.yaml` 中该能力的条目（schema: `schemas/capability-bundle.schema.json`）

最终的 SKILL.md 由 `scripts/cangjie.py compile` 从 Bundle 确定性编译,阶段 2 不再直接写最终 Skill 目录。
旧流程（直接按 `templates/SKILL.md.template` 写独立 Skill 目录）仍受支持,产物按 legacy-pack 处理,
迁移方法见 `docs/migrations/v2.0-to-v2.1.md`。

内容结构参考模板: `templates/SKILL.md.template`（六段定义不变）

## RIA++ 六段

### R — Reading (原文)

- 直接引用 ≤150 字 (英文原文 ≤100 词)
- 必须标注出处 (章节 / 页码 / 段落标识; 视频填时间戳或分 P, 播客填集数)
- 若原书是英文,引用英文原文 + 你自己翻译的中文,**不要用现成译本** (避免译者版权 + 译本可能失真)

### I — Interpretation (自述)

- 用**你自己的话**重写方法论的核心骨架
- 5–15 行
- 检查: 读完这段,一个没读过原书的人能否理解这个方法论在做什么? 若不能,重写。
- 禁止: 照搬原文句子 / 堆砌修辞

### A1 — Application Example（书中案例或明确标记的演练）

- 优先采用原书亲历/转述案例或例题，标注类型与来源；原书未交代实际结果时写“未说明”。
- 原书没有示例时，可设计一条**明确标记的合成演练**验证已知规则；先写“原书未提供案例”，不能冒充作者经历、现实结果或独立证据。
- 示例交代输入/问题 → 方法怎么执行 → 结论/预期输出。合成演练须能按原书规则复算，不能借演练补造关键条件；规则本身不完整则回阶段 1.5 待核查。

这一段的作用是让 skill 在被调用时,agent 有具体的类比素材可用。

### A2 — Future Trigger ★ (最关键)

**这决定了 skill 是否真的会被用起来。**

必须明确:
1. **用户会在什么情境下遇到这类问题?** (场景描述, 3–5 条)
2. **这些情境的语言信号是什么?** (用户会说什么样的话)
3. **和哪些相邻 skill 不同?** (避免和其他 skill 互相抢调用)

A2 的产出直接写入 skill frontmatter 的 `description` 字段 — Claude 据此决定是否激活 skill。

注意:
- "与相邻 skill 的区分"在本阶段只写**初稿** (依据 verified.md 的单元列表推测),阶段 3 建立链接关系后回填定稿 — 不要在本阶段硬编相邻关系。
- 语言信号建议**中英双写**关键 trigger 词 (用户可能用英文提问,纯中文 description 会降低触发准确率)。

**好的 A2 示例** (来自"逆向思维" skill):
> 用户在纠结一个决策、列举正面理由却理不出头绪时;或在问"怎么做 X 才能成功"时;不适用于纯信息查询类问题。

**坏的 A2 示例**:
> 用户需要思考时。 ← 太宽泛,会误激活

### E — Execution (可执行步骤)

- 把方法论转成 1-2-3 步骤
- 每一步有**可判断的完成标准**
- 如果有判停点 (step 2 之后若 X 则跳到 step 5),显式写出
- 说明**输入契约**：必需字段、类型、单位、适用条件；缺失哪些信息应先询问，不能静默猜值。
- 说明**输出契约**：表格字段/文件格式/结论结构和完成标准。计算类写公式、计算顺序、舍入及容差；原书未规定的实现约定明确标为约定，并验证不改变原意。
- 流程/排障类保留条件分支、角色或状态、依赖步骤、失败处理；不能为卡片短小截掉必要前置步骤。

E 的作用是让 agent 在调用这个 skill 时有明确的执行路径,不是"自由发挥"。

### B — Boundary (边界)

- 什么时候**不要**使用这个 skill (反场景)
- 作者在书里警告过的失败模式
- 来自阶段 0 批判阶段的作者盲点
- 与之相邻但容易混淆的其他方法论

B 的作用是**防止乱调用**。没有 B 的 skill,会在不该用的时候被用,反而帮倒忙。

## 能力元数据设计（登记进 verified.yaml,不写在卡片里）

```yaml
capability_id: cap.<book>.<slug>      # 稳定 ID: 文案润色只加 revision,语义拆分/合并才换 ID
revision: 1
status: active
slug: <skill-slug>                    # kebab-case, 唯一
title: <中文标题>
importance: critical|high|medium|low  # 结合原书关键任务与遗漏后果，不用出现频次代替重要性
importance_rationale: <任务映射及实际使用价值>
one_liner: <一句话决策规则>            # 进入 cheatsheet
intents: [<用户意图>...]               # 进入路由表
keywords: [<中英关键词>...]
also_read: []                         # 阶段 3 填充
card: cards/<slug>.md
frontmatter:
  description: |                      # A2 的浓缩版, ≤300 字;晋级 Skill 编译时用作 description
    <何时用 + 何时不用 + 关键 trigger>
  tags: [decision, mental-model]
source_evidence:
  - source_id: src-main-book
    location: 第三讲                   # 视频填时间戳/分 P
resources: []                         # 可选，例 resources/input.csv、resources/calculate.py
```

来源信息由 `source_evidence` 承载，并在卡片 R 段写明。编译器只写其实现支持的 `metadata.cangjie.*` 字段，不把未输出的来源定位宣称为已写入 frontmatter。

## 配套资源（需要时才添加）

- 把需随包交付的脚本、CSV/JSON/Markdown 模板放到 Bundle 的 `resources/`，在能力的 `resources` 列表逐个声明；不声明的文件不会被打包。
- 当前支持 UTF-8 文本，路径用英文/数字/连字符/下划线，可分目录；不支持二进制文件、符号链接或越界路径。
- single/router 携带全部 active 能力声明的资源；晋级 Skill 携带自身声明资源，编译器追加可点击的相对路径资源清单。
- 卡片正文用资源名称说明用途，避免手写因 single/pack 目录深度不同而失效的相对链接；以编译器生成清单定位文件。
- 可重复计算适合确定性脚本；字段交付适合 CSV/JSON 模板。脚本需说明输入/输出、依赖、错误处理和测试；没有明确收益不强制生成。
- 编译只复制，不执行资源。原书、网页和附件里的代码先视为不可信材料，不能因蒸馏而自动执行。

## 常见失败模式

1. **I 段写成书摘** — 如果读起来像"本章作者说了 X",你在抄书不是在解释。重写。
2. **A2 太宽** — "需要决策时" 这种 trigger 永远不会被精准调用。必须给出**可识别的语言信号**。
3. **E 段只有哲学没有动作** — "保持客观" 不是 step,"列出 3 个最不希望发生的结果" 才是。
4. **缺 B 段** — 没边界的 skill 会被过度调用,最终用户失望。
5. **把演练冒充书中案例** — A1 用于展示方法怎么用；没有作者亲历材料就如实标注，不能靠虚构结果制造权威。

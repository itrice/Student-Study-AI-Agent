# UI 字号与缩放可读性自测记录

> 日期：2026-11-10
> 检查范围：今日学习、开始复习、我的错题、修改弹窗、知识点地图
> 检查清单：[UI 自测与验收清单](../UI_ACCEPTANCE_CHECKLIST.md)

## 1. 调整内容

建立统一的字号基线：

- `--text-body: 16px`：正文、题目、提示、解析、知识片段和表单输入。
- `--text-label: 14px`：按钮、标签、字段名、主要辅助说明和操作文字。
- `--text-meta: 12px`：徽章、时间、状态、来源、引用和次要元信息。

逐组件调整的选择器包括：

- 全局与导航：`body`、`.brand small`、`.nav-badge`、`.sidebar-tip p`、`.eyebrow`。
- 首页：`.hero-copy > p`、`.stat-card small`、`.stat-card em`、`.section-kicker`、`.small-pill`、`.tag`、`.priority-question p`、`.priority-footer span`、`.weakness-item strong`、`.recent-item p`、`.recent-item small`、`.recent-empty`。
- 复习页：`.review-edit-button`、`.knowledge-badge`、`.status-badge`、`.attempt-label`、`.question-label`、`.review-instruction`、`.hint-panel p`、`.hint-panel ol`、`.follow-up-box > label`、`.follow-up-row textarea`、`.follow-up-answer`、`.answer-form-label`、`.review-part label`、`.review-part small`、`.review-part input`、`.parts-editor-heading span/small`、`.part-editor-heading strong`。
- 结果与错题：`.result-heading strong/small`、`.result-copy`、`.result-answer`、`.result-step-feedback p`、`.result-part-heading strong/span`、`.result-part p`、`.empty-state p`、`.filter-chip`、`.data-hint`、`.mistake-question`、`.mistake-detail`、`.small-action`、`.list-empty`。
- 知识点地图：`.knowledge-hero-stat small/span`、`.knowledge-card h3`、`.knowledge-score small`、`.knowledge-meta`、`.knowledge-card-note`、`.knowledge-library-head p`、`.knowledge-search input`、`.knowledge-search-note`、`.coverage-badge`、`.review-badge`、`.knowledge-score-chip`、`.knowledge-search-item h3/p`、`.knowledge-search-chunk p`、`.knowledge-library-title strong/span`、`.knowledge-summary-text`、`.knowledge-meta-label`、`.knowledge-chunk-kind`、`.knowledge-citation`、`.knowledge-source strong/span/p`。
- 弹窗与提示：`.field > span`、`.field > span small`、`.field input/select/textarea`、`.diagnosis-preview p`、`.diagnosis-fact`、`.diagnosis-list li`、`.dialog-footer p`、`.toast`。

布局兜底同步调整：

- 侧栏增加纵向滚动，避免 150% 缩放或低高度窗口下底部内容不可达。
- 复习元信息、错题操作、知识点元信息、检索标题和分问编辑标题允许换行。
- 统计卡在 `1100px` 以下改为两列，避免 150% 缩放时标签换行挤压。
- 错题题目由单行省略改为两行截断，放大后仍能读到足够题干。

## 2. 自动化验证

执行：

```powershell
node --check public/app.js
node --test
```

结果：

- `node --check public/app.js`：通过。
- `node --test`：74/74 通过。
- `test/ui-readability.test.js`：覆盖“全站阅读文本不小于 12px”“正文和辅助文字基线”“按钮与输入框不小于 14px”“关键容器具备换行或滚动兜底”。
- CSS 独立扫描：不存在小于 `12px` 的字号声明。

## 3. 浏览器缩放检查

使用 Edge headless 和 Chrome DevTools Protocol 在实际页面上检查。125% 与 150% 按等效 CSS 视口 `1152px`、`960px` 验证；另测 `375px` 窄屏。

| 页面 | 视口 | 最小实际字号 | 页面横向溢出 | 结果 |
|---|---:|---:|---|---|
| 今日学习 | 1440 × 1200 | 12px | 无 | 通过 |
| 今日学习 | 1152 × 900（125%） | 12px | 无 | 通过 |
| 今日学习 | 960 × 900（150%） | 12px | 无 | 通过 |
| 今日学习 | 375 × 812 | 12px | 无 | 通过 |
| 我的错题 | 1152 × 900 | 12px | 无 | 通过 |
| 修改弹窗 | 1152 × 900 | 12px | 无 | 通过 |
| 修改弹窗 | 960 × 900（150%） | 12px | 无 | 通过 |
| 修改弹窗 | 375 × 812 | 12px | 无 | 通过 |
| 知识点地图 | 1152 × 900 | 12px | 无 | 通过 |
| 知识点地图 | 375 × 812 | 12px | 无 | 通过 |
| 开始复习 | 1152 × 900 | 12px | 无 | 通过 |
| 开始复习 | 375 × 812 | 12px | 无 | 通过 |

人工截图复核确认：统计卡、题目、按钮、标签、知识卡片和弹窗底部操作区在以上尺寸下没有重叠、裁切或操作文字不可见；150% 等效宽度下统计卡为两列，窄屏修改弹窗保持单列且底部按钮固定可见。

## 4. 结论

本次字号与可读性调整通过自动化测试和浏览器缩放检查。后续 UI 验收按 [UI 自测与验收清单](../UI_ACCEPTANCE_CHECKLIST.md) 执行，字号、可读性和缩放后布局作为必检项。

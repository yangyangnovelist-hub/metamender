# MetaMender demo video script

Target runtime: **2:35–2:50**. The Devpost limit is three minutes. Record at
1920×1080, keep the terminal font large, and use English captions. The Chinese
column is operator guidance and does not appear in the video.

Before recording, open DataHub on the `ADDRESSES` dataset and confirm that
`town_city` has no PII term. Use only the local showcase catalog; every `yes`
below performs a real metadata write.

| Time | English on-screen caption / action | 操作提示（不出现在成片） |
| --- | --- | --- |
| 0:00–0:12 | **Your metadata catalog is already drifting.** Missing owners hide accountability. Blank descriptions slow discovery. Unclassified PII raises risk. | DataHub 中快速切换 `ADDRESSES`、`warehouses`、`orders`。 |
| 0:12–0:25 | **MetaMender turns metadata debt into a safe, prioritized work queue.** | 展示 README 标题后切到终端。 |
| 0:25–0:43 | `npm run scan -- --dry-run --urn-contains snowflake,b2fd91.order_entry_db.order_entry.addresses` — **The scan is read-only and uses DataHub MCP.** | 运行面向演示数据集的只读扫描；停在按严重度排序的结果。 |
| 0:43–1:02 | **This is evidence, not a guess:** `ADDRESSES.town_city` matches a disclosed PII heuristic, has active downstreams, and has no PII glossary term. | 放大 severity 100 的 `town_city` finding。 |
| 1:02–1:18 | **A model cannot invent a write target. It can act only on the latest scan.** | 运行下方精确 target 命令。 |
| 1:18–1:37 | **One exact change. One fresh human decision.** | 终端显示完整 URN、column、proposed fix 后，现场输入 `yes`。不要提前管道输入。 |
| 1:37–1:53 | **Written through the official DataHub MCP server — then independently re-read. VERIFIED.** | 保留 MCP ack 与 verification 行。 |
| 1:53–2:11 | **The catalog changed, not just the chat.** | 回到 DataHub 刷新 `town_city`，展示新 PII term。 |
| 2:11–2:27 | **Every run leaves human-readable and machine-readable evidence.** | 打开最新 `examples/audit-*.md`，再快速展示 JSON。 |
| 2:27–2:40 | **Bonus: a reusable, read-only `/datahub-audit` skill prepared for the official DataHub Skills repository.** | 展示 `bounty/skill-pr/skills/datahub-audit/SKILL.md` 的标题、Boundaries、Audit Dimensions。 |
| 2:40–2:48 | **MetaMender — find the gaps, approve the repair, prove the result.** | 结束卡：名称、track、仓库 URL。 |

## Exact demo command

```bash
npm run agent -- \
  --target 'pii-untagged/town_city@snowflake,b2fd91.order_entry_db.order_entry.addresses'
```

If `ANTHROPIC_API_KEY` is present, the opening line should say Claude Agent SDK is
driving the session. Without it, record the deterministic mode; the DataHub work,
safety gate, MCP mutation, verification, and audit evidence are identical.

## Recording checklist

- Keep the video below 3:00 and verify the uploaded playback duration.
- Hide tokens, `.env`, browser profiles, notifications, and unrelated tabs.
- Do not type `yes` until the complete target and proposed change are visible.
- Show the DataHub field before and after the write.
- Show the `VERIFIED` re-read, not only the mutation acknowledgement.
- Add the final public repository URL and unlisted video URL to the submission form.

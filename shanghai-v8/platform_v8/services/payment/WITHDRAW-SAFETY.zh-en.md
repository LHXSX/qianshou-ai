# 提现记账安全补丁 / Withdrawal bookkeeping safety patch

本增量基于已冻结的 16 文件 CNY 收单候选，单独修复独立审查实际复现的既有提现问题。没有部署，没有发起真实提现或打款。

改前：真实 PostgreSQL 中 100 元余额的两张 approved 各 100 元提现单可并发都标 paid；账本合计 -100、缓存 0。create_request 使用 `:ip::inet` 时 SQLAlchemy 未正确识别绑定，真实 PG 报 SyntaxError。独立原始证据在 `work/payments/independent-review-evidence/withdraw-race.{py,log}`。

改后：使用 `CAST(:ip AS inet)`；mark_paid 先锁申请行，再锁账户行，在同一事务中检查/扣账/刷新缓存/更新 paid。顺序与充值 mark_paid 的账户锁协议一致。同一提现单、相同打款流水重试返回原账本，不重复扣款；不同流水拒绝。已有幂等账本必须核账号/金额/币种/type，并关联已持久化 ID。余额不足转换 WithdrawError，事务明确 rollback；状态更新失败也回滚 DEBIT 和 cache。去掉不存在 withdraw 时改走负数 deposit 的无效 fallback，运行时已有真实 withdraw 实现。

8 项新增 PG 测试通过：真实 INET 绑定、两单余额竞争、与充值共享账户锁、同流水重试/不同流水拒绝、更新失败回滚、已有正确/错误账本、空流水拒绝。与 CNY 原 89 项合并共 97 tests 通过。分别移除账户锁和还原错误 INET 绑定的两项变异测试都失败，源码 SHA 已恢复。没有修改冻结 base candidate。

边界：本锁只协调采用相同账户行锁的充值/提现记账路径；不是所有其他 ledger writer 的全面并发证明。既有流程在实际外部打款之后才回填 mark_paid，没有付款前资金冻结/预留，所以仍无法保证外部出款当时一定足额。这属于未解决的产品资金流程。管理台实际 mark_paid 写入口应继续门禁，不能因本补丁绿灯而宣称自动提现可用。没有变更提现费率、最低/最高金额、审批规则、退款、SP 或清算政策。

English: This narrow patch repairs two independently reproduced legacy defects: the PostgreSQL INET bind and concurrent bookkeeping of different withdrawals. An account row lock now coordinates the debit with the recharge writer, same-reference retries are idempotent, conflicting references fail, persisted ledger IDs are verified, and failures roll back. Eight new real-PostgreSQL tests plus the 89 recharge tests pass; both lock/bind mutations are detected and restored. It does not reserve funds before an external payout, authorize transfers, or establish an automated withdrawal product. Keep the external-payout confirmation UI gated until the separate reservation/payout workflow is approved and verified.

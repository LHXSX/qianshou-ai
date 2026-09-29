"""New order/outbox records share the Shanghai ledger transaction and account owner."""
from sqlalchemy import Table, Column, String, Integer, BigInteger, Text, JSON, ForeignKey, UniqueConstraint, CheckConstraint
from platform_v8.storage.repo import metadata

quotes_t = Table("we_subscription_quotes", metadata,
    Column("quote_id", String(96), primary_key=True),
    Column("account_id", BigInteger, ForeignKey("we_accounts.id"), nullable=False),
    Column("payload", JSON, nullable=False),
    Column("ticket", Text, nullable=False),
    Column("expires_at", BigInteger, nullable=False),
    Column("created_at", BigInteger, nullable=False))
orders_t = Table("we_subscription_orders", metadata,
    Column("order_id", String(96), primary_key=True),
    Column("account_id", BigInteger, ForeignKey("we_accounts.id"), nullable=False),
    Column("quote_id", String(96), ForeignKey("we_subscription_quotes.quote_id"), nullable=False, unique=True),
    Column("idempotency_key", String(96), nullable=False),
    Column("request_hash", String(64), nullable=False),
    Column("amount_fen", BigInteger, nullable=False),
    Column("currency", String(3), nullable=False),
    Column("tier", String(16), nullable=False),
    Column("months", Integer, nullable=False),
    Column("ledger_id", String(36), ForeignKey("we_ledger.id"), nullable=False),
    Column("paid_at", BigInteger, nullable=False),
    Column("status", String(24), nullable=False),
    Column("attempts", Integer, nullable=False, default=0),
    Column("last_error", String(64), nullable=True),
    Column("subscription", JSON, nullable=True),
    Column("updated_at", BigInteger, nullable=False),
    UniqueConstraint("account_id", "idempotency_key", name="we_subscription_orders_account_key_uniq"),
    CheckConstraint("amount_fen > 0 AND currency = 'CNY' AND months BETWEEN 1 AND 12", name="we_subscription_orders_value_chk"),
    CheckConstraint("status IN ('fulfilling','fulfilled','requires-review')", name="we_subscription_orders_status_chk"))

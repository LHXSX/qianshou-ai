"""Standalone payment expiry command; dry-run unless --apply is explicit.

Uses the existing storage.db configuration and never changes schema.
Deployment/activation of the accompanying timer is a separate operation.
"""
from __future__ import annotations

import argparse
import json

from sqlalchemy import text

from platform_v8.storage import db
from .orders import expire_pending_orders


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Mark timed-out pending orders expired")
    args = parser.parse_args(argv)
    engine = db.init_db()
    try:
        with db.session_scope() as session:
            if args.apply:
                count = expire_pending_orders(session)
            else:
                count = session.execute(text("""
                    SELECT COUNT(*) FROM we_payment_orders
                     WHERE status = 'pending' AND expired_at < NOW()
                """)).scalar_one()
            print(json.dumps({"mode": "apply" if args.apply else "dry_run", "expired_orders": count}))
        return 0
    finally:
        engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())

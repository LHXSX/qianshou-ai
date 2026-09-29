"""应用市场 API · /api/v8/marketplace/* + /api/v8/admin/marketplace/*"""
from platform_v8.api.v8.marketplace.routes import admin_router, router

__all__ = ["router", "admin_router"]

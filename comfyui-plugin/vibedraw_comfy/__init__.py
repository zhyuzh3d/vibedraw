"""VibeDraw ComfyUI plugin.

Drop this folder into ``ComfyUI/custom_nodes/`` and restart ComfyUI.  Then:

1. Open the **VibeDraw 配置 (Config)** node, set the password you want your
   drawing app to send, pick the checkpoint each capability uses, fill in the
   three files the ``render`` capability needs, and Queue once.  Leaving the
   password empty turns authentication off.
2. Point the client at this machine's address; it discovers the rest through
   ``GET /cvp/info``.

The plugin ships its own graphs for all four capabilities — quick draw, local
redraw, upscale and a high-quality render — so no API workflow export is ever
needed.  The contract is described in ``plans/cvp-spec.md``.
"""

from __future__ import annotations

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import server as server_module

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

ROUTES_REGISTERED = server_module.register_routes()

if not ROUTES_REGISTERED:
    print("[VibeDraw] HTTP 路由未注册：ComfyUI 服务实例还不可用，vibedraw 客户端将无法连接。")

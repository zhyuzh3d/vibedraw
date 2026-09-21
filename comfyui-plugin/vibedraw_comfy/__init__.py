"""VibeDraw integration for ComfyUI.

The package deliberately keeps the transport contract separate from the
workflow graph.  A VibeDrawInput node is patched by the HTTP adapter before
the graph is queued; VibeDrawOutput is a normal ComfyUI image output node.
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import server as _server  # noqa: F401 - registers HTTP routes on import

WEB_DIRECTORY = None

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

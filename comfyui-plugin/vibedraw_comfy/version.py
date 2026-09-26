"""The plugin's version, in one place.

``tools/package-plugin.py`` reads this file's number to name the release zip,
and ``server.py`` reports it over HTTP, so a client can tell which build it is
talking to without guessing from the file mtimes.

It lives in its own module rather than in ``__init__.py`` because that one
imports the HTTP layer: anything importing the package would drag
``folder_paths`` and ``aiohttp`` in with it, which is exactly what the offline
tests cannot provide.
"""

from __future__ import annotations

__version__ = "2.2.0"

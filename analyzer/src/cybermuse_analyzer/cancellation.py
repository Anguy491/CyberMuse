from __future__ import annotations


class AnalysisCancelled(Exception):
    """Raised between bounded analyzer operations after a cancellation request."""

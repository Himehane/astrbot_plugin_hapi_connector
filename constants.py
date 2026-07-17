"""HAPI 常量定义。

能力/权限/模型等 flavor 相关定义已迁至 flavor_profiles.py。
本文件保留旧名导出，避免外部与历史 import 断裂。
"""

from .flavor_profiles import (  # noqa: F401
    AGENTS,
    CLAUDE_EFFORT_OPTIONS,
    CLAUDE_EFFORT_VALUES,
    CLAUDE_MODEL_MODES,
    CODEX_REASONING_EFFORT_OPTIONS,
    CODEX_REASONING_EFFORT_VALUES,
    GEMINI_MODEL_MODES,
    MODEL_MODES,
    PERMISSION_MODES,
    all_known_agents,
    creatable_agents,
    profile_for,
)

# Session 类型（simple / worktree）与 agent flavor 无关
SESSION_TYPES = ["simple", "worktree"]

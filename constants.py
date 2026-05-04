"""HAPI 常量定义"""

# 各 flavor 对应的权限模式
PERMISSION_MODES = {
    "claude": ["default", "acceptEdits", "bypassPermissions", "plan"],
    "codex": ["default", "read-only", "safe-yolo", "yolo"],
    "gemini": ["default", "read-only", "safe-yolo", "yolo"],
    "opencode": ["default", "yolo"],
}

# Claude 可用的模型模式
MODEL_MODES = ["default", "sonnet", "sonnet[1m]", "opus", "opus[1m]"]

# Gemini 可用的模型模式
GEMINI_MODEL_MODES = [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
]

# Claude 可用的推理强度；None 表示 auto
CLAUDE_EFFORT_OPTIONS = [
    (None, "auto（默认）"),
    ("medium", "medium"),
    ("high", "high"),
    ("max", "max"),
]
CLAUDE_EFFORT_VALUES = [v for v, _ in CLAUDE_EFFORT_OPTIONS if v]

# Codex 可用的思考深度；None 表示继承 Codex 默认设置
CODEX_REASONING_EFFORT_OPTIONS = [
    (None, "继承 Codex 默认设置（推荐）"),
    ("none", "none"),
    ("minimal", "minimal"),
    ("low", "low"),
    ("medium", "medium"),
    ("high", "high"),
    ("xhigh", "xhigh"),
]
CODEX_REASONING_EFFORT_VALUES = [value for value, _ in CODEX_REASONING_EFFORT_OPTIONS if value]

# 支持的 Agent 类型
AGENTS = ["claude", "codex", "gemini", "opencode"]

# Session 类型
SESSION_TYPES = ["simple", "worktree"]

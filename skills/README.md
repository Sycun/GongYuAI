# GongYuAI Skill 目录

每个子目录一份独立 Skill（含 `SKILL.md`），彼此解耦。

```
skills/
  builtin/<id>/SKILL.md   # 预设（含 GongYuAI 短包 + 从 Kali CyberStrikeAI/skills 复制的 CSAI 包）
  user/<id>/SKILL.md      # 你自备的 Skill；平台自动发现
```

也可放在 `.gongyuai/skills/user/<id>/`。控制台：**设置 → 工具增强 → Skill**。

CSAI 导入包默认关闭（`skill.json` → `defaultEnabled: false`），在 UI 里按需打开，避免一次注入过多正文。

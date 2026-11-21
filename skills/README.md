# GongYuAI Skill 目录

每个子目录一份独立 Skill（含 `SKILL.md`）。

```
skills/
  builtin/<id>/   # 预设（GongYuAI 短包 + CSAI 复制包）
  user/<id>/      # 自备包
  routing.json    # 触发词路由表（进 system prompt 的是目录行，不是全文）
```

## Token 策略

- **路由表常驻**：id / 名称 / 短描述 / 触发词
- **正文按需**：Worker 工具 `load_skill(id)` 才读 `SKILL.md`
- UI「参与路由」：关掉 = 不出现在路由表（极少用）

控制台：**设置 → 工具增强 → Skill**

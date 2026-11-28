---
name: ai-infra-service-audit
description: >-
  企业 AI 推理/编排服务（vLLM/Dify/Ray/MLflow/Gradio/Jupyter/Triton/ComfyUI/Chroma/Qdrant）的未授权 API、密钥泄露面、代码沙箱边界与 SSRF 元数据核查。Use when an AI inference or orchestration service is fingerprinted.
metadata:
  tags: [渗透测试, penetration-testing, 红队, AI-Infra]
---

## 企业 AI 基础设施审计（未授权 API → 密钥泄露面 → 沙箱/SSRF 边界）

```
🔴纪律：AI 服务的「模型接口」通常天然免鉴权，先用最小只读请求确认边界，再验证数据/密钥/沙箱影响；
🔴严禁在目标上执行训练/推理压测或删除模型；所有写操作仅用委托给定测试空间，且先 change_record 登记回滚。

1.指纹与服务识别（只读）：
  vLLM：/v1/models、/v1/chat/completions、/metrics、8000 端口；启动日志特征；
  Dify：/console/api/、/api/v1/、/signin、/apps；前端 Dify 字样；
  Ray：/api/version、8265 Dashboard、/api/cluster_status、/api/jobs/；
  MLflow：/api/2.0/mlflow/experiments/list、/api/2.0/mlflow-artifacts/、5000 端口；
  Gradio：/config、/queue/join、/info；页面 gradio 关键字；
  Jupyter：/api/contents、/tree、/lab、token 参数；8888 端口；
  Triton：/v2/health/ready、/v2/models/、/v2/models/{name}/config；8000/8001/8002；
  ComfyUI：/object_info、/history、/queue、8188 端口；
  Chroma：/api/v1/heartbeat、/api/v1/collections；Qdrant：/collections、/dashboard、6333 端口。

2.未授权 API 端点核查（默认鉴权配置清单）：
  a)模型/权重列举：vLLM /v1/models、Triton /v2/models、ComfyUI /object_info 是否免鉴权可读；
  b)任务与历史：Ray /api/jobs/、/api/nodes；MLflow experiments/runs；ComfyUI /history 是否泄露提示词与输出路径；
  c)内容存储：Jupyter /api/contents 目录树、MLflow artifacts 下载、Chroma/Qdrant collection 列举与向量读取；
  d)管理面：Ray Dashboard /api/*、Jupyter 终端（/api/terminals）、Gradio /queue/join 是否可绕过登录；
  每条只做一次 GET/HEAD 存在性确认并记录基线，403/401/302 均不计为未授权。

3.环境变量/对象存储密钥泄露面：
  优先查只读接口与错误页是否回显：模型服务启动配置、/metrics 标签、Jupyter /api/contents 下的 .env/配置文件、
  MLflow run 参数与 artifact 路径、Dify 应用变量（/api/v1/… 免鉴权应用变量）；
  命中密钥只记录「存在性与用途」（如 S3_ACCESS_KEY 可通过 artifact 列举验证），明文写入 credential_record 的 secretRef 指针，
  严禁把明文贴进 Fact/聊天；对象存储只做 list 验证，禁止批量下载业务数据。

4.工作流代码沙箱边界（Dify/ComfyUI/Gradio/Jupyter）：
  代码执行节点/自定义节点/Notebook 是否可通过授权测试账号注入一次无害命令（id/whoami 级）；
  精确定位沙箱：容器内 PID/挂载/网络（是否可达元数据 169.254.169.254、宿主 socket、其他租户 namespace）；
  结论只写「可执行/不可执行 + 边界证据」，不落地持久化、不横向到其他租户空间。

5.SSRF 与元数据访问核查：
  AI 平台常见「URL 抓取/知识库导入/webhook/模型下载」入口；
  用 OAST 回连（oast_issue）验证出网，再最小化探测 169.254.169.254/latest/meta-data/（只读一层）；
  云元数据命中即停止深挖，记录可读字段（角色名/区域），不提取长期凭据；
  内网地址探测仅限任务授权 targets 与 pivotPolicy 声明范围。

6.证据与交付：
  finding 证据包含：端点、请求、响应头/状态码、可读字段差异、沙箱/SSRF 回连记录；
  影响描述区分「模型/数据泄露」「代码执行」「凭据外泄」三档；
  修复建议：网关鉴权、网络策略（禁元数据）、沙箱隔离、密钥轮换与最小权限。

7.反模式：
  ✗ 对推理服务做压力/吞吐测试或触发大模型长生成；
  ✗ 批量下载向量库/训练数据作为证据；
  ✗ 在共享租户环境执行写操作或删除 collection；
  ✗ 把平台 API Key 明文写进报告正文而不做凭据登记。
```
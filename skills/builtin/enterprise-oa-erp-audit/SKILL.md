---
name: enterprise-oa-erp-audit
description: >-
  政企 OA/ERP（泛微/致远/用友/蓝凌/通达/金蝶）指纹识别、历史高危接口族与会话鉴权差分顺序。Use when a Chinese enterprise OA/ERP portal or middleware is fingerprinted and must be audited in order.
metadata:
  tags: [渗透测试, penetration-testing, 红队, OA, ERP]
---

## 政企 OA/ERP 审计（指纹 → 无害路由确认 → 基线对照最小化验证）

```
🔴执行纪律（顺序不可跳）：
①静态指纹与版本区间确认 → ②HEAD/GET 无害路由存在性确认 → ③基线对照最小化验证(http_request(compareWith=...))
🔴严禁未确认指纹与版本就盲打漏洞载荷；一次只验证一个接口族，拿到基线差异再升级验证。

1.指纹识别（先做，全部只读）：
  泛微 e-cology：/wui/index.html、/weaver/、/mobile/plugin/、/spa/；登录页 title「泛微协同管理平台」；JS 中 ecology/weaver 关键字；
  泛微 e-office：/eoffice/、/general/、login 页 EOffice 字样；
  致远 A8/Seeyon：/seeyon/、/seeyon/login/login.jsp、jtemplatesSkin 路径；
  用友 NC/YonYou：/nc/、/servlet/~ic/、/yonbip/；U8/U9 各自 /U8Login 等入口；
  蓝凌 EKP：/ekp/、/sys/portal/、kmss 路径；通达 OA：/general/、/ispirit/、/inc/；
  金蝶 Apusic/EAS：/eas/、/kdweibo/、/portal/ 及中间件版本头；
  记录：Server/X-Powered-By/Cookie 名称（ecology、JSESSIONID、EKP 等）→ 推断产品族与大版本区间；版本号只作线索，落 tentative Fact。

2.公开历史高危接口族梳理（只读验证存在性，不直接打）：
  a)未授权配置/环境读取：/weaver/weaver.file.*、/mobile/plugin/*、/api/ec/dev/* 等配置读取端点；
  b)任意文件读取/上传：downfile/fileid、fileupload、/spa/ 静态代理、附件下载参数可拼接路径；
  c)预置维护/调试接口：/monitor/、/status/、/console、init/install/setup 残留；
  d)反序列化端点：XML/二进制序列化入口（XStream/Jackson/CommonsCollections 组件族），先用无害类型探测响应特征；
  e)SQL 注入与远程命令执行历史接口：只按社区披露的确切路径做存在性 HEAD/GET，禁止自造路径。

3.会话鉴权差分顺序（核心方法论）：
  步骤1 基线：匿名 GET 目标业务页 → 记录状态码/长度/关键响应头（http_request(compareWith="anon") 建立基线）；
  步骤2 预置身份：若委托给出测试账号/工号，先 http_request(session="role_user") 登录，确认角色与菜单差异；
  步骤3 越权差分：同资源用 session="role_user" 与 session="anon" 各取一次，仅当响应体/字段出现「匿名不可见、登录可见」或跨角色可见时才升格 tentative finding；
  步骤4 未授权接口：去掉 Cookie 重放已确认有效的业务接口，比较基线差异；403/302 一律不当作未授权。

4.版本与 CVE 对照：
  指纹确认后 searchsploit {产品} {版本}、CVE 公开库、GitHub 公告核对影响区间；
  PoC 只在本地隔离环境先验证格式，目标侧只做最小化无危害探测（HEAD/GET、空参数、只读）。
  反射与回显不构成 exploited：按 gradeDarkMoon 口径，只有响应出现请求中没有的敏感数据才升格。

5.证据与交付：
  每个接口族验证结果写 evidence/（请求响应头+状态码+差异片段），finding_record 先 tentative；
  复现步骤必须包含产品版本、路径、session 角色、基线差异；
  修复建议按产品官方补丁/加固基线给出，不写「升级到最新」泛泛结论。

6.反模式（会浪费时间/触发告警）：
  ✗ 未确认指纹就对批量路径跑漏洞模板（nuclei 全量）；
  ✗ 把 302 登录跳转当成未授权访问；
  ✗ 用默认口令爆破代替委托已给的测试身份；
  ✗ 在业务高峰期对 OA 登录接口做高频喷洒。
```
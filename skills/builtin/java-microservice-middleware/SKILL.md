---
name: java-microservice-middleware
description: >-
  国产 Java 后台脚手架（若依/JeecgBoot）与 Spring 微服务中间件（Actuator/Gateway/Nacos/XXL-Job/Shiro/Fastjson/Druid）指纹、默认鉴权核查与接口前缀绕过。Use when a Java admin scaffold or Spring Cloud middleware surface is identified.
metadata:
  tags: [渗透测试, penetration-testing, 红队, Java, Spring]
---

## Java 后台脚手架与微服务中间件审计（指纹 → 默认配置 → 路由绕过 → 组件验证）

```
🔴纪律：先指纹确认产品与版本，再按「默认鉴权配置 → 路由/前缀绕过 → 组件 CVE 最小验证」顺序推进；
🔴每个动作先 HEAD/GET 无害确认存在性，再基线对照（http_request(compareWith=...)），禁止直接投递反序列化载荷。

1.指纹路径（只读）：
  若依 RuoYi：/prod-api/、/dev-api/、登录页 RuoYi 字样、/swagger-ui/、/v3/api-docs、/druid/；
  JeecgBoot：/jeecg-boot/、/jmreport/、/sys/login、/actuator/、jimureport 路径；
  Spring Boot Actuator：/actuator/、/actuator/env、/actuator/heapdump、/actuator/mappings、/actuator/health；
  Nacos：/nacos/、/nacos/v1/auth/users、/nacos/v1/cs/configs、8848 端口；
  Spring Cloud Gateway：网关响应头、/actuator/gateway/routes；
  XXL-Job：/xxl-job-admin/、/jobinfo、/joblog；Shiro：rememberMe Cookie；
  Fastjson：接口返回 $ref/类型字段异常；Druid：/druid/index.html、/druid/websession.json；
  记录版本：/actuator/info、静态资源版本号、报错页框架版本 → 只作线索，落 tentative Fact。

2.默认鉴权配置核查清单（先于任何漏洞验证）：
  a)Actuator 暴露面：env/heapdump/threaddump/mappings/configprops 是否需要认证；heapdump 只下载验证可读性（不解析私密值写进聊天）；
  b)Nacos 默认口令与鉴权开关：/nacos/v1/auth/users 是否允许未授权列举；namespace/config 列表是否可读；
  c)Druid 监控台：/druid/index.html 与 /druid/websession.json 是否免登录；
  d)Shiro rememberMe：响应是否带 rememberMe=deleteMe；密钥爆破仅在授权范围内、低频、单值验证；
  e)XXL-Job 默认 admin/123456 仅用委托给定身份验证，不盲爆。

3.接口前缀绕过系统化核验（网关与过滤器常见缺陷）：
  a)分号路径参数：/api/admin;/user/list、/admin/..;/api/actuator；
  b)编码与大小写：%2e%2e%2f、%252e、双写 //、/api//admin、/API/admin；
  c)网关转发头：X-Forwarded-For/X-Original-URL/X-Rewrite-URL/X-Forwarded-Prefix 指向受限路径；
  d)尾斜杠与后缀：/admin 与 /admin/、.json/.html 后缀混淆；
  方法：对同一受限资源记录基线（直连 403/302），逐项施加一种变形，只有出现「鉴权结果不一致且响应体可读」才升格 tentative。

4.JWT/Cookie 配置审计：
  收集登录响应 Set-Cookie 属性（HttpOnly/Secure/SameSite）与 JWT 结构（alg、kid、exp、iss）；
  alg=none/弱密钥/固定 kid 仅做一次最小验证（如篡改 payload 重放一次），禁止离线拖库式爆破；
  会话固定与登出失效用两个命名会话（role_user / anon）做差分确认。

5.组件版本 → 最小验证：
  Fastjson/Jackson/Shiro/Log4j 等反序列化链：先确认组件与版本区间（依赖清单、报错特征、静态资源指纹），
  PoC 优先在本地隔离环境验证格式，目标侧只投递无副作用探测（DNS/HTTP 回连 OAST），不执行落地命令；
  Actuator heapdump 下载后仅统计类名/凭据字段存在性，明文值遮断入证据。

6.证据与交付：
  每个绕过/未授权结论必须带：原始请求（含变形）、基线请求、两者状态码/长度/关键字段差异；
  finding_record 先 tentative → 复现 → finding_verify；误报 finding_retract；
  修复建议落到具体配置项（如 management.endpoints.web.exposure.include、网关路由断言、Shiro 密钥轮换）。

7.反模式：
  ✗ 对 /actuator/env 直接 POST 修改配置（越界且破坏目标）；
  ✗ 拿 heapdump 里的明文密码写入 Fact/聊天；
  ✗ 未确认网关鉴权模型就批量扫绕过字典并触发封禁；
  ✗ 用 Shiro 密钥爆破代替核对委托给定的会话与配置。
```
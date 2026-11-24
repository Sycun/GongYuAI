import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHostEnumeration } from "./host-enum.js";

test("Linux id/uname/os-release/sudo/caps/listeners are merged", () => {
  const text = `uid=0(root) gid=0(root) groups=0(root),27(sudo),100(users)
Linux web01 6.8.0-45-generic #45-Ubuntu SMP aarch64 GNU/Linux
PRETTY_NAME="Ubuntu 24.04.1 LTS"
User www-data may run the following commands on web01:
    (root) NOPASSWD: /usr/bin/systemctl restart nginx
    (ALL : ALL) ALL
/usr/bin/python3 = cap_setuid+ep
LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))
LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("java",pid=2,fd=3))`;
  const result = parseHostEnumeration(text);
  assert.equal(result.draft.hostname, "web01");
  assert.match(result.draft.os!, /Ubuntu 24\.04/);
  assert.deepEqual(result.draft.users, ["root"]);
  assert.ok(result.draft.privileges.includes("group:sudo"));
  assert.ok(result.draft.privileges.some((p) => p.startsWith("sudo:root:NOPASSWD")));
  assert.ok(result.draft.privileges.some((p) => p.includes("cap_setuid")));
  assert.ok(result.draft.services.includes("sshd/22"));
  assert.ok(result.draft.services.includes("java/8080"));
  assert.ok(result.matched.includes("linux-id"));
  assert.ok(result.matched.includes("linux-sudo"));
  assert.ok(result.matched.includes("linux-listeners"));
});

test("Windows systeminfo/whoami/net localgroup/net share/ipconfig are merged", () => {
  const text = `Host Name:                DC01
OS Name:                   Microsoft Windows Server 2022 Standard
OS Version:                10.0.20348 N/A Build 20348
System Boot Time:          2026-11-20, 08:00:00
Domain:                    corp.example.com

USER INFORMATION
----------------
User Name         SID
================= ==============================================
CORP\\alice        S-1-5-21-1-2-3-1001

GROUP INFORMATION
-----------------
Group Name                                  Type             SID
=========================================== ================ ==============================================
CORP\\Domain Admins                          Group            S-1-5-21-1-2-3-512
CORP\\Domain Users                            Group            S-1-5-21-1-2-3-513

PRIVILEGES INFORMATION
----------------------
SeDebugPrivilege                Debug programs            Enabled

Alias name     administrators
Comment        Administrators have complete and unrestricted access
Members
-------------------------------------------------------------------------------
Administrator
CORP\\alice

Share name   Resource                        Remark
-------------------------------------------------------------------------------
C$           C:\\                             Default share
ADMIN$       C:\\Windows                      Remote Admin

Windows IP Configuration
   Primary Dns Suffix  . . . . . . . : corp.example.com
Windows Defender Antivirus is enabled`;
  const result = parseHostEnumeration(text);
  assert.equal(result.draft.hostname, "DC01");
  assert.match(result.draft.os!, /Windows Server 2022/);
  assert.equal(result.draft.domain, "corp.example.com");
  assert.ok(result.draft.users.includes("alice"));
  assert.ok(result.draft.users.includes("Administrator"));
  assert.ok(result.draft.privileges.includes("admin:CORP\\Domain Admins"));
  assert.ok(result.draft.privileges.includes("winpriv:SeDebugPrivilege"));
  assert.ok(result.draft.shares.includes("C$"));
  assert.ok(result.draft.shares.includes("ADMIN$"));
  assert.ok(result.draft.av.includes("Windows Defender"));
  assert.ok(result.matched.includes("windows-systeminfo"));
  assert.ok(result.matched.includes("windows-whoami"));
});

test("unrecognized text is a skip, not a fabricated profile", () => {
  const result = parseHostEnumeration("hello world\nnothing useful");
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.draft.users, []);
  assert.equal(result.draft.os, undefined);
});

test("a bare single-line hostname is accepted, multi-line text is not", () => {
  const one = parseHostEnumeration("web01");
  assert.equal(one.draft.hostname, "web01");
  const multi = parseHostEnumeration("web01\nmore");
  assert.equal(multi.draft.hostname, undefined);
});

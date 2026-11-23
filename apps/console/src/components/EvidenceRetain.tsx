import { useState } from "react";
import { Button, Input, TextArea } from "@douyinfe/semi-ui";
import { api } from "../api";

export function EvidenceRetain({ taskId, onSaved }: { taskId: string; onSaved: () => void }) {
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  return (
    <form className="gy-retain" onSubmit={(event) => {
      event.preventDefault();
      if (!path.trim() || !content) return;
      setBusy(true);
      setMessage("正在请求");
      void api.saveEvidence(taskId, { path: path.trim(), content }).then((result) => {
        setMessage(`已留存 ${result.json.path}。这是普通材料留存，不会自动判定业务目标。`);
        setContent("");
        onSaved();
      }).catch((err: unknown) => {
        setMessage(err instanceof Error ? err.message : "留存失败");
      }).finally(() => setBusy(false));
    }}>
      <h3>普通材料留存</h3>
      <p>写入当前任务的证据目录。材料替换、撤回和 POST /goals/assert 未在本控制面注册，页面不会假装已经完成。</p>
      <Input aria-label="证据路径" placeholder="evidence/ 下相对路径" value={path} onChange={setPath} />
      <TextArea aria-label="证据正文" value={content} onChange={setContent} autosize={{ minRows: 3, maxRows: 8 }} />
      <Button htmlType="submit" loading={busy} disabled={!path.trim() || !content}>{busy ? "正在请求" : "留存文本"}</Button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

import { useState } from "react";
import { Button, Tag } from "@douyinfe/semi-ui";
import { providerDisposition } from "../workspace/model";

const script = [
  { role: "你", text: "对比两份会议材料，汇总一致结论和待确认项。" },
  { role: "规划者", text: "意图是对照两份纪要。目标拆成：一致结论由记录员整理，待确认项留给你决定。这是演示，没有写入任务。" },
  { role: "记录员", text: "作业执行成功：两份材料都写了「下周三评审」。这不等于业务目标已经通过。" },
  { role: "核对员", text: "业务目标未通过：预算数字不一致，需要你确认以哪一份为准。" },
];

const actions = [
  { action: "retry", egressAllowed: false },
  { action: "switch", egressAllowed: true },
  { action: "blocked", egressAllowed: true },
] as const;

export function DemoPage() {
  const [step, setStep] = useState(1);
  return (
    <section className="gy-demo" aria-label="演示场景">
      <Tag color="orange" size="large">演示数据 · 不调用控制面</Tag>
      <h2>对比两份会议材料</h2>
      <p>这个场景用来看规划者和多名 Worker 陆续返回时界面怎么表达。供应商处置也是演示文案，不是 /provider 的真实调用。</p>
      <ol>
        {script.slice(0, step).map((line) => <li key={line.role}><b>{line.role}</b>{line.text}</li>)}
      </ol>
      <Button onClick={() => setStep((value) => Math.min(script.length, value + 1))} disabled={step >= script.length}>下一条演示消息</Button>
      <div className="gy-demo-actions">
        {actions.map((item) => {
          const view = providerDisposition(item.action, item.egressAllowed);
          return (
            <article key={item.action}>
              <h3>{view.label}</h3>
              <p>action={item.action}{item.action === "blocked" ? "。即使 egressAllowed 为 true，也按阻塞展示。" : ""}</p>
              <pre>{JSON.stringify(view.raw, null, 2)}</pre>
            </article>
          );
        })}
      </div>
    </section>
  );
}

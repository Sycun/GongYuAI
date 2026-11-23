import { useEffect, useRef, useState } from "react";
import { AutoComplete, Input } from "@douyinfe/semi-ui";
import { IconChevronDown } from "@douyinfe/semi-icons";
import type { ChatConnection } from "@gongyuai/contracts";
import { api } from "../api";

export const protocolOptions = [
  { value: "openai", label: "OpenAI 兼容" }, { value: "anthropic", label: "Anthropic Messages" },
  { value: "gemini", label: "Google Gemini" },
];

type ModelInputProps = {
  id: string;
  options: string[];
  value: string;
  placeholder: string;
  onChange: (model: string) => void;
  required?: boolean;
};

export function ModelInput({ id, options, value, placeholder, onChange, required }: ModelInputProps) {
  const [search, setSearch] = useState("");
  const filter = search.trim().toLowerCase();
  const matches = filter ? options.filter(model => model.toLowerCase().includes(filter)) : options;
  return <AutoComplete value={value} data={matches} maxHeight={240} motion={false}
    onSearch={setSearch} onChange={model => onChange(String(model))}
    onDropdownVisibleChange={open => { if (!open) setSearch(""); }}
    emptyContent={filter ? "没有匹配的模型，可手动输入" : "暂无候选模型，可手动输入"}
    triggerRender={({ inputValue, onChange: onInput, onFocus, onBlur }) => (
      <Input id={id} value={inputValue} required={required} placeholder={placeholder}
        onChange={onInput} onFocus={onFocus} onBlur={onBlur}
        suffix={<IconChevronDown size="small" aria-hidden="true" />} />
    )} />;
}

/** 模型查询的共享流程：迟到结果按代次丢弃，连接字段变更时 reset。 */
export function useChatModelQuery() {
  const [found, setFound] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function query(connection: ChatConnection): Promise<string> {
    const request = ++generation.current;
    setFound(null); setBusy(true);
    try {
      const { json } = await api.queryChatModels({
        id: connection.id, baseUrl: connection.baseUrl.trim(), protocol: connection.protocol, apiKey: connection.apiKey.trim(),
      });
      if (generation.current !== request) return "";
      setFound(json.models);
      return json.models.length ? "" : "服务未列出模型，仍可手动输入。";
    } catch (e) {
      if (generation.current !== request) return "";
      return e instanceof Error ? e.message : "模型查询失败。";
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }
  function reset() {
    generation.current++;
    setFound(null); setBusy(false);
  }
  return { found, busy, query, reset };
}

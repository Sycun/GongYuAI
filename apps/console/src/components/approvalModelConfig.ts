import type { ChatProfile, ChatProtocol, PublicChatProfile } from "@gongyuai/contracts";

export type ApprovalModelForm = {
  id: string;
  name: string;
  protocol: ChatProtocol;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  models: string[];
};

/** 新建或按既有服务商预填审批表单；模型字段始终落在审批实际使用的模型上。 */
export function approvalModelForm(
  profile: PublicChatProfile | undefined,
  reviewerModelId: string | undefined,
  makeId: () => string,
): ApprovalModelForm {
  if (profile) {
    return {
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      apiKey: "",
      modelId: reviewerModelId ?? profile.modelId,
      models: profile.models,
    };
  }
  return {
    id: "custom-" + makeId(),
    name: "",
    protocol: "openai",
    baseUrl: "",
    apiKey: "",
    modelId: reviewerModelId ?? "",
    models: [],
  };
}

/** 组装保存用的服务商配置：既有服务商不改主模型，审批模型补进候选列表。 */
export function approvalModelProfile(
  form: ApprovalModelForm,
  base: PublicChatProfile | undefined,
  found: string[] | null,
): ChatProfile {
  const chosen = form.modelId.trim();
  const models = [...new Set([...(found ?? form.models), chosen])].filter(model => model.trim());
  return {
    id: form.id,
    name: form.name.trim() || "审批模型",
    protocol: form.protocol,
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    modelId: base ? base.modelId : chosen,
    models,
  };
}

import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const parent = { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "high" } as const;
export function usage(n = 1): Usage {
  return { input: n, output: 2 * n, cacheRead: 3 * n, cacheWrite: 4 * n, totalTokens: 10 * n,
    reasoning: n, cacheWrite1h: 2 * n, cost: { input: n, output: 2 * n, cacheRead: 3 * n, cacheWrite: 4 * n, total: 10 * n } };
}
export function assistant(content: string | AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", n = 1, model?: Pick<Model<any>, "api" | "provider" | "id">): AssistantMessage {
  return {
    role: "assistant", api: model?.api ?? "anthropic-messages", provider: model?.provider ?? parent.model.provider,
    model: model?.id ?? parent.model.id, content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    usage: usage(n), stopReason, timestamp: Date.now(),
  };
}

// An actual SDK model runtime, with auth/availability methods replaced only in isolated unit tests.
export async function unitRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new Error("Unexpected credential write"); }, delete: async () => { throw new Error("Unexpected credential deletion"); } },
  });
  runtime.getAvailable = async (provider) => runtime.getModels(provider);
  runtime.getAuth = async () => ({ auth: { apiKey: "offline-fixture" } });
  return runtime;
}

export function completedStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    if (message.stopReason !== "stop" && message.stopReason !== "toolUse" && message.stopReason !== "length") throw new Error("Unsupported fixture stop reason");
    stream.push({ type: "done", reason: message.stopReason, message });
  }
  stream.end();
  return stream;
}

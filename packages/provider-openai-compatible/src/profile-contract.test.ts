import { runOpenAiCompatibleProfileContractSuite } from "./testing/profile-contract-suite.js";

runOpenAiCompatibleProfileContractSuite([
  { profileId: "groq-chat-completions-v1", instanceId: "contract-groq", contractModelId: "gpt-oss-120b", catalogModelId: "openai/gpt-oss-120b" },
  { profileId: "cerebras-chat-completions-v2", instanceId: "contract-cerebras", contractModelId: "gpt-oss-120b", catalogModelId: "gpt-oss-120b" },
  { profileId: "openrouter-chat-completions-v1", instanceId: "contract-openrouter", contractModelId: "gpt-oss-20b-free", catalogModelId: "openai/gpt-oss-20b:free" },
]);

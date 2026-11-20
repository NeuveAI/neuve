// From OpenAI's Codex, rust-v0.171.0-alpha.13 (commit 581161ab41e643d942e1e1b5f561034060bf18e3),
// the unions in codex-rs/app-server-protocol/schema/typescript/. Apache-2.0; see LICENSE here.
// Regenerate with packages/runtime-codex/scripts/generate.ts; this file is written by it.

import type { InitializeParams } from "./InitializeParams";
import type { InitializeResponse } from "./InitializeResponse";
import type { ConfigReadParams } from "./v2/ConfigReadParams";
import type { ConfigReadResponse } from "./v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse } from "./v2/ConfigRequirementsReadResponse";
import type { ExperimentalFeatureListParams } from "./v2/ExperimentalFeatureListParams";
import type { ExperimentalFeatureListResponse } from "./v2/ExperimentalFeatureListResponse";
import type { ModelListParams } from "./v2/ModelListParams";
import type { ModelListResponse } from "./v2/ModelListResponse";
import type { GetAccountParams } from "./v2/GetAccountParams";
import type { GetAccountResponse } from "./v2/GetAccountResponse";
import type { GetAccountRateLimitsParams } from "./v2/GetAccountRateLimitsParams";
import type { GetAccountRateLimitsResponse } from "./v2/GetAccountRateLimitsResponse";
import type { HooksListParams } from "./v2/HooksListParams";
import type { HooksListResponse } from "./v2/HooksListResponse";
import type { SkillsListParams } from "./v2/SkillsListParams";
import type { SkillsListResponse } from "./v2/SkillsListResponse";
import type { AppsListParams } from "./v2/AppsListParams";
import type { AppsListResponse } from "./v2/AppsListResponse";
import type { ListMcpServerStatusParams } from "./v2/ListMcpServerStatusParams";
import type { ListMcpServerStatusResponse } from "./v2/ListMcpServerStatusResponse";
import type { ThreadStartParams } from "./v2/ThreadStartParams";
import type { ThreadStartResponse } from "./v2/ThreadStartResponse";
import type { ThreadResumeParams } from "./v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "./v2/ThreadResumeResponse";
import type { ThreadReadParams } from "./v2/ThreadReadParams";
import type { ThreadReadResponse } from "./v2/ThreadReadResponse";
import type { ThreadArchiveParams } from "./v2/ThreadArchiveParams";
import type { ThreadArchiveResponse } from "./v2/ThreadArchiveResponse";
import type { ThreadDeleteParams } from "./v2/ThreadDeleteParams";
import type { ThreadDeleteResponse } from "./v2/ThreadDeleteResponse";
import type { TurnStartParams } from "./v2/TurnStartParams";
import type { TurnStartResponse } from "./v2/TurnStartResponse";
import type { TurnSteerParams } from "./v2/TurnSteerParams";
import type { TurnSteerResponse } from "./v2/TurnSteerResponse";
import type { TurnInterruptParams } from "./v2/TurnInterruptParams";
import type { TurnInterruptResponse } from "./v2/TurnInterruptResponse";
import type { ErrorNotification } from "./v2/ErrorNotification";
import type { WarningNotification } from "./v2/WarningNotification";
import type { ConfigWarningNotification } from "./v2/ConfigWarningNotification";
import type { DeprecationNoticeNotification } from "./v2/DeprecationNoticeNotification";
import type { ThreadStartedNotification } from "./v2/ThreadStartedNotification";
import type { ThreadStatusChangedNotification } from "./v2/ThreadStatusChangedNotification";
import type { ThreadClosedNotification } from "./v2/ThreadClosedNotification";
import type { ThreadArchivedNotification } from "./v2/ThreadArchivedNotification";
import type { ThreadDeletedNotification } from "./v2/ThreadDeletedNotification";
import type { ThreadTokenUsageUpdatedNotification } from "./v2/ThreadTokenUsageUpdatedNotification";
import type { TurnStartedNotification } from "./v2/TurnStartedNotification";
import type { TurnCompletedNotification } from "./v2/TurnCompletedNotification";
import type { ItemStartedNotification } from "./v2/ItemStartedNotification";
import type { ItemCompletedNotification } from "./v2/ItemCompletedNotification";
import type { AgentMessageDeltaNotification } from "./v2/AgentMessageDeltaNotification";
import type { McpToolCallProgressNotification } from "./v2/McpToolCallProgressNotification";
import type { HookStartedNotification } from "./v2/HookStartedNotification";
import type { HookCompletedNotification } from "./v2/HookCompletedNotification";
import type { ServerRequestResolvedNotification } from "./v2/ServerRequestResolvedNotification";
import type { McpServerStatusUpdatedNotification } from "./v2/McpServerStatusUpdatedNotification";
import type { AccountUpdatedNotification } from "./v2/AccountUpdatedNotification";
import type { AccountRateLimitsUpdatedNotification } from "./v2/AccountRateLimitsUpdatedNotification";
import type { ModelReroutedNotification } from "./v2/ModelReroutedNotification";
import type { CommandExecutionRequestApprovalParams } from "./v2/CommandExecutionRequestApprovalParams";
import type { FileChangeRequestApprovalParams } from "./v2/FileChangeRequestApprovalParams";
import type { ToolRequestUserInputParams } from "./v2/ToolRequestUserInputParams";
import type { McpServerElicitationRequestParams } from "./v2/McpServerElicitationRequestParams";
import type { PermissionsRequestApprovalParams } from "./v2/PermissionsRequestApprovalParams";
import type { DynamicToolCallParams } from "./v2/DynamicToolCallParams";
import type { ChatgptAuthTokensRefreshParams } from "./v2/ChatgptAuthTokensRefreshParams";
import type { AttestationGenerateParams } from "./v2/AttestationGenerateParams";
import type { ApplyPatchApprovalParams } from "./ApplyPatchApprovalParams";
import type { ExecCommandApprovalParams } from "./ExecCommandApprovalParams";

export const RELEASE = "0.171.0-alpha.13";

/** The client requests kept, with their parameter and response types. */
export type ClientMethods = {
  "initialize": { params: InitializeParams; response: InitializeResponse };
  "config/read": { params: ConfigReadParams; response: ConfigReadResponse };
  "configRequirements/read": { params: undefined; response: ConfigRequirementsReadResponse };
  "experimentalFeature/list": { params: ExperimentalFeatureListParams; response: ExperimentalFeatureListResponse };
  "model/list": { params: ModelListParams; response: ModelListResponse };
  "account/read": { params: GetAccountParams; response: GetAccountResponse };
  "account/rateLimits/read": { params: GetAccountRateLimitsParams; response: GetAccountRateLimitsResponse };
  "hooks/list": { params: HooksListParams; response: HooksListResponse };
  "skills/list": { params: SkillsListParams; response: SkillsListResponse };
  "app/list": { params: AppsListParams; response: AppsListResponse };
  "mcpServerStatus/list": { params: ListMcpServerStatusParams; response: ListMcpServerStatusResponse };
  "thread/start": { params: ThreadStartParams; response: ThreadStartResponse };
  "thread/resume": { params: ThreadResumeParams; response: ThreadResumeResponse };
  "thread/read": { params: ThreadReadParams; response: ThreadReadResponse };
  "thread/archive": { params: ThreadArchiveParams; response: ThreadArchiveResponse };
  "thread/delete": { params: ThreadDeleteParams; response: ThreadDeleteResponse };
  "turn/start": { params: TurnStartParams; response: TurnStartResponse };
  "turn/steer": { params: TurnSteerParams; response: TurnSteerResponse };
  "turn/interrupt": { params: TurnInterruptParams; response: TurnInterruptResponse };
};

/** The notifications the client reads, with their parameter types. */
export type Notifications = {
  "error": ErrorNotification;
  "warning": WarningNotification;
  "configWarning": ConfigWarningNotification;
  "deprecationNotice": DeprecationNoticeNotification;
  "thread/started": ThreadStartedNotification;
  "thread/status/changed": ThreadStatusChangedNotification;
  "thread/closed": ThreadClosedNotification;
  "thread/archived": ThreadArchivedNotification;
  "thread/deleted": ThreadDeletedNotification;
  "thread/tokenUsage/updated": ThreadTokenUsageUpdatedNotification;
  "turn/started": TurnStartedNotification;
  "turn/completed": TurnCompletedNotification;
  "item/started": ItemStartedNotification;
  "item/completed": ItemCompletedNotification;
  "item/agentMessage/delta": AgentMessageDeltaNotification;
  "item/mcpToolCall/progress": McpToolCallProgressNotification;
  "hook/started": HookStartedNotification;
  "hook/completed": HookCompletedNotification;
  "serverRequest/resolved": ServerRequestResolvedNotification;
  "mcpServer/startupStatus/updated": McpServerStatusUpdatedNotification;
  "account/updated": AccountUpdatedNotification;
  "account/rateLimits/updated": AccountRateLimitsUpdatedNotification;
  "model/rerouted": ModelReroutedNotification;
};
export const READ_NOTIFICATIONS: ReadonlySet<string> = new Set(["error","warning","configWarning","deprecationNotice","thread/started","thread/status/changed","thread/closed","thread/archived","thread/deleted","thread/tokenUsage/updated","turn/started","turn/completed","item/started","item/completed","item/agentMessage/delta","item/mcpToolCall/progress","hook/started","hook/completed","serverRequest/resolved","mcpServer/startupStatus/updated","account/updated","account/rateLimits/updated","model/rerouted"]);

/** Every request the server can send, with its parameter type. */
export type ServerRequests = {
  "item/commandExecution/requestApproval": CommandExecutionRequestApprovalParams;
  "item/fileChange/requestApproval": FileChangeRequestApprovalParams;
  "item/tool/requestUserInput": ToolRequestUserInputParams;
  "mcpServer/elicitation/request": McpServerElicitationRequestParams;
  "item/permissions/requestApproval": PermissionsRequestApprovalParams;
  "item/tool/call": DynamicToolCallParams;
  "account/chatgptAuthTokens/refresh": ChatgptAuthTokensRefreshParams;
  "attestation/generate": AttestationGenerateParams;
  "applyPatchApproval": ApplyPatchApprovalParams;
  "execCommandApproval": ExecCommandApprovalParams;
};

/** Every notification name this release's server has. */
export const SERVER_NOTIFICATIONS: ReadonlySet<string> = new Set(["error","thread/started","thread/status/changed","thread/readState/changed","thread/archived","thread/deleted","thread/unarchived","thread/closed","thread/reverted","skills/changed","thread/name/updated","thread/section/changed","thread/attachment/updated","thread/goal/updated","thread/prediction/updated","thread/goal/cleared","thread/queue/changed","project/changed","thread/project/updated","thread/environment/connected","thread/environment/disconnected","thread/settings/updated","thread/tokenUsage/updated","turn/started","hook/started","turn/completed","hook/completed","turn/diff/updated","turn/plan/updated","item/started","item/autoApprovalReview/started","item/autoApprovalReview/completed","autoApprovalReview/strictReviewRequired","item/completed","rawResponseItem/completed","rawResponse/completed","item/agentMessage/delta","item/plan/delta","command/exec/outputDelta","process/outputDelta","thread/search/partial","process/exited","item/commandExecution/outputDelta","item/commandExecution/terminalInteraction","item/fileChange/outputDelta","item/fileChange/patchUpdated","serverRequest/resolved","item/mcpToolCall/progress","mcpServer/oauthLogin/completed","mcpServer/startupStatus/updated","mcpServer/event/stream/notification","account/updated","account/gatewayOAuth/changed","account/rateLimits/updated","app/list/updated","remoteControl/status/changed","externalAgentConfig/import/progress","externalAgentConfig/import/completed","fs/changed","item/reasoning/summaryTextDelta","item/reasoning/summaryPartAdded","item/reasoning/textDelta","thread/compacted","model/rerouted","model/verification","modelProvider/authRecoveryStarted","modelProvider/authRecoveryCompleted","turn/moderationMetadata","model/safetyBuffering/updated","warning","guardianWarning","deprecationNotice","configWarning","fuzzyFileSearch/sessionUpdated","fuzzyFileSearch/sessionCompleted","thread/realtime/started","thread/realtime/itemAdded","thread/realtime/item/started","thread/realtime/item/transcript/delta","thread/realtime/item/completed","thread/realtime/transcript/delta","thread/realtime/transcript/done","thread/realtime/outputAudio/delta","thread/realtime/sdp","thread/realtime/error","thread/realtime/closed","windows/worldWritableWarning","windowsSandbox/setupCompleted","account/login/completed"]);

/** Every request name this release's server has. */
export const SERVER_REQUESTS: ReadonlySet<string> = new Set(["item/commandExecution/requestApproval","item/fileChange/requestApproval","item/tool/requestUserInput","mcpServer/elicitation/request","item/permissions/requestApproval","item/tool/call","account/chatgptAuthTokens/refresh","attestation/generate","applyPatchApproval","execCommandApproval"]);

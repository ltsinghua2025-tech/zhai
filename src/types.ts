export type SourceInput =
  | { kind: "file"; path: string }
  | { kind: "path"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "files"; paths: string[] };

export type ScanOptions = {
  recursive: true;
  followSymlinks: false;
  extensions: string[];
  exclusions: string[];
};

export type ScannedFile = {
  id: string;
  path: string;
  name: string;
  extension: string;
  category: string;
  size: number;
  modifiedAt?: string;
  relativePath: string;
  readable: boolean;
  issue?: string;
  processingStatus: "processable" | "legacy_skipped" | "unreadable";
  processingReason?: string;
};

export type ScanResult = {
  manifestId: string;
  sourceLabel: string;
  files: ScannedFile[];
  summary: {
    totalFiles: number;
    discoveredFiles: number;
    totalSize: number;
    subdirectories: number;
    unreadableFiles: number;
    legacyFiles: number;
    processableFiles: number;
    excludedItems: number;
    excludedByFormat: Record<string, number>;
    byFormat: Record<string, number>;
  };
  warnings: string[];
};

export type OperationKind =
  | "safe_copy"
  | "inspect_document"
  | "extract_fields"
  | "replace_text"
  | "normalize_whitespace"
  | "remove_line_breaks"
  | "normalize_docx_styles"
  | "apply_redhead"
  | "fill_docx_template"
  | "update_dates"
  | "clean_metadata"
  | "generate_gongwen"
  | "set_xlsx_cell"
  | "delete_blank_rows"
  | "merge_xlsx"
  | "extract_docx_text"
  | "merge_docx"
  | "split_docx"
  | "center_docx_page_numbers"
  | "split_xlsx"
  | "extract_xlsx_text"
  | "csv_to_xlsx"
  | "xlsx_to_csv"
  | "merge_or_split"
  | "split_pdf"
  | "rotate_pdf"
  | "watermark_pdf"
  | "extract_pdf_text"
  | "ocr_pdf"
  | "convert_to_pdf"
  | "doc_to_docx"
  | "xls_to_xlsx"
  | "xlsx_recalculate"
  | "convert_with_wps"
  | "redact_content"
  | "review_content"
  | "cross_file_consistency_check";

export type Operation = {
  id: string;
  kind: OperationKind;
  title: string;
  description: string;
  fileCount: number;
  parameters: Record<string, unknown>;
  requiresReview: boolean;
  available: boolean;
  unavailableReason?: string;
};

export type TaskPlan = {
  id: string;
  manifestId: string;
  taskName: string;
  description: string;
  operations: Operation[];
  affectedFiles: number;
  outputDirectory: string;
  estimatedOutputs: number;
  cloudPayload?: AiPayload;
  aiReviewItems: AiReviewItem[];
  aiGenerated: boolean;
  aiProfileId?: string;
  aiModel?: string;
  warnings: string[];
  requiresWps: boolean;
  requiresOcr: boolean;
  requiresAi: boolean;
};

export type JobEvent =
  | { type: "started"; jobId: string }
  | { type: "file_progress"; fileId: string; progress: number; message?: string }
  | { type: "review_required"; reviewId: string }
  | { type: "file_failed"; fileId: string; message: string }
  | { type: "completed"; reportPath: string }
  | { type: "cancelled"; jobId: string };

export type JobOutcome = {
  jobId: string;
  status: "completed" | "partial" | "failed" | "cancelled";
  outputDirectory: string;
  reportPath: string;
  completedFiles: number;
  failedFiles: number;
  failures: Array<{ fileId: string; path: string; message: string }>;
  skippedFiles: number;
  skips: Array<{ fileId: string; path: string; reason: string }>;
  outputs?: Array<{ fileId: string; path: string }>;
};

export type HistoryEntry = {
  id: string;
  taskName: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  totalFiles: number;
  failedFiles: number;
  outputDirectory: string;
  reportPath?: string;
};

export type Capability = {
  available: boolean;
  status: string;
  detail: string;
};

export type WpsCapabilities = {
  installed: boolean;
  applicationPath?: string;
  bundleId?: string;
  version?: string;
  docToDocx: Capability;
  xlsToXlsx: Capability;
  xlsxRecalculate: Capability;
  docxToPdf: Capability;
  xlsxToPdf: Capability;
};

export type LibreOfficeCapabilities = {
  installed: boolean;
  executablePath?: string;
  version?: string;
  bundled: boolean;
  docToDocx: Capability;
  xlsToXlsx: Capability;
  xlsxRecalculate: Capability;
  docxToPdf: Capability;
  xlsxToPdf: Capability;
};

export type EngineCapabilities = {
  pythonSidecar: Capability;
  visionOcr: Capability;
  paddleOcr: Capability;
};

export type CodexRuntimeStatus = {
  available: boolean;
  path?: string;
  version?: string;
  detail: string;
};

export type SupportedAiProvider = "deepseek" | "openai_compatible";
// Read legacy records without changing their provider or credential reference.
export type AiProvider = SupportedAiProvider | "openai" | "anthropic" | "gemini";

export type PythonExecutionStatus = {
  available: boolean;
  backend?: string;
  detail: string;
};

export type OfficeFontStatus = {
  id: string;
  name: string;
  installed: boolean;
  matchedFile?: string;
  licenseNote: string;
};

export type AiProfile = {
  id: string;
  provider: AiProvider;
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  keyStored: boolean;
  managed?: boolean;
  lastTest?: {
    success: boolean;
    returnedModel?: string;
    latencyMs?: number;
    testedAt: string;
    message: string;
  };
};

export type ToolParameter = {
  key: string;
  label: string;
  type: "text" | "boolean" | "number" | "choice";
  required: boolean;
  defaultValue?: unknown;
  choices?: string[];
  placeholder?: string;
};

export type ToolStep = {
  toolId: string;
  parameters: Record<string, unknown>;
};

export type AgentTool = {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "designed";
  kind?: "builtin" | "workflow" | "python" | "adapter" | "derived";
  version?: string;
  author?: string;
  permissions?: Array<
    | "read_selected_files"
    | "write_task_output"
    | "launch_office_app"
    | "network"
    | "read_inputs"
    | "write_outputs"
    | "external_office"
  >;
  sourceCode?: string;
  testStatus?: "untested" | "passed" | "failed";
  testResult?: SkillTestResult;
  status?: SkillStatus;
  supportedExtensions: string[];
  available: boolean;
  availabilityDetail: string;
  parameters: ToolParameter[];
  steps: ToolStep[];
  origin?: {
    parentSkillId: string;
    parentVersion?: string;
    changeSummary?: string;
  };
  requiresNetwork?: boolean;
  packagePath?: string;
  packageHash?: string;
  outputExtensions?: string[];
  dependencies?: string[];
  acceptance?: string[];
  composition?: SkillComposition;
};

export type SkillStage =
  | {
      kind: "skill";
      skillId: string;
      input: "original" | "previous" | `stage:${number}`;
      parameters: Record<string, unknown>;
    }
  | {
      kind: "python";
      script: string;
      input: "original" | "previous" | `stage:${number}`;
      parameters?: Record<string, unknown>;
      outputExtensions: string[];
    };

export type SkillComposition = {
  schemaVersion: 1 | 2;
  versionPolicy: "latest_compatible" | "locked";
  stages: SkillStage[];
};

export type SkillStatus =
  | "draft"
  | "testing"
  | "published"
  | "test_failed"
  | "unavailable"
  | "disabled";

export type SkillRunResult = {
  summary: string;
  outputDirectory: string;
  artifacts: AgentAttachment[];
};

export type SkillRunEvent =
  | { type: "started"; runId: string; total: number }
  | {
      type: "progress";
      runId: string;
      stage: "preparing" | "executing" | "validating";
      current: number;
      total: number;
      message: string;
    }
  | { type: "completed"; runId: string; outputDirectory: string }
  | { type: "failed"; runId: string; message: string }
  | { type: "cancelled"; runId: string };

export type AgentSessionStatus = "idle" | "running" | "waiting_approval" | "failed";

export type AgentSession = {
  id: string;
  title: string;
  profileId: string;
  model: string;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  workspacePath: string;
};

export type AgentAttachment = {
  id: string;
  sessionId: string;
  kind: "file" | "folder" | "url" | "artifact";
  name: string;
  mimeType?: string;
  localSnapshotPath?: string;
  sourceUrl?: string;
  sha256?: string;
  size?: number;
  createdAt: string;
  sourceGroupId?: string;
  sourceGroupName?: string;
  relativePath?: string;
};

export type AgentToolRun = {
  id: string;
  sessionId: string;
  turnId: string;
  toolId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  summary: string;
  detail?: string;
  startedAt: string;
  completedAt?: string;
};

export type AgentMessage = {
  canDesignSkill?: boolean;
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  turnId?: string;
  attachmentIds?: string[];
};

export type AgentSessionDetail = {
  session: AgentSession;
  messages: AgentMessage[];
  attachments: AgentAttachment[];
  toolRuns: AgentToolRun[];
};

export type AgentAttachmentInput =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "url"; url: string };

export type AgentEvent =
  | { type: "phase"; sessionId: string; turnId: string; message: string }
  | { type: "assistant_delta"; sessionId: string; turnId: string; text: string }
  | { type: "tool_started"; sessionId: string; turnId: string; runId: string; toolId: string; summary: string }
  | { type: "tool_progress"; sessionId: string; turnId: string; runId: string; progress: number; detail?: string }
  | { type: "approval_required"; sessionId: string; turnId: string; approvalId: string; action: string; reason: string }
  | { type: "artifact_created"; sessionId: string; turnId: string; artifact: AgentAttachment }
  | { type: "artifact_removed"; sessionId: string; turnId: string; artifactId: string }
  | { type: "tool_failed"; sessionId: string; turnId: string; runId: string; message: string }
  | { type: "turn_completed"; sessionId: string; turnId: string; messageId: string }
  | { type: "turn_cancelled"; sessionId: string; turnId: string };

export type SendAgentMessageRequest = {
  attachmentIds?: string[];
  sessionId: string;
  content: string;
  profileId: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  allowModelFileAccess: boolean;
};

export type ToolPlanRequest = {
  manifestId: string;
  taskName: string;
  instruction: string;
  mode: "agent" | "dispatch" | "manual";
  profileId?: string;
  model?: string;
  apiKey?: string;
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
  toolId?: string;
  parameters: Record<string, unknown>;
};

export type DesignToolRequest = {
  designId?: string;
  sessionId?: string;
  currentSkillId?: string;
  prompt: string;
  profileId: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  kind?: "workflow" | "python" | "adapter" | "derived";
  attachments?: DesignAttachment[];
};

export type SkillDesignEvent =
  | { type: "started"; designId: string }
  | {
      type: "phase";
      phase: "loading_skill" | "editing" | "testing" | "repairing" | "saving";
      message: string;
      elapsedSeconds: number;
    }
  | { type: "test_progress"; current: number; total: number; message: string }
  | { type: "completed"; skillId: string }
  | { type: "failed"; code: string; message: string; retryable: boolean }
  | { type: "cancelled" };

export type DesignAttachment = {
  path: string;
  role: "sample_input" | "template" | "expected_output" | "reference";
};

export type SkillTestResult = {
  status: "passed" | "failed" | "needs_input" | "cancelled";
  summary: string;
  outputDirectory?: string;
  outputs: string[];
  parameters: Record<string, unknown>;
  repairable: boolean;
};

export type SkillDesignState = {
  designId: string;
  skillId?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  attachmentRoles: Record<string, DesignAttachment["role"]>;
  parameters: Record<string, unknown>;
  testResult?: SkillTestResult;
  sourceTask?: { sessionId: string; turnId: string };
};

export type TaskSkillSeed = { prompt: string; samplePaths: string[]; requiresNetwork: boolean; networkReason?: string };

export type SkillDesignRunResult = { skill: AgentTool; testResult?: SkillTestResult };
export type DesignAndTestRequest = {
  design: DesignToolRequest;
  samplePaths: string[];
  parameters: Record<string, unknown>;
  runId: string;
  autoTest: boolean;
};
export type TestAndRepairRequest = {
  designId?: string;
  runId: string;
  skillId: string;
  samplePaths: string[];
  parameters: Record<string, unknown>;
  repair?: DesignToolRequest;
};

export type CitizenReplyMode = "reply" | "special" | "appeal" | "review";
export type CitizenReplyPlatform = "general" | "people" | "provincial";

export type CitizenReplyRequest = {
  profileId: string;
  model: string;
  apiKey?: string;
  mode: CitizenReplyMode;
  platform: CitizenReplyPlatform;
  department: string;
  citizenRequest: string;
  caseLocation: string;
  verification: string;
  handling: string;
  caseResult: string;
  nextStep: string;
  instructions: string;
};

export type CitizenReplyFinding = {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
};

export type CitizenReplyResult = {
  answer: string;
  findings: CitizenReplyFinding[];
  references: Array<{ source: string; title: string }>;
  returnedModel?: string;
};

export type AiChunk = {
  id: string;
  sourceFileIds: string[];
  redactedText: string;
  characterCount: number;
};

export type AiPayload = {
  id: string;
  manifestId: string;
  selectedFileIds: string[];
  chunks: AiChunk[];
  characterCount: number;
  payloadHash: string;
};

export type AiLocator =
  | { kind: "docx_paragraph"; index: number }
  | { kind: "xlsx_cell"; sheet: string; cell: string }
  | { kind: "pdf_page"; page: number }
  | { kind: "csv_cell"; row: number; column: string };

export type AiReviewItem = {
  id: string;
  fileId: string;
  locator: AiLocator;
  before: string;
  after: string;
  reason: string;
  confidence: number;
};

export type AiConnectionResult = {
  success: boolean;
  returnedModel?: string;
  latencyMs?: number;
  testedAt: string;
  message: string;
};

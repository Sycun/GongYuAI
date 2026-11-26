import type { DatabaseSync } from "node:sqlite";
import type {
  Fact,
  FactLayer,
  Finding,
  GoalState,
  HistoryEvent,
  HistoryEventKind,
  Intent,
  IntentStatus,
  KnowledgeBodyFormat,
  KnowledgeSection,
  KnowledgeSourceKind,
  CreateFactReview,
} from "@gongyuai/contracts";
import type { EvidenceSnapshot } from "./goal-evidence.js";
import type { SnapshotGoalFinding } from "./scorecard.js";

export type HistoryRow = Record<string, unknown>;

export type MaterialCitationSeal = {
  materialTitle: string;
  publisher: string;
  sourceKind: KnowledgeSourceKind;
  versionNo: number;
  versionLabel: string;
  bodyFormat: KnowledgeBodyFormat;
  sectionHeading: string | null;
  sectionPage: number | null;
  sectionOrdinal: number;
  /** 片段元数据（不含正文）：标题路径、父章节、片序、行号、页码依据。 */
  sectionMeta: Omit<KnowledgeSection, "text">;
  snapshot: Buffer;
};

export type FactReview = CreateFactReview & { id: string; sha256: string; createdAt: string };
export type GoalProof = { goalId: string; path: string; sha256: string };
export type GoalFindingSupport = SnapshotGoalFinding;

export type FindingAction = {
  id: string;
  taskId: string;
  findingId: string;
  action: "retest" | "accept";
  result: string;
  note: string;
  path: string;
  sha256: string;
  createdAt: string;
};

export type DeliveryCorrection = {
  id: string;
  taskId: string;
  number: number;
  reason: string;
  findings: string[];
  goals: string[];
  report: Array<{ path: string; sha256: string }>;
  noticeStatus: "pending" | "notified" | "confirmed";
  evidencePath?: string;
  sha256?: string;
  createdAt: string;
};

/** Shared internal context passed from `HistoryStore` to domain sub-stores (single SQLite connection). */
export interface HistoryDomainDeps {
  readonly db: DatabaseSync;
  readonly evidenceDir: string;
  readonly archiveTables?: Set<string>;
  now(): string;
  emit(taskId: string, kind: HistoryEventKind, payload?: Record<string, unknown>): HistoryEvent;
  saveVersion(file: EvidenceSnapshot): void;
  resolveIntentIdForWrite(taskId: string, intentId?: string | null): string | null;
  appendFact(input: {
    taskId: string;
    layer: FactLayer;
    title: string;
    summary?: string;
    evidencePath?: string | null;
    tags?: string[];
    intentId?: string | null;
  }): Fact;
  getFact(taskId: string, factId: string): Fact | null;
  listFacts(taskId: string, layer?: FactLayer): Fact[];
  getIntent(taskId: string, intentId: string): Intent | null;
  listIntents(taskId: string, status?: IntentStatus): Intent[];
  listGoals(taskId: string): GoalState[];
  listGoalProofs(taskId: string): GoalProof[];
  listGoalFindings(taskId: string): GoalFindingSupport[];
  getFinding(taskId: string, findingId: string): Finding | null;
  listFindings(taskId: string): Finding[];
  hasConfirmedValidation(taskId: string, findingId: string): boolean;
  resolveEvidenceRef(
    taskId: string,
    ref: string,
  ): { path: string; sha256: string; content: Buffer } | null;
}

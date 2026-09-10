import type {
  ExperienceTimelineEvent
} from '../../observability/view-models/index.js';
import type { TrajectoryEvidenceRef } from './trajectory-evidence.js';

export type ReplayLaneKind = 'conversation' | 'knowledge' | 'action' | 'result';

export type ReplayCardTone = 'message' | 'reasoning' | 'knowledge' | 'action' | 'result' | 'pending' | 'failure' | 'warning';

type ConversationRole = 'user' | 'assistant';

export type ReplayFacetGroup = 'knowledge' | 'tool' | 'status';

export type ReplayMilestoneTone = 'start' | 'end' | 'warning' | 'neutral';

export type ToolResultState = 'pending' | 'missing' | 'failure' | 'cancelled' | 'success';

export interface ReplayProjectionOptions {
  pendingToolResults: boolean;
}

export interface ReplayFacet {
  id: string;
  label: string;
  group: ReplayFacetGroup;
}

export interface ReplayCard {
  id: string;
  operationId: string;
  lane: ReplayLaneKind;
  timestamp?: string;
  position: number;
  row: number;
  conversationRole?: ConversationRole;
  tone: ReplayCardTone;
  kindLabel: string;
  model?: string;
  title: string;
  detail: string;
  facetIds: string[];
  rawId: string;
  primary: boolean;
  compact?: boolean;
  width: number;
}

export interface ReplayGap {
  position: number;
  width: number;
  durationMs: number;
}

export interface ReplayAxisTick {
  position: number;
  label: string;
}

export interface ReplayMilestone {
  position: number;
  timestamp?: string;
  label: string;
  tone: ReplayMilestoneTone;
}

export interface ReplayField {
  label: string;
  value: string;
  detail: string;
  presentation?: 'default' | 'content';
  copyable?: boolean;
  evidence?: TrajectoryEvidenceRef;
  detailKind?: 'content' | 'result';
}

export interface ReplayOperation {
  id: string;
  facetIds: string[];
  selectionLabel: string;
  typeLabel: string;
  title: string;
  summary: string;
  evidenceLabel: string;
  fields: ReplayField[];
  events: ExperienceTimelineEvent[];
}

export interface ReplayProjection {
  cards: ReplayCard[];
  operations: ReplayOperation[];
  facets: ReplayFacet[];
  laneRows: Record<ReplayLaneKind, number>;
  gaps: ReplayGap[];
  axisTicks: ReplayAxisTick[];
  milestones: ReplayMilestone[];
  startTimestamp?: string;
  endTimestamp?: string;
  durationMs: number;
  detailWidth: number;
}

export type ReplayCardInput = Omit<ReplayCard, 'row' | 'width'>;

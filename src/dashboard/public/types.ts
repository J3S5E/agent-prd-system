// Dashboard types - re-export from shared backend types for end-to-end type safety
// This file imports types from the backend to ensure consistency

// Import types from backend for local use
import type {
  Ticket as BaseTicket,
  Evidence,
  Suggestion,
  Deviation,
  ValidationRun,
  Repo,
} from '../../db/schema.js';

import type {
  TicketStatus,
  CreateTicket,
  UpdateTicket,
  UpdateTicketStatus,
  UnblockTicket,
  CreateSubtask,
} from '../../types/ticket.js';

import type {
  ValidationCheck,
  ValidationConfig,
  ValidationRunResult,
  SubmitValidationResults,
} from '../../types/validation.js';

import type {
  TicketEvent,
  WebSocketMessage,
} from '../../engine/events.js';

// Extended event types for ralph locks
type LockEvent = 
  | { type: 'ticket:lock_acquired'; ticketId: string; instanceId: string; lockType: string }
  | { type: 'ticket:lock_released'; ticketId: string; instanceId: string }
  | { type: 'ticket:lock_expired'; ticketId: string; instanceId: string }
  | { type: 'ralph:offline'; instanceId: string }
  | { type: 'ralph:registered'; instanceId: string; name: string; repo: string; status: string };

export type ExtendedWebSocketMessage = WebSocketMessage & {
  event: TicketEvent['type'] | LockEvent['type'];
  data: Omit<TicketEvent, 'type'> | Omit<LockEvent, 'type'>;
};

// Re-export all imported types
export type {
  BaseTicket,
  Evidence,
  Suggestion,
  Deviation,
  ValidationRun,
  Repo,
  TicketStatus,
  CreateTicket,
  UpdateTicket,
  UpdateTicketStatus,
  UnblockTicket,
  CreateSubtask,
  ValidationCheck,
  ValidationConfig,
  ValidationRunResult,
  SubmitValidationResults,
  TicketEvent,
  WebSocketMessage,
};

// Extended Ticket with optional relations (populated by API with ?include=)
export interface Ticket extends BaseTicket {
  subtasks?: Ticket[];
  evidence?: Evidence[];
  suggestions?: Suggestion[];
  deviations?: Deviation[];
  validationRuns?: ValidationRun[];
}

// Extended ValidationRun with optional durationMs (added by API)
export interface ValidationRunWithDuration extends ValidationRun {
  durationMs?: number;
}

// Additional frontend-specific types
export interface ApiError {
  message: string;
  status: number;
}

export interface RepoSummary {
  name: string;
  tickets: Ticket[];
  flagged: number;
  statusCounts: Record<TicketStatus, number>;
}

export interface KanbanColumn {
  status: TicketStatus;
  tickets: Ticket[];
  isFlagged: boolean;
}
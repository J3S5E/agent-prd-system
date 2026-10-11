import { TicketStatus, TicketStatusEnum } from '../types/ticket.js';

export type TransitionResult = 
  | { success: true; newStatus: TicketStatus }
  | { success: false; error: string };

// Valid FSM transitions adjacency map
const transitions: Record<TicketStatus, TicketStatus[]> = {
  'NEEDS_REFINEMENT': ['NEEDS_PLAN', 'NEEDS_HUMAN_CLARIFICATION'],
  'NEEDS_PLAN': ['READY_PLAN_REVIEW', 'NEEDS_HUMAN_PLAN_REVIEW'],
  'READY_PLAN_REVIEW': ['NEEDS_PLAN_UPDATING', 'NEEDS_IMPLEMENTING'],
  'NEEDS_PLAN_UPDATING': ['READY_PLAN_REVIEW', 'NEEDS_HUMAN_PLAN_REVIEW'],
  'NEEDS_IMPLEMENTING': ['NEEDS_SUBTICKETS_PROCESSED', 'NEEDS_VALIDATION', 'NEEDS_HUMAN_CLARIFICATION'],
  'NEEDS_SUBTICKETS_PROCESSED': ['NEEDS_VALIDATION', 'NEEDS_HUMAN_CLARIFICATION'],
  'NEEDS_VALIDATION': ['NEEDS_IMPLEMENTATION_UPDATE', 'NEEDS_REVIEW', 'NEEDS_HUMAN_INTERVENTION'],
  'NEEDS_IMPLEMENTATION_UPDATE': ['NEEDS_VALIDATION', 'NEEDS_REVIEW', 'NEEDS_HUMAN_CLARIFICATION'],
  'NEEDS_REVIEW': ['NEEDS_IMPLEMENTATION_UPDATE', 'NEEDS_SECURITY_REVIEW', 'NEEDS_HUMAN_CLARIFICATION'],
  'NEEDS_SECURITY_REVIEW': ['NEEDS_IMPLEMENTATION_UPDATE', 'NEEDS_QA', 'NEEDS_HUMAN_CLARIFICATION'],
  'NEEDS_QA': ['NEEDS_IMPLEMENTATION_UPDATE', 'NEEDS_PR', 'NEEDS_GIT_MERGE', 'NEEDS_HUMAN_CLARIFICATION'],
  'NEEDS_PR': ['NEEDS_PR_MAINTENANCE', 'NEEDS_GIT_MERGE'],
  'NEEDS_GIT_MERGE': ['NEEDS_PR_MAINTENANCE', 'NEEDS_FINALIZING'],
  'NEEDS_PR_MAINTENANCE': ['NEEDS_FINALIZING'],
  'NEEDS_FINALIZING': ['NEEDS_CLEANUP'],
  'NEEDS_CLEANUP': ['DONE'],
  'DONE': [],
  'NEEDS_HUMAN_INTERVENTION': [],
  'NEEDS_HUMAN_CLARIFICATION': [],
  'NEEDS_HUMAN_PLAN_REVIEW': [],
};

export function validateTransition(currentStatus: TicketStatus, newStatus: TicketStatus): TransitionResult {
  const allowed = transitions[currentStatus];
  
  if (!allowed) {
    return { success: false, error: `Unknown current status: ${currentStatus}` };
  }
  
  if (!allowed.includes(newStatus)) {
    return { 
      success: false, 
      error: `Invalid transition from ${currentStatus} to ${newStatus}. Allowed: ${allowed.join(', ')}` 
    };
  }
  
  return { success: true, newStatus };
}

export function isValidStatus(status: string): status is TicketStatus {
  return TicketStatusEnum.safeParse(status).success;
}

const FLAGGED_STATUSES: TicketStatus[] = [
  'NEEDS_HUMAN_INTERVENTION',
  'NEEDS_HUMAN_CLARIFICATION',
  'NEEDS_HUMAN_PLAN_REVIEW',
];

export function isFlaggedStatus(status: TicketStatus): boolean {
  return FLAGGED_STATUSES.includes(status);
}

export function getFlaggedReason(status: TicketStatus): string {
  switch (status) {
    case 'NEEDS_HUMAN_INTERVENTION':
      return 'Validation failed 3 times';
    case 'NEEDS_HUMAN_CLARIFICATION':
      return 'Implementation retry exceeded 3 attempts';
    case 'NEEDS_HUMAN_PLAN_REVIEW':
      return 'Plan iteration threshold exceeded';
    default:
      return 'Unknown flagged reason';
  }
}

export function getNextStatus(currentStatus: TicketStatus): TicketStatus | null {
  const allowed = transitions[currentStatus];
  return allowed.length > 0 ? allowed[0] : null;
}

// Unblock target state mapping
interface UnblockMapping {
  back: TicketStatus;
  forward: TicketStatus;
  forwardWithSubtasks?: TicketStatus;
}

const unblockMap: Partial<Record<TicketStatus, UnblockMapping>> = {
  'NEEDS_HUMAN_INTERVENTION': { back: 'NEEDS_IMPLEMENTATION_UPDATE', forward: 'NEEDS_REVIEW' },
  'NEEDS_HUMAN_CLARIFICATION': { back: 'NEEDS_IMPLEMENTATION_UPDATE', forward: 'NEEDS_REVIEW' },
  'NEEDS_HUMAN_PLAN_REVIEW': { back: 'NEEDS_PLAN_UPDATING', forward: 'NEEDS_IMPLEMENTING', forwardWithSubtasks: 'NEEDS_SUBTICKETS_PROCESSED' },
};

export function getUnblockTarget(flaggedStatus: TicketStatus, direction: 'back' | 'forward', hasSubtasks?: boolean): TicketStatus {
  const mapping = unblockMap[flaggedStatus];
  if (!mapping) {
    throw new Error(`Cannot unblock from non-flagged status: ${flaggedStatus}`);
  }
  if (direction === 'forward' && hasSubtasks && mapping.forwardWithSubtasks) {
    return mapping.forwardWithSubtasks;
  }
  return mapping[direction];
}

export function getStatusOrder(): TicketStatus[] {
  return [
    'NEEDS_REFINEMENT',
    'NEEDS_PLAN',
    'READY_PLAN_REVIEW',
    'NEEDS_PLAN_UPDATING',
    'NEEDS_IMPLEMENTING',
    'NEEDS_SUBTICKETS_PROCESSED',
    'NEEDS_VALIDATION',
    'NEEDS_IMPLEMENTATION_UPDATE',
    'NEEDS_REVIEW',
    'NEEDS_SECURITY_REVIEW',
    'NEEDS_QA',
    'NEEDS_PR',
    'NEEDS_GIT_MERGE',
    'NEEDS_PR_MAINTENANCE',
    'NEEDS_FINALIZING',
    'NEEDS_CLEANUP',
    'DONE',
    'NEEDS_HUMAN_INTERVENTION',
    'NEEDS_HUMAN_CLARIFICATION',
    'NEEDS_HUMAN_PLAN_REVIEW',
  ];
}

export function canTransitionToDone(status: TicketStatus): boolean {
  return transitions[status].includes('DONE');
}
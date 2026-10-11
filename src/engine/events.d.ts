import type { WebSocket } from 'ws';
import { TicketStatus } from '../types/ticket.js';
import { Ticket } from '../db/schema.js';
import { Evidence } from '../db/schema.js';
import { Suggestion } from '../db/schema.js';
import { Deviation } from '../db/schema.js';
import { ValidationRun } from '../db/schema.js';
export type TicketEvent = {
    type: 'ticket:created';
    ticket: Ticket;
} | {
    type: 'ticket:status_changed';
    ticketId: string;
    from: TicketStatus;
    to: TicketStatus;
} | {
    type: 'ticket:flagged';
    ticketId: string;
    reason: string;
} | {
    type: 'validation:started';
    ticketId: string;
    checkCount: number;
} | {
    type: 'validation:completed';
    ticketId: string;
    passed: boolean;
    runs: ValidationRun[];
} | {
    type: 'evidence:added';
    evidence: Evidence;
} | {
    type: 'suggestion:added';
    suggestion: Suggestion;
} | {
    type: 'deviation:added';
    deviation: Deviation;
} | {
    type: 'subtask:created';
    subtask: Ticket;
    parentId: string;
} | {
    type: 'shutdown';
};
export interface WebSocketMessage {
    event: TicketEvent['type'];
    data: Omit<TicketEvent, 'type'>;
    timestamp: number;
}
export declare function broadcast(event: TicketEvent): void;
export declare function subscribe(client: WebSocket, repo?: string): void;
export declare function unsubscribe(client: WebSocket, repo?: string): void;
export declare function broadcastShutdown(): void;
//# sourceMappingURL=events.d.ts.map
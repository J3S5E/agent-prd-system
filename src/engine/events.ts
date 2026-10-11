import { TicketStatus } from '../types/ticket.js';
import { Ticket , Evidence , Suggestion , Deviation , ValidationRun } from '../db/schema.js';
import { db } from '../db/index.js';
import { apiLogs } from '../db/schema.js';

import type { WebSocket } from 'ws';

export type TicketEvent =
  | { type: 'ticket:created'; ticket: Ticket }
  | { type: 'ticket:status_changed'; ticketId: string; from: TicketStatus; to: TicketStatus }
  | { type: 'ticket:flagged'; ticketId: string; reason: string }
  | { type: 'validation:started'; ticketId: string; checkCount: number }
  | { type: 'validation:completed'; ticketId: string; passed: boolean; runs: ValidationRun[] }
  | { type: 'evidence:added'; evidence: Evidence }
  | { type: 'suggestion:added'; suggestion: Suggestion }
  | { type: 'deviation:added'; deviation: Deviation }
  | { type: 'subtask:created'; subtask: Ticket; parentId: string }
  | { type: 'ticket:lock_acquired'; ticketId: string; instanceId: string; lockType: string }
  | { type: 'ticket:lock_released'; ticketId: string; instanceId: string }
  | { type: 'ticket:lock_expired'; ticketId: string; instanceId: string }
  | { type: 'ralph:offline'; instanceId: string }
  | { type: 'ralph:registered'; instanceId: string; name: string; repo: string; status: string }
  | { type: 'shutdown' };

export interface WebSocketMessage {
  event: TicketEvent['type'];
  data: Omit<TicketEvent, 'type'>;
  timestamp: number;
}

const subscribers = new Map<string, Set<WebSocket>>();

export function broadcast(event: TicketEvent): void {
  const { type, ...data } = event;
  const message: WebSocketMessage = {
    event: type,
    data,
    timestamp: Date.now(),
  };
  
  const messageStr = JSON.stringify(message);
  
  // Log event to database (fire-and-forget)
  let ticketId: string | null = null;
  if ('ticketId' in data && typeof data.ticketId === 'string') {
    ticketId = data.ticketId;
  } else if ('subtask' in data && typeof data.subtask === 'object' && data.subtask !== null && 'id' in data.subtask) {
    ticketId = (data.subtask as { id: string }).id;
  }
  
  db.insert(apiLogs).values({
    id: crypto.randomUUID(),
    eventType: type,
    eventData: JSON.stringify(data),
    ticketId,
    createdAt: Date.now(),
  }).catch(err => console.error('Event log write failed:', err));
  
  for (const [repo, clients] of subscribers.entries()) {
    const repoFromEvent = getRepoFromEvent(event);
    if (repo === '*' || repo === repoFromEvent) {
      for (const client of clients) {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(messageStr);
        }
      }
    }
  }
}

function getRepoFromEvent(event: TicketEvent): string {
  if ('ticket' in event) return event.ticket.repo;
  if ('subtask' in event) return event.subtask.repo;
  if ('evidence' in event) return ''; // would need to look up
  if ('suggestion' in event) return ''; // would need to look up
  if ('deviation' in event) return ''; // would need to look up
  return '';
}

export function subscribe(client: WebSocket, repo?: string): void {
  const key = repo || '*';
  if (!subscribers.has(key)) {
    subscribers.set(key, new Set());
  }
  subscribers.get(key)!.add(client);
}

export function unsubscribe(client: WebSocket, repo?: string): void {
  const key = repo || '*';
  const clients = subscribers.get(key);
  if (clients) {
    clients.delete(client);
    if (clients.size === 0) {
      subscribers.delete(key);
    }
  }
}

export function broadcastShutdown(): void {
  const message: WebSocketMessage = {
    event: 'shutdown',
    data: {},
    timestamp: Date.now(),
  };
  const messageStr = JSON.stringify(message);
  
  for (const clients of subscribers.values()) {
    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(messageStr);
      }
    }
  }
}
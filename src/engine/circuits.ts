import { eq, sql } from 'drizzle-orm';


import { db } from '../db/index.js';
import { tickets } from '../db/schema.js';
import { TicketStatus } from '../types/ticket.js';
import * as schema from '../db/schema.js';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type Database = BetterSQLite3Database<typeof schema>;

export interface CircuitBreakerState {
  validationAttempts: number;
  implementationRetryCount: number;
  planIteration: number;
  hasBlockingIssues: boolean;
}

export interface CircuitBreakerFunctions {
  getCircuitBreakerState: (ticketId: string) => Promise<CircuitBreakerState | null>;
  checkValidationCircuitBreaker: (state: CircuitBreakerState) => { tripped: boolean; targetStatus?: TicketStatus };
  checkImplementationCircuitBreaker: (state: CircuitBreakerState) => { tripped: boolean; targetStatus?: TicketStatus };
  checkPlanCircuitBreaker: (state: CircuitBreakerState) => { tripped: boolean; targetStatus?: TicketStatus };
  incrementValidationAttempts: (ticketId: string) => Promise<void>;
  incrementImplementationRetry: (ticketId: string) => Promise<void>;
  incrementPlanIteration: (ticketId: string) => Promise<void>;
  resetImplementationRetry: (ticketId: string) => Promise<void>;
  resetValidationAttempts: (ticketId: string) => Promise<void>;
}

export function createCircuitBreaker(db: Database): CircuitBreakerFunctions {
  return {
    async getCircuitBreakerState(ticketId: string): Promise<CircuitBreakerState | null> {
      const ticket = await db
        .select({
          validationAttempts: tickets.validationAttempts,
          implementationRetryCount: tickets.implementationRetryCount,
          planIteration: tickets.planIteration,
          blockingIssues: tickets.blockingIssues,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1);
      
      if (ticket.length === 0) return null;
      
      return {
        validationAttempts: ticket[0].validationAttempts ?? 0,
        implementationRetryCount: ticket[0].implementationRetryCount ?? 0,
        planIteration: ticket[0].planIteration ?? 0,
        hasBlockingIssues: ticket[0].blockingIssues != null && ticket[0].blockingIssues.trim().length > 0,
      };
    },

    checkValidationCircuitBreaker(state: CircuitBreakerState): { tripped: boolean; targetStatus?: TicketStatus } {
      if (state.validationAttempts >= 3) {
        return { tripped: true, targetStatus: 'NEEDS_HUMAN_INTERVENTION' };
      }
      return { tripped: false };
    },

    checkImplementationCircuitBreaker(state: CircuitBreakerState): { tripped: boolean; targetStatus?: TicketStatus } {
      if (state.implementationRetryCount >= 3) {
        return { tripped: true, targetStatus: 'NEEDS_HUMAN_CLARIFICATION' };
      }
      return { tripped: false };
    },

    checkPlanCircuitBreaker(state: CircuitBreakerState): { tripped: boolean; targetStatus?: TicketStatus } {
      if (!state.hasBlockingIssues && state.planIteration >= 3) {
        return { tripped: true, targetStatus: 'NEEDS_IMPLEMENTING' };
      }
      if (state.hasBlockingIssues && state.planIteration >= 6) {
        return { tripped: true, targetStatus: 'NEEDS_HUMAN_PLAN_REVIEW' };
      }
      return { tripped: false };
    },

    async incrementValidationAttempts(ticketId: string): Promise<void> {
      await db
        .update(tickets)
        .set({ validationAttempts: sql`${tickets.validationAttempts} + 1`, updatedAt: Date.now() })
        .where(eq(tickets.id, ticketId));
    },

    async incrementImplementationRetry(ticketId: string): Promise<void> {
      await db
        .update(tickets)
        .set({ implementationRetryCount: sql`${tickets.implementationRetryCount} + 1`, updatedAt: Date.now() })
        .where(eq(tickets.id, ticketId));
    },

    async incrementPlanIteration(ticketId: string): Promise<void> {
      await db
        .update(tickets)
        .set({ planIteration: sql`${tickets.planIteration} + 1`, updatedAt: Date.now() })
        .where(eq(tickets.id, ticketId));
    },

    async resetImplementationRetry(ticketId: string): Promise<void> {
      await db
        .update(tickets)
        .set({ implementationRetryCount: 0, updatedAt: Date.now() })
        .where(eq(tickets.id, ticketId));
    },

    async resetValidationAttempts(ticketId: string): Promise<void> {
      await db
        .update(tickets)
        .set({ validationAttempts: 0, updatedAt: Date.now() })
        .where(eq(tickets.id, ticketId));
    },
  };
}

// Default instance for production use
export const circuitBreaker = createCircuitBreaker(db);

// Re-export individual functions for backward compatibility
export const { 
  getCircuitBreakerState,
  checkValidationCircuitBreaker,
  checkImplementationCircuitBreaker,
  checkPlanCircuitBreaker,
  incrementValidationAttempts,
  incrementImplementationRetry,
  incrementPlanIteration,
  resetImplementationRetry,
  resetValidationAttempts,
} = circuitBreaker;
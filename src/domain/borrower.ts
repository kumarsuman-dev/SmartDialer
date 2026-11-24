/**
 * Borrower domain model for the SmartDialer system.
 * Represents a debt borrower to be contacted via outbound calling.
 */

/** Borrower disposition status */
export enum BorrowerStatus {
  PENDING = 'PENDING',
  RESERVED = 'RESERVED',
  IN_CALL = 'IN_CALL',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  DO_NOT_CALL = 'DO_NOT_CALL',
}

/** Borrower entity */
export interface Borrower {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  campaignId: string;
  status: BorrowerStatus;
  /** Higher priority = dialed first */
  priority: number;
  lastAttemptAt: number | null;
  attemptCount: number;
  maxAttempts: number;
  /** Worker ID that currently holds the reservation lock */
  lockedBy: string | null;
  /** Optimistic concurrency version */
  version: number;
}

/** Create a new borrower with default values */
export function createBorrower(
  id: string,
  name: string,
  phone: string,
  campaignId: string,
  priority: number = 0
): Borrower {
  return {
    id,
    name,
    phone,
    campaignId,
    status: BorrowerStatus.PENDING,
    priority,
    lastAttemptAt: null,
    attemptCount: 0,
    maxAttempts: 3,
    lockedBy: null,
    version: 0,
  };
}

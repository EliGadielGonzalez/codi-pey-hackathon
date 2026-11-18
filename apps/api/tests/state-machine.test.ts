import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isTerminalState,
  PAYMENT_INTENT_STATES,
  TERMINAL_STATES,
  type PaymentIntentState,
} from '../src/domain/state-machine.js';

const EXPECTED_VALID_EDGES: ReadonlyArray<[PaymentIntentState, PaymentIntentState]> = [
  ['CREATING', 'UNCERTAIN_CREATE'],
  ['CREATING', 'PENDING_PAYMENT'],
  ['UNCERTAIN_CREATE', 'PENDING_PAYMENT'],
  ['UNCERTAIN_CREATE', 'CANCELLED'],
  ['UNCERTAIN_CREATE', 'EXPIRED'],
  ['UNCERTAIN_CREATE', 'MANUAL_REVIEW'],
  ['PENDING_PAYMENT', 'PAID_VERIFIED'],
  ['PENDING_PAYMENT', 'EXPIRED'],
  ['PENDING_PAYMENT', 'MANUAL_REVIEW'],
  ['PENDING_PAYMENT', 'CANCELLED'],
  ['PAID_VERIFIED', 'APPLIED'],
  ['PAID_VERIFIED', 'PENDING_CAJA'],
  ['PAID_VERIFIED', 'MANUAL_REVIEW'],
  ['PENDING_CAJA', 'APPLIED'],
  ['PENDING_CAJA', 'MANUAL_REVIEW'],
  ['EXPIRED', 'MANUAL_REVIEW'],
  ['MANUAL_REVIEW', 'APPLIED'],
  ['MANUAL_REVIEW', 'REFUNDED_MANUAL'],
];

const VALID_EDGE_SET = new Set(
  EXPECTED_VALID_EDGES.map(([from, to]) => `${from}->${to}`),
);

describe('payment intent state machine', () => {
  it.each(EXPECTED_VALID_EDGES)(
    'allows valid transition %s -> %s',
    (from, to) => {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    },
  );

  it('rejects every state pair outside the allowed transition graph', () => {
    let invalidCount = 0;
    for (const from of PAYMENT_INTENT_STATES) {
      for (const to of PAYMENT_INTENT_STATES) {
        if (VALID_EDGE_SET.has(`${from}->${to}`)) continue;
        invalidCount += 1;
        expect(canTransition(from, to)).toBe(false);
        expect(() => assertTransition(from, to)).toThrowError(
          InvalidTransitionError,
        );
        try {
          assertTransition(from, to);
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidTransitionError);
          expect((err as InvalidTransitionError).from).toBe(from);
          expect((err as InvalidTransitionError).to).toBe(to);
        }
      }
    }
    expect(invalidCount).toBe(
      PAYMENT_INTENT_STATES.length * PAYMENT_INTENT_STATES.length -
        EXPECTED_VALID_EDGES.length,
    );
  });

  it('forbids backward regressions such as out-of-order processing events', () => {
    expect(canTransition('APPLIED', 'PENDING_PAYMENT')).toBe(false);
    expect(canTransition('PAID_VERIFIED', 'PENDING_PAYMENT')).toBe(false);
    expect(canTransition('PENDING_CAJA', 'PAID_VERIFIED')).toBe(false);
    expect(canTransition('PENDING_CAJA', 'PENDING_PAYMENT')).toBe(false);
    expect(canTransition('MANUAL_REVIEW', 'PENDING_PAYMENT')).toBe(false);
    expect(canTransition('EXPIRED', 'PAID_VERIFIED')).toBe(false);
  });

  it('enforces terminal states APPLIED, REFUNDED_MANUAL, and CANCELLED have zero outgoing edges', () => {
    expect([...TERMINAL_STATES].sort()).toEqual([
      'APPLIED',
      'CANCELLED',
      'REFUNDED_MANUAL',
    ]);

    for (const terminal of TERMINAL_STATES) {
      expect(isTerminalState(terminal)).toBe(true);
      for (const target of PAYMENT_INTENT_STATES) {
        expect(canTransition(terminal, target)).toBe(false);
        expect(() => assertTransition(terminal, target)).toThrow(
          InvalidTransitionError,
        );
      }
    }
  });
});

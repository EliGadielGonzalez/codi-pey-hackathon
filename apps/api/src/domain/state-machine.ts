export const PAYMENT_INTENT_STATES = [
  'CREATING',
  'UNCERTAIN_CREATE',
  'PENDING_PAYMENT',
  'PAID_VERIFIED',
  'PENDING_CAJA',
  'APPLIED',
  'MANUAL_REVIEW',
  'EXPIRED',
  'REFUNDED_MANUAL',
  'CANCELLED',
] as const;

export type PaymentIntentState = (typeof PAYMENT_INTENT_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<PaymentIntentState> = new Set([
  'APPLIED',
  'REFUNDED_MANUAL',
  'CANCELLED',
]);

const VALID_TRANSITIONS: Readonly<
  Record<PaymentIntentState, ReadonlySet<PaymentIntentState>>
> = {
  CREATING: new Set(['UNCERTAIN_CREATE', 'PENDING_PAYMENT']),
  UNCERTAIN_CREATE: new Set([
    'PENDING_PAYMENT',
    'CANCELLED',
    'EXPIRED',
    'MANUAL_REVIEW',
  ]),
  PENDING_PAYMENT: new Set([
    'PAID_VERIFIED',
    'EXPIRED',
    'MANUAL_REVIEW',
    'CANCELLED',
  ]),
  PAID_VERIFIED: new Set(['APPLIED', 'PENDING_CAJA', 'MANUAL_REVIEW']),
  PENDING_CAJA: new Set(['APPLIED', 'MANUAL_REVIEW']),
  EXPIRED: new Set(['MANUAL_REVIEW']),
  MANUAL_REVIEW: new Set(['APPLIED', 'REFUNDED_MANUAL', 'CANCELLED']),
  APPLIED: new Set(),
  REFUNDED_MANUAL: new Set(),
  CANCELLED: new Set(),
};

export class InvalidTransitionError extends Error {
  readonly from: PaymentIntentState;
  readonly to: PaymentIntentState;

  constructor(from: PaymentIntentState, to: PaymentIntentState) {
    super(`Invalid payment intent state transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function isPaymentIntentState(value: string): value is PaymentIntentState {
  return (PAYMENT_INTENT_STATES as readonly string[]).includes(value);
}

export function isTerminalState(state: PaymentIntentState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Pure transition predicate enforcing monotonic forward state progression.
 */
export function canTransition(
  from: PaymentIntentState,
  to: PaymentIntentState,
): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

/**
 * Validates a state transition and throws `InvalidTransitionError` if disallowed.
 */
export function assertTransition(
  from: PaymentIntentState,
  to: PaymentIntentState,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

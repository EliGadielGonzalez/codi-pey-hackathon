import { z } from 'zod';

// [P] validar contra OpenAPI: esquemas y tipos provisionales del API de Pey.

export interface PeyAmountBreakdown {
  base?: number;
  [key: string]: unknown;
}

export interface PeyTransaction {
  id?: string;
  transactionId?: string;
  type?: string;
  status?: string;
  amount?: number;
  amountBreakdown?: PeyAmountBreakdown;
  paymentMethod?: string;
  numRef?: string;
  clientReferenceId?: string;
  datePaid?: string;
  createdAt?: string;
  expiration?: string;
  bankAccountId?: string;
  [key: string]: unknown;
}

export interface PeyVerifyPayload {
  id?: string;
  type?: string;
  object?: string;
  status?: string;
  amount?: number;
  amountBreakdown?: PeyAmountBreakdown;
  paymentMethod?: string;
  numRef?: string;
  clientReferenceId?: string;
  datePaid?: string;
  createdAt?: string;
  expiration?: string;
  bankAccountId?: string;
  transactions?: PeyTransaction[];
  [key: string]: unknown;
}

// [P] validar contra OpenAPI: payloads de creacion y lectura de Pey.
export interface PeyCreateCodiQrInput {
  amount: number;
  clientReferenceId: string;
  concept?: string;
  bankAccountId?: string;
  expiration?: string;
  numRef?: string;
}

export interface PeyCreateCodiPushInput {
  amount: number;
  phone: string;
  clientReferenceId: string;
  concept?: string;
  bankAccountId?: string;
  expiration?: string;
  numRef?: string;
}

export interface PeyCreatePaymentLinkInput {
  amount: number;
  clientReferenceId: string;
  concept?: string;
  bankAccountId?: string;
  expiration?: string;
  paymentMethods?: string[];
}

export interface PeyResourceResponse {
  id: string;
  status?: string;
  type?: string;
  url?: string;
  qrPayload?: string;
  amount?: number;
  amountBreakdown?: PeyAmountBreakdown;
  paymentMethod?: string;
  numRef?: string;
  clientReferenceId?: string;
  datePaid?: string;
  createdAt?: string;
  expiration?: string;
  bankAccountId?: string;
  transactions?: PeyTransaction[];
  [key: string]: unknown;
}

export interface PeyCodiQrTransactionsResponse {
  id?: string;
  transactions?: PeyTransaction[];
  [key: string]: unknown;
}

export const PeyBankAccountStatusSchema = z.enum([
  'BORRADOR',
  'PENDING',
  'PROCESSING',
  'ACTIVE',
  'ERROR',
]);

export type PeyBankAccountStatus = z.infer<typeof PeyBankAccountStatusSchema>;

const NO_18_DIGIT_PATTERN = /(?<!\d)\d{18}(?!\d)/;

// [P] validar contra OpenAPI: registro de cuenta bancaria sin exponer CLABE completa en claro.
export const PeyRegisterBankAccountInputSchema = z
  .object({
    clabeLast4: z.string().regex(/^\d{4}$/, 'clabeLast4 debe tener exactamente 4 dígitos'),
    alias: z.string().trim().min(1).max(80),
    holderName: z.string().trim().min(1).max(120),
    clabeTokenOrEnvRef: z.string().trim().min(1).max(160).optional(),
  })
  .refine(
    (data) =>
      !NO_18_DIGIT_PATTERN.test(data.alias) &&
      !NO_18_DIGIT_PATTERN.test(data.holderName) &&
      (!data.clabeTokenOrEnvRef || !NO_18_DIGIT_PATTERN.test(data.clabeTokenOrEnvRef)),
    {
      message: 'No se permite enviar CLABE de 18 dígitos en claro',
    },
  );

export type PeyRegisterBankAccountInput = z.infer<typeof PeyRegisterBankAccountInputSchema>;

export interface PeyBankAccountResponse {
  id: string;
  bankAccountId?: string;
  status?: PeyBankAccountStatus | (string & {});
  clabeMasked?: string;
  alias?: string;
  holderName?: string;
  errorMessage?: string | null;
  [key: string]: unknown;
}

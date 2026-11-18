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

export const BANXICO_CLABE_WEIGHTS = [3, 7, 1] as const;

export const BANXICO_BANK_CODES: Record<string, string> = {
  '002': 'Citibanamex',
  '012': 'BBVA México',
  '014': 'Santander',
  '021': 'HSBC',
  '036': 'Inbursa',
  '044': 'Scotiabank',
  '058': 'Banregio',
  '072': 'Banorte',
  '127': 'Banco Azteca',
  '646': 'STP',
};

export type BanxicoClabeValidationReason =
  | 'empty'
  | 'non_numeric'
  | 'invalid_length'
  | 'invalid_bank_code'
  | 'check_digit_mismatch';

export interface BanxicoClabeValidationResult {
  valid: boolean;
  reason?: BanxicoClabeValidationReason;
  bankCode?: string;
  bankName?: string;
  last4?: string;
  masked?: string;
  expectedCheckDigit?: number;
  actualCheckDigit?: number;
}

export function computeClabeCheckDigit(first17: string): number {
  if (!/^\d{17}$/.test(first17)) {
    throw new Error('first17 must be exactly 17 numeric digits');
  }
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const digit = Number(first17[i]);
    const weight = BANXICO_CLABE_WEIGHTS[i % 3];
    sum += (digit * weight) % 10;
  }
  return (10 - (sum % 10)) % 10;
}

export function maskClabeLast4(clabeOrLast4: string): string {
  const digits = clabeOrLast4.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `****${last4}`;
}

export function validateBanxicoClabe(rawClabe: string): BanxicoClabeValidationResult {
  const cleaned = rawClabe.replace(/[\s-]+/g, '');
  if (!cleaned) {
    return { valid: false, reason: 'empty' };
  }
  if (!/^\d+$/.test(cleaned)) {
    return { valid: false, reason: 'non_numeric' };
  }
  if (cleaned.length !== 18) {
    return { valid: false, reason: 'invalid_length' };
  }

  const bankCode = cleaned.slice(0, 3);
  const bankName = BANXICO_BANK_CODES[bankCode];
  const last4 = cleaned.slice(-4);
  const masked = `****${last4}`;

  if (bankCode === '000') {
    return {
      valid: false,
      reason: 'invalid_bank_code',
      bankCode,
      bankName,
      last4,
      masked,
    };
  }

  const expectedCheckDigit = computeClabeCheckDigit(cleaned.slice(0, 17));
  const actualCheckDigit = Number(cleaned[17]);

  if (actualCheckDigit !== expectedCheckDigit) {
    return {
      valid: false,
      reason: 'check_digit_mismatch',
      bankCode,
      bankName,
      last4,
      masked,
      expectedCheckDigit,
      actualCheckDigit,
    };
  }

  return {
    valid: true,
    bankCode,
    bankName,
    last4,
    masked,
    expectedCheckDigit,
    actualCheckDigit,
  };
}

export function isValidBanxicoClabe(rawClabe: string): boolean {
  return validateBanxicoClabe(rawClabe).valid;
}

export interface DemoClinicBankPreset {
  key: 'bbva' | 'azteca';
  clabeLast4: string;
  clabeMasked: string;
  bankCode: string;
  bankName: string;
  alias: string;
  holderName: string;
  clabeTokenOrEnvRef: string;
}

export const DEMO_CLINIC_BANK_PRESETS: readonly DemoClinicBankPreset[] = [
  {
    key: 'bbva',
    clabeLast4: '6252',
    clabeMasked: '****6252',
    bankCode: '012',
    bankName: 'BBVA México',
    alias: 'Cuenta Clínica BBVA (Principal)',
    holderName: 'Clínica Veterinaria Demo KADI (BBVA)',
    clabeTokenOrEnvRef: 'ENV:PEY_DEMO_CLABE_BBVA',
  },
  {
    key: 'azteca',
    clabeLast4: '0385',
    clabeMasked: '****0385',
    bankCode: '127',
    bankName: 'Banco Azteca',
    alias: 'Cuenta Clínica Azteca (Sucursal)',
    holderName: 'Clínica Veterinaria Demo KADI (Azteca)',
    clabeTokenOrEnvRef: 'ENV:PEY_DEMO_CLABE_AZTECA',
  },
] as const;

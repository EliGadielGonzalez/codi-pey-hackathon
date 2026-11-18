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

export interface PeyBankAccountResponse {
  id: string;
  bankAccountId?: string;
  status?: string;
  [key: string]: unknown;
}

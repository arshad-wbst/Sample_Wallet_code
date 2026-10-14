import { createHash } from 'node:crypto';
import { createPool } from '../config/database.js';
import { transaction } from '../helpers/transaction.js';
import { AppError } from '../helpers/errors.js';

// Transaction types and actions
export const TRANSACTION_ACTION = Object.freeze({
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
});

// Transaction types for wallet operations
export const TRANSACTION_TYPE = Object.freeze({
  BET: 'BET',
  WIN: 'WIN',
  REFUND: 'REFUND',
  REVERSAL: 'REVERSAL',
  DEPOSIT: 'DEPOSIT',
});

// Maximum wallet balance in minor units (e.g., cents)
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

// Allowed fields for transaction input validation
const allowedFields = new Set([
  'userId',
  'currency',
  'amount',
  'transactionId',
  'transactionType',
  'transactionAction',
  'referenceTransactionId',
  'gameId',
  'roundId',
  'provider',
  'metadata',
]);

// Helper function to throw an AppError with a specific code, message, and status
function fail(code, message, status = 409) {
  throw new AppError(status, code, message);
}


// Validate IDs used in the transaction
function identifier(value, field, optional = false) {
  if (optional && (value === null || value === undefined)) {
    return null;
  }

  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value)) {
    fail(
      'INVALID_INPUT',
      `${field} must be a valid identifier of 1-100 characters`,
      400
    );
  }

  return value;
}


// Validate wallet currency
function currencyCode(value) {
  if (typeof value !== 'string' || !/^[A-Z]{2,3}$/.test(value)) {
    fail(
      'INVALID_CURRENCY',
      'Invalid currency code',
      400
    );
  }

  return value;
}


// Validate transaction amount
function money(value, allowZero = false) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail(
      'INVALID_AMOUNT',
      'Amount must be an integer in minor units within the safe range',
      400
    );
  }

  return value;
}


// Keep metadata format same for duplicate request check.
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      )
      .join(',')
      }}`;
  }

  fail(
    'INVALID_METADATA',
    'Metadata must contain JSON values',
    400
  );
}

// Validate transaction input
function validate(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some((key) => !allowedFields.has(key))) {
    fail(
      'INVALID_INPUT',
      'Unknown or invalid request fields',
      400
    );
  }

  // Validate transaction type
  const transactionType = input.transactionType;

  // Validate transaction action
  const transactionAction = input.transactionAction;

  if (!Object.values(TRANSACTION_TYPE).includes(transactionType)) {
    fail(
      'INVALID_TYPE',
      'Invalid transaction type',
      400
    );
  }

  // Determine expected transaction action
  const expectedAction = transactionType === TRANSACTION_TYPE.BET ? TRANSACTION_ACTION.DEBIT : TRANSACTION_ACTION.CREDIT;

  // Reversal action comes from the original transaction
  if (transactionType === TRANSACTION_TYPE.REVERSAL) {
    if (transactionAction !== undefined && !Object.values(TRANSACTION_ACTION).includes(transactionAction)) {
      fail(
        'INVALID_ACTION',
        'Invalid transaction action',
        400
      );
    }
  } else if (transactionAction !== expectedAction) {
    fail(
      'INVALID_ACTION',
      'Action does not match transaction type',
      400
    );
  }

  defaultDbConnect = undefined;
  defaultWalletService = undefined;
}
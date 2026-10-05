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

  // Refund and reversal amount comes from the original transaction
  const derivedAmount = [
    TRANSACTION_TYPE.REFUND,
    TRANSACTION_TYPE.REVERSAL,
  ].includes(transactionType);

  if (derivedAmount && input.amount !== undefined) {
    fail(
      'INVALID_AMOUNT',
      'Refund and reversal amounts come from the original transaction',
      400
    );
  }

  const referenceTransactionId = identifier(
    input.referenceTransactionId,
    'referenceTransactionId',
    [
      TRANSACTION_TYPE.BET,
      TRANSACTION_TYPE.DEPOSIT,
    ].includes(transactionType)
  );

  // Bet and deposit should not have a reference transaction
  if ([TRANSACTION_TYPE.BET, TRANSACTION_TYPE.DEPOSIT].includes(transactionType) && referenceTransactionId !== null) {
    fail(
      'INVALID_REFERENCE',
      'This transaction cannot have a reference',
      400
    );
  }

  // Validate metadata
  const metadata = input.metadata ?? {};

  if (!metadata || Object.getPrototypeOf(metadata) !== Object.prototype) {
    fail(
      'INVALID_METADATA',
      'Metadata must be a JSON object',
      400
    );
  }

  // Validate metadata JSON
  let metadataJson;

  try {
    metadataJson = canonicalJson(metadata);
  } catch {
    fail(
      'INVALID_METADATA',
      'Metadata must be a finite JSON object without cycles',
      400
    );
  }

  if (Buffer.byteLength(metadataJson) > 8192) {
    fail(
      'INVALID_METADATA',
      'Metadata exceeds 8 KB',
      400
    );
  }

  return {
    userId: identifier(
      input.userId,
      'userId'
    ),

    currency: currencyCode(
      input.currency
    ),

    transactionId: identifier(
      input.transactionId,
      'transactionId'
    ),

    type: transactionType,

    action: transactionAction ?? null,

    amount: derivedAmount
      ? null
      : money(
        input.amount,
        transactionType === TRANSACTION_TYPE.WIN
      ),

    reference: referenceTransactionId,

    gameId: identifier(
      input.gameId,
      'gameId',
      true
    ),

    roundId: identifier(
      input.roundId,
      'roundId',
      true
    ),

    provider: identifier(
      input.provider,
      'provider',
      true
    ),

    metadataJson,
  };
}


// Format transaction response
function result(row, duplicate = false) {
  return {
    success: true,
    duplicate,

    balance: Number(
      row.balance_after
    ),

    transaction: {
      ...row,
      amount: Number(row.amount),
      balance_before: Number(
        row.balance_before
      ),
      balance_after: Number(
        row.balance_after
      ),
    },
  };
}


export function createWalletService(dbConnect) {

  // Create wallet if it does not exist
  async function createWallet({
    userId,
    currency,
  }) {
    const validUserId = identifier(
      userId,
      'userId'
    );

    const validCurrency = currencyCode(
      currency
    );

    await dbConnect.query(
      `
        INSERT INTO walletnew.wallets (
          user_id,
          currency
        )
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [
        validUserId,
        validCurrency,
      ]
    );

    return getBalance({
      userId: validUserId,
      currency: validCurrency,
    });
  }


  // Get current wallet balance
  async function getBalance({
    userId,
    currency,
  }) {
    const validUserId = identifier(
      userId,
      'userId'
    );

    const validCurrency = currencyCode(
      currency
    );

    const balanceResult =
      await dbConnect.query(
        `
          SELECT balance
          FROM walletnew.wallets
          WHERE user_id = $1
            AND currency = $2
        `,
        [
          validUserId,
          validCurrency,
        ]
      );

    if (!balanceResult.rows[0]) {
      fail(
        'WALLET_NOT_FOUND',
        'Wallet not found',
        404
      );
    }

    return {
      userId: validUserId,
      currency: validCurrency,
      balance: Number(
        balanceResult.rows[0].balance
      ),
    };
  }


  // Handle wallet debit and credit
  async function updateBalance(input) {
    const request = validate(input);

    // Create fingerprint to handle duplicate requests
    const fingerprint = createHash('sha256')
      .update(canonicalJson(request))
      .digest('hex');

    return transaction(
      dbConnect,
      async (databaseClient) => {

        // Lock wallet while processing the transaction
        const walletResult =
          await databaseClient.query(
            `
              SELECT id, balance
              FROM walletnew.wallets
              WHERE user_id = $1
                AND currency = $2
              FOR UPDATE
            `,
            [
              request.userId,
              request.currency,
            ]
          );

        const wallet =
          walletResult.rows[0];

        if (!wallet) {
          fail(
            'WALLET_NOT_FOUND',
            'Wallet not found',
            404
          );
        }


        // Check if transaction is already processed
        const previousTransactionResult =
          await databaseClient.query(
            `
              SELECT *
              FROM walletnew.transactions
              WHERE wallet_id = $1
                AND transaction_id = $2
            `,
            [
              wallet.id,
              request.transactionId,
            ]
          );

        const previousTransaction =
          previousTransactionResult.rows[0];

        if (previousTransaction) {

          // Same transaction ID should not be used with different data
          if (previousTransaction.fingerprint !== fingerprint) {
            fail(
              'IDEMPOTENCY_CONFLICT',
              'Transaction ID was used with different details'
            );
          }

          return result(
            previousTransaction,
            true
          );
        }


        let originalTransaction;
        let betTransactionId;
        let nextBetStatus;

        let transactionAmount =
          request.amount;

        let transactionAction =
          request.action;


        // Get original transaction for win, refund or reversal
        if (request.reference) {
          const originalTransactionResult =
            await databaseClient.query(
              `
                SELECT *
                FROM walletnew.transactions
                WHERE wallet_id = $1
                  AND transaction_id = $2
              `,
              [
                wallet.id,
                request.reference,
              ]
            );

          originalTransaction =
            originalTransactionResult.rows[0];

          if (!originalTransaction) {
            fail(
              'TRANSACTION_NOT_FOUND',
              'Original transaction not found in this wallet',
              404
            );
          }


          // Provider should match with the original transaction
          if (originalTransaction.provider !== request.provider) {
            fail(
              'PROVIDER_MISMATCH',
              'Provider must match the original transaction'
            );
          }


          // Check game and round details with original transaction
          for (const [field, column] of [
            ['gameId', 'game_id'],
            ['roundId', 'round_id'],
          ]) {
            if (request[field] !== null && request[field] !== originalTransaction[column]) {
              fail(
                'REFERENCE_MISMATCH',
                `${field} does not match the original transaction`
              );
            }
          }


          if (request.type === TRANSACTION_TYPE.REVERSAL) {

            // Only bet, win and deposit can be reversed
            if (
              ![
                TRANSACTION_TYPE.BET,
                TRANSACTION_TYPE.WIN,
                TRANSACTION_TYPE.DEPOSIT,
              ].includes(
                originalTransaction.transaction_type
              )
            ) {
              fail(
                'INVALID_REVERSAL',
                'Refunds and reversals cannot be reversed'
              );
            }


            // Check if transaction is already reversed
            const reversalResult =
              await databaseClient.query(
                `
                  SELECT id
                  FROM walletnew.transactions
                  WHERE reference_id = $1
                    AND transaction_type = 'REVERSAL'
                `,
                [
                  originalTransaction.id,
                ]
              );

            if (reversalResult.rowCount) {
              fail(
                'ALREADY_REVERSED',
                'Transaction has already been reversed'
              );
            }


            // Reversal uses the original transaction amount
            transactionAmount = Number(
              originalTransaction.amount
            );


            // Reverse the original debit/credit action
            transactionAction =
              originalTransaction.transaction_action ===
                TRANSACTION_ACTION.DEBIT
                ? TRANSACTION_ACTION.CREDIT
                : TRANSACTION_ACTION.DEBIT;


            if (request.action !== null && request.action !== transactionAction) {
              fail(
                'INVALID_ACTION',
                'Reversal action must oppose the original transaction',
                400
              );
            }


            if (originalTransaction.transaction_type === TRANSACTION_TYPE.BET) {
              betTransactionId = originalTransaction.id;

              nextBetStatus = 'REVERSED';
            } else if (originalTransaction.transaction_type === TRANSACTION_TYPE.WIN) {
              betTransactionId = originalTransaction.reference_id;

              nextBetStatus = 'WIN_REVERSED';
            }
          } else {

            // Win and refund should reference the original bet
            if (
              originalTransaction.transaction_type !==
              TRANSACTION_TYPE.BET ||
              originalTransaction.transaction_action !==
              TRANSACTION_ACTION.DEBIT
            ) {
              fail(
                'INVALID_REFERENCE',
                'A bet transaction is required'
              );
            }

            betTransactionId =
              originalTransaction.id;

            nextBetStatus =
              request.type ===
                TRANSACTION_TYPE.WIN
                ? 'SETTLED'
                : 'REFUNDED';


            // Refund the original bet amount
            if (request.type === TRANSACTION_TYPE.REFUND) {
              transactionAmount =
                Number(
                  originalTransaction.amount
                );
            }
          }


          // Check current bet status
          if (betTransactionId) {
            const betResult =
              await databaseClient.query(
                `
                  SELECT status
                  FROM walletnew.bets
                  WHERE transaction_id = $1
                `,
                [
                  betTransactionId,
                ]
              );

            const currentBetStatus =
              betResult.rows[0]?.status;

            let allowedStatuses;

            if (
              nextBetStatus === 'WIN_REVERSED'
            ) {
              allowedStatuses = [
                'SETTLED',
              ];
            } else if (
              nextBetStatus === 'REVERSED'
            ) {
              allowedStatuses = [
                'OPEN',
                'WIN_REVERSED',
              ];
            } else {
              allowedStatuses = [
                'OPEN',
              ];
            }

            if (
              !allowedStatuses.includes(
                currentBetStatus
              )
            ) {
              fail(
                'BET_CLOSED',
                'Bet is not eligible for this operation'
              );
            }
          }
        }


        // Calculate new balance
        const balanceBefore = BigInt(wallet.balance);

        const balanceChange =
          transactionAction === TRANSACTION_ACTION.DEBIT
            ? -BigInt(transactionAmount)
            : BigInt(transactionAmount);

        const balanceAfter = balanceBefore + balanceChange;

        // Balance should never go below zero
        if (balanceAfter < 0n) {
          fail(
            'INSUFFICIENT_BALANCE',
            'Insufficient balance'
          );
        }


        // Check maximum wallet balance
        if (balanceAfter > BigInt(MAX_AMOUNT)) {
          fail(
            'BALANCE_LIMIT',
            'Maximum wallet balance exceeded'
          );
        }


        // Update wallet balance
        const walletUpdateResult =
          await databaseClient.query(
            `
              UPDATE walletnew.wallets
              SET
                balance = balance + $1,
                updated_at = now()
              WHERE id = $2
                AND balance + $1
                  BETWEEN 0 AND 9007199254740991
              RETURNING balance
            `,
            [
              balanceChange.toString(),
              wallet.id,
            ]
          );


        if (!walletUpdateResult.rowCount) {
          fail(
            'BALANCE_CONFLICT',
            'Unable to update wallet balance'
          );
        }


        // Save transaction
        const transactionResult =
          await databaseClient.query(
            `
              INSERT INTO walletnew.transactions (
                wallet_id,
                transaction_id,
                fingerprint,
                reference_id,
                transaction_type,
                transaction_action,
                amount,
                balance_before,
                balance_after,
                game_id,
                round_id,
                provider,
                metadata
              )
              VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12, $13
              )
              RETURNING *
            `,
            [
              wallet.id,
              request.transactionId,
              fingerprint,
              originalTransaction?.id ?? null,
              request.type,
              transactionAction,
              transactionAmount,
              balanceBefore.toString(),
              balanceAfter.toString(),
              originalTransaction?.game_id ??
              request.gameId,
              originalTransaction?.round_id ??
              request.roundId,
              request.provider,
              request.metadataJson,
            ]
          );

        const savedTransaction =
          transactionResult.rows[0];


        // Create bet record
        if (request.type === TRANSACTION_TYPE.BET) {
          await databaseClient.query(
            `
              INSERT INTO walletnew.bets (
                transaction_id,
                status
              )
              VALUES ($1, 'OPEN')
            `,
            [
              savedTransaction.id,
            ]
          );
        } else if (betTransactionId) {

          // Update bet status
          await databaseClient.query(
            `
              UPDATE walletnew.bets
              SET status = $1
              WHERE transaction_id = $2
            `,
            [
              nextBetStatus,
              betTransactionId,
            ]
          );
        }


        return result(
          savedTransaction
        );
      }
    );
  }


  return {
    createWallet,
    getBalance,
    updateBalance,

    // Credit deposit amount
    creditDepositAmount: (input) =>
      updateBalance({
        ...input,
        transactionType:
          TRANSACTION_TYPE.DEPOSIT,
        transactionAction:
          TRANSACTION_ACTION.CREDIT,
      }),

    // Debit bet amount
    debitBetAmount: (input) =>
      updateBalance({
        ...input,
        transactionType:
          TRANSACTION_TYPE.BET,
        transactionAction:
          TRANSACTION_ACTION.DEBIT,
      }),

    // Credit win amount
    creditWinAmount: ({
      betTransactionId,
      ...input
    }) =>
      updateBalance({
        ...input,
        referenceTransactionId:
          betTransactionId,
        transactionType:
          TRANSACTION_TYPE.WIN,
        transactionAction:
          TRANSACTION_ACTION.CREDIT,
      }),

    // Refund bet amount
    refundBetAmount: ({
      betTransactionId,
      ...input
    }) =>
      updateBalance({
        ...input,
        referenceTransactionId:
          betTransactionId,
        transactionType:
          TRANSACTION_TYPE.REFUND,
        transactionAction:
          TRANSACTION_ACTION.CREDIT,
      }),

    // Reverse transaction
    reverseTransaction: (input) =>
      updateBalance({
        ...input,
        transactionType:
          TRANSACTION_TYPE.REVERSAL,
      }),
  };
}


let defaultDbConnect;
let defaultWalletService;


// Create default wallet service
function walletService() {
  if (!defaultWalletService) {
    defaultDbConnect = createPool(
      process.env.DATABASE_URL
    );

    defaultDbConnect.on(
      'error',
      (error) => {
        console.error(
          'Wallet database connection failed',
          {
            code: error.code,
          }
        );
      }
    );

    defaultWalletService =
      createWalletService(
        defaultDbConnect
      );
  }

  return defaultWalletService;
}


export const createWallet = (input) =>
  walletService().createWallet(input);


export const getBalance = (input) =>
  walletService().getBalance(input);


export const updateBalance = (input) =>
  walletService().updateBalance(input);


export const creditDepositAmount = (input) =>
  walletService().creditDepositAmount(
    input
  );


export const debitBetAmount = (input) =>
  walletService().debitBetAmount(
    input
  );


export const creditWinAmount = (input) =>
  walletService().creditWinAmount(
    input
  );


export const refundBetAmount = (input) =>
  walletService().refundBetAmount(
    input
  );


export const reverseTransaction = (input) =>
  walletService().reverseTransaction(
    input
  );


// Close DB connection
export async function closeWalletConnection() {
  if (defaultDbConnect) {
    await defaultDbConnect.end();
  }

  defaultDbConnect = undefined;
  defaultWalletService = undefined;
}
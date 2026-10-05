# Wallet & Ledger Service

## Overview

This module provides a secure wallet and transaction ledger service for handling user balances and financial transactions within a gaming/betting platform.

The service is designed to ensure:

* Accurate wallet balance management
* Atomic debit and credit operations
* Transaction-level auditability
* Duplicate transaction protection
* Concurrent transaction safety
* Bet lifecycle management
* Support for deposits, bets, wins, refunds, and reversals
* Multi-currency wallet support
* Referential integrity between related transactions

The implementation uses PostgreSQL transactions and row-level locking to prevent race conditions during simultaneous wallet operations.

---

## Core Wallet Operations

The service exposes the following primary operations:

| Operation               | Description                               |
| ----------------------- | ----------------------------------------- |
| `createWallet()`        | Creates a wallet for a user and currency  |
| `getBalance()`          | Returns the current wallet balance        |
| `creditDepositAmount()` | Credits a deposit into the wallet         |
| `debitBetAmount()`      | Debits the wallet when a bet is placed    |
| `creditWinAmount()`     | Credits winnings against an existing bet  |
| `refundBetAmount()`     | Refunds the original bet amount           |
| `reverseTransaction()`  | Reverses an eligible previous transaction |
| `updateBalance()`       | Core transaction-processing function      |

The service internally exposes convenience methods for common wallet operations while maintaining a single transaction-processing mechanism.

---

# Transaction Types

The ledger currently supports the following transaction types:

### 1. DEPOSIT

Represents money credited to the user's wallet.

**Action:** `CREDIT`

Example:

```text
User deposits $100
Wallet: $0 → $100
```

---

### 2. BET

Represents money deducted when a user places a bet.

**Action:** `DEBIT`

Example:

```text
Wallet: $100
Bet: $20
Wallet: $100 → $80
```

A new bet record is created with status `OPEN`.

---

### 3. WIN

Represents winnings credited to the user's wallet after a bet is settled.

**Action:** `CREDIT`

A win must reference the original bet transaction.

Example:

```text
Original Bet: $20
Win: $40
Wallet: $80 → $120
```

---

### 4. REFUND

Represents the return of the original bet amount.

**Action:** `CREDIT`

The refund amount is derived from the original bet rather than being independently supplied.

This prevents a caller from refunding an arbitrary amount.

---

### 5. REVERSAL

Used to reverse an existing eligible transaction.

A reversal automatically uses the original transaction amount and applies the opposite wallet action.

For example:

```text
Original BET
DEBIT $20

REVERSAL
CREDIT $20
```

The implementation also prevents a transaction from being reversed more than once.

---

# Ledger Structure

Each wallet transaction records important financial information including:

```text
transaction_id
reference_id
transaction_type
transaction_action
amount
balance_before
balance_after
game_id
round_id
provider
metadata
```

The `balance_before` and `balance_after` values provide a complete audit trail for each balance-changing operation.

This allows the ledger to answer questions such as:

* What transaction changed the balance?
* What was the balance before the transaction?
* What was the resulting balance?
* Which game/round generated the transaction?
* Which provider processed it?
* Which transaction was it related to?

---

# Transaction Flow

The standard transaction flow is:

```text
API Request
     |
     v
Input Validation
     |
     v
Generate Request Fingerprint
     |
     v
Begin Database Transaction
     |
     v
Lock Wallet Row
     |
     v
Check Existing Transaction
     |
     +---- Already Processed ---> Return Existing Transaction
     |
     v
Validate Reference Transaction
     |
     v
Calculate Balance Change
     |
     v
Validate Available Balance
     |
     v
Update Wallet Balance
     |
     v
Insert Ledger Transaction
     |
     v
Create / Update Bet Record
     |
     v
Commit Transaction
     |
     v
Return Updated Balance
```

All balance changes are processed inside a database transaction. The wallet row is locked using `FOR UPDATE` while the operation is being processed.

---

# Concurrency Protection

The service is designed to handle simultaneous requests safely.

Before modifying a wallet, the wallet record is locked:

```sql
SELECT id, balance
FROM walletnew.wallets
WHERE user_id = $1
  AND currency = $2
FOR UPDATE
```

This prevents two simultaneous requests from modifying the same wallet balance incorrectly.

Example:

```text
Initial Balance = $100

Request A → Bet $80
Request B → Bet $50

Without locking:
Both requests could potentially see $100.

With locking:
Request A → $100 → $20
Request B → sees $20 → rejected
```

The second transaction therefore cannot spend funds that have already been consumed by another transaction.

---

# Idempotency / Duplicate Transaction Protection

Every transaction request generates a SHA-256 fingerprint based on the normalized request data.

The service checks whether the same `transactionId` has already been processed.

### Same transaction + same data

The previous result is returned:

```json
{
  "success": true,
  "duplicate": true
}
```

### Same transaction ID + different data

The request is rejected with:

```text
IDEMPOTENCY_CONFLICT
```

## This protects the wallet from duplicate provider callbacks, retries, network failures, and repeated API requests.

# Balance Safety

The wallet service applies multiple balance protections.

## No Negative Balances

A debit transaction cannot reduce the wallet below zero.

```text
If:

Balance = $50
Bet = $60

Result:
INSUFFICIENT_BALANCE
```

The balance check is performed before updating the wallet.

## Maximum Balance

The implementation also prevents the wallet from exceeding JavaScript's safe integer range:

```text
9,007,199,254,740,991
```

Amounts are represented as integer minor units, such as cents, rather than floating-point currency values.
Example:

```text
$10.50 → 1050 cents
```

This avoids common floating-point calculation problems.

---

# Bet Lifecycle

The wallet ledger also maintains the state of betting transactions.

Typical lifecycle:

```text
OPEN
  |
  +---- WIN ----> SETTLED
  |
  +---- REFUND -> REFUNDED
  |
  +---- REVERSAL -> REVERSED
```

A win or refund can only reference an eligible original bet.

The service also validates that the bet is in an appropriate state before allowing settlement, refund, or reversal.

---

# Transaction Relationships

Transactions can reference previous transactions.

Example:

```text
BET
transaction_id = BET-1001
       |
       +------ WIN
       |       reference = BET-1001
       |
       +------ REFUND
       |       reference = BET-1001
       |
       +------ REVERSAL
               reference = BET-1001
```

This creates a traceable relationship between the original transaction and subsequent financial events.

For WIN and REFUND operations, the referenced transaction must be the original BET transaction.

---

# Provider Validation

For transactions referencing an existing transaction, the provider must match the provider associated with the original transaction.

This prevents a transaction from one gaming/payment provider from incorrectly modifying a transaction belonging to another provider.

Game and round information is also validated against the original transaction where applicable.

---

# Input Validation

The service validates all transaction inputs before processing.

Validated fields include:

```text
userId
currency
amount
transactionId
transactionType
transactionAction
referenceTransactionId
gameId
roundId
provider
metadata
```

Unknown fields are rejected.

## Currency codes must follow the supported uppercase format, and transaction identifiers are restricted to valid identifier characters.

# Metadata

Transactions can contain additional JSON metadata.

Example:

```json
{
  "ip": "192.168.1.10",
  "device": "mobile",
  "sessionId": "abc123",
  "source": "sportsbook"
}
```

Metadata is normalized before being used in the transaction fingerprint and is limited to 8 KB.

---

# Example Usage

## Create Wallet

```javascript
await createWallet({
  userId: "user-1001",
  currency: "USD"
});
```

---

## Deposit

```javascript
await creditDepositAmount({
  userId: "user-1001",
  currency: "USD",
  amount: 10000,
  transactionId: "DEP-1001",
  provider: "payment-provider"
});
```

The amount above represents `$100.00` when using cents as the minor unit.

---

## Place Bet

```javascript
await debitBetAmount({
  userId: "user-1001",
  currency: "USD",
  amount: 2000,
  transactionId: "BET-1001",
  gameId: "GAME-01",
  roundId: "ROUND-1001",
  provider: "game-provider"
});
```

Result:

```text
Balance Before: $100.00
Bet:            $20.00
Balance After:  $80.00
Bet Status:     OPEN
```

---

## Credit Win

```javascript
await creditWinAmount({
  userId: "user-1001",
  currency: "USD",
  amount: 4000,
  transactionId: "WIN-1001",
  betTransactionId: "BET-1001",
  gameId: "GAME-01",
  roundId: "ROUND-1001",
  provider: "game-provider"
});
```

The win references the original bet and changes its status to `SETTLED`.

---

## Refund Bet

```javascript
await refundBetAmount({
  userId: "user-1001",
  currency: "USD",
  transactionId: "REFUND-1001",
  betTransactionId: "BET-1001",
  provider: "game-provider"
});
```

The refund amount is automatically obtained from the original bet transaction.

---

## Reverse Transaction

```javascript
await reverseTransaction({
  userId: "user-1001",
  currency: "USD",
  transactionId: "REV-1001",
  referenceTransactionId: "BET-1001",
  provider: "game-provider"
});
```

The reversal automatically uses the original transaction amount and applies the opposite debit/credit action.

---

# Error Handling

The service uses structured application errors.

Examples include:

| Error Code              | Meaning                                         |
| ----------------------- | ----------------------------------------------- |
| `INVALID_INPUT`         | Invalid or unknown request fields               |
| `INVALID_CURRENCY`      | Invalid currency                                |
| `INVALID_AMOUNT`        | Invalid transaction amount                      |
| `INVALID_TYPE`          | Unsupported transaction type                    |
| `INVALID_ACTION`        | Incorrect debit/credit action                   |
| `WALLET_NOT_FOUND`      | Wallet does not exist                           |
| `TRANSACTION_NOT_FOUND` | Referenced transaction does not exist           |
| `INSUFFICIENT_BALANCE`  | Wallet does not have sufficient funds           |
| `IDEMPOTENCY_CONFLICT`  | Same transaction ID used with different data    |
| `PROVIDER_MISMATCH`     | Provider does not match original transaction    |
| `REFERENCE_MISMATCH`    | Game/round reference does not match             |
| `ALREADY_REVERSED`      | Transaction has already been reversed           |
| `BET_CLOSED`            | Bet is not eligible for the requested operation |
| `BALANCE_LIMIT`         | Maximum wallet balance exceeded                 |
| `BALANCE_CONFLICT`      | Wallet update could not be completed            |

---

# Database Components

The implementation expects the following logical database structures under the `walletnew` schema:

### `walletnew.wallets`

Stores the current wallet balance for each user and currency.

Key fields used by the service:

```text
id
user_id
currency
balance
updated_at
```

### `walletnew.transactions`

Stores the immutable financial transaction history.

Key fields include:

```text
id
wallet_id
transaction_id
fingerprint
reference_id
transaction_type
transaction_action
amount
balance_before
balance_after
game_id
round_id
provider
metadata
```

### `walletnew.bets`

Stores the lifecycle state of betting transactions.

Key fields:

```text
transaction_id
status
```

The service creates a bet record when a BET transaction is successfully processed and updates its status as the bet progresses.

---

# Security & Financial Integrity

The implementation incorporates several controls important for a wallet/ledger system:

1. **Atomic database transactions**
2. **Row-level wallet locking**
3. **Idempotent transaction processing**
4. **Duplicate transaction detection**
5. **Immutable transaction history**
6. **Reference transaction validation**
7. **Provider validation**
8. **Game and round consistency checks**
9. **Negative balance protection**
10. **Maximum balance protection**
11. **Strict input validation**
12. **Transaction fingerprints for request consistency**

These controls are intended to protect against duplicate callbacks, concurrent wallet updates, invalid references, and inconsistent betting operations.

---

# Architecture Summary

```text
                 ┌─────────────────────┐
                 │   Game / Sportsbook  │
                 │   Payment Provider   │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │   Wallet Service    │
                 │                     │
                 │ Validation          │
                 │ Idempotency         │
                 │ Reference Checks    │
                 │ Balance Calculation │
                 └──────────┬──────────┘
                            │
                     DB Transaction
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
        ┌──────────────┐        ┌────────────────┐
        │    Wallet    │        │    Ledger      │
        │   Balance    │        │  Transactions  │
        └──────────────┘        └────────────────┘
                │
                ▼
        ┌──────────────┐
        │     Bets     │
        │    Status    │
        └──────────────┘
```

---

# Important Implementation Notes

This README documents the behavior implemented in the supplied sample `wallet.service.js`.

The sample focuses on the **wallet and ledger service layer**. It does not, by itself, define:

* REST API routes
* Authentication/authorization
* Payment gateway integration
* KYC/AML processing
* Blockchain/crypto settlement
* Database migration scripts
* Complete database schema/index definitions
* Admin dashboard
* Reporting/reconciliation UI
* External provider webhook implementation

Those components would need to be defined separately as part of the complete production architecture.

---

# Conclusion

The Wallet & Ledger Service provides the core financial transaction layer required for a gaming or sportsbook platform.

Its primary responsibility is to ensure that every wallet operation is:

**Validated → Atomic → Idempotent → Traceable → Concurrency-safe**

The design separates the current wallet balance from the transaction ledger, while maintaining references between related transactions and betting events. This provides a reliable foundation for integrating sportsbook, casino, gaming, and payment-provider workflows.

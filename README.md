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
       |       reference = BET-
```

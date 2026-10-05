# Wallet & Ledger Service

## Overview

This sample demonstrates a secure wallet and ledger service designed for gaming, sportsbook, and payment-related platforms.

### Key Features

* Multi-currency wallet support
* Credit and debit wallet operations
* Deposit, bet, win, refund, and reversal transactions
* Transaction ledger with balance tracking
* Duplicate transaction / idempotency protection
* Concurrent transaction handling using database locking
* Insufficient balance validation
* Transaction reference and provider validation
* Bet status management
* Transaction metadata support

## Supported Operations

```text
Create Wallet
Get Balance
Credit Deposit
Debit Bet
Credit Win
Refund Bet
Reverse Transaction
```

## Transaction Flow

```text
Request
   ↓
Validation
   ↓
Duplicate Check
   ↓
Database Transaction
   ↓
Wallet Balance Update
   ↓
Ledger Entry
   ↓
Bet Status Update
   ↓
Response
```

## Technology

* Node.js
* PostgreSQL
* Database Transactions
* Row-level locking
* SHA-256 transaction fingerprinting

This sample focuses on the core wallet and ledger transaction layer and can be extended with REST APIs, payment providers, sportsbook/casino integrations, authentication, and reporting modules.

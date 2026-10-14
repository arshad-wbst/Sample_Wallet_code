# Wallet, Ledger & Breeze Checkout Service

## Overview

This sample contains two Node.js service modules:

- **Wallet and ledger service** (`wallet.service.js`) — defines transaction actions and types, validates transaction input, and imports database transaction helpers for wallet operations.
- **Breeze payment service** (`breezePayment.service.js`) — creates a Breeze hosted checkout page for USD wallet deposits.

The modules are intended to be integrated into a larger application. The supplied sample does not include the full application, database schema, API routes, or package configuration, so those parts must be provided by the host project.

## Features shown in the sample

### Wallet and ledger

- Transaction actions: `DEBIT` and `CREDIT`
- Transaction types: `BET`, `WIN`, `REFUND`, `REVERSAL`, and `DEPOSIT`
- Validation of transaction type, action, identifiers, currency codes, and integer amounts
- Rejection of unknown transaction input fields
- Canonical JSON serialization for supported metadata values, intended to make metadata comparisons consistent
- Integration points for PostgreSQL/database pooling, transaction handling, and application errors

### Breeze checkout

- Creates a hosted payment page through Breeze's `/v1/payment_pages` endpoint
- Supports USD deposits, with amounts supplied in cents
- Validates user ID, billing email, amount, and required configuration
- Generates a unique `clientReferenceId` for each checkout request
- Configures success and failure redirect URLs
- Uses HTTPS URL validation and checks that the returned checkout URL uses the `pay.breeze.cash` host
- Restricts the checkout URL's payment methods to Apple Pay, Google Pay, and card
- Uses a 20-second request timeout and does not automatically retry failed requests

## Technology and dependencies

- Node.js with ES modules
- PostgreSQL-related integration in the wallet service
- Node.js built-in `node:crypto` module
- Breeze hosted checkout API
- Application-specific helpers:
  - `../helpers/errors.js`
  - `../config/database.js`
  - `../helpers/transaction.js`

The helper modules and the database schema are referenced by the sample but were not included in the supplied files.

## Project layout

The following is an illustrative layout based on the import paths in the sample. Adapt it to your actual project:

```text
project/
├── config/
│   └── database.js
├── helpers/
│   ├── errors.js
│   └── transaction.js
└── services/
    ├── wallet.service.js
    └── breezePayment.service.js
```

## Configuration

The Breeze service reads these environment variables:

| Variable | Purpose |
|---|---|
| `BREEZE_API_KEY` | API key used for Basic authentication |
| `BREEZE_BASE_URL` | Breeze API base URL; must be HTTPS |
| `FRONTEND_REDIRECT_URL` | Frontend base URL; must be HTTPS |
| `BREEZE_CROSS_DOMAIN` | Value added to the checkout URL as `cross_domain_name` |

Example `.env` template:

```dotenv
BREEZE_API_KEY=replace_with_your_api_key
BREEZE_BASE_URL=https://replace-with-your-breeze-api-host
FRONTEND_REDIRECT_URL=https://your-frontend.example
BREEZE_CROSS_DOMAIN=your-frontend.example
```

Use the actual API base URL and cross-domain value supplied for your Breeze account. Do not commit real credentials to source control.

## Breeze checkout usage

The module exports `createBreezePaymentService` for dependency injection and testing, and `createBreezeCheckout` as a convenience function.

```js
import { createBreezePaymentService } from './services/breezePayment.service.js';

const breezePaymentService = createBreezePaymentService();

const result = await breezePaymentService.createCheckout({
  userId: 'user-123',
  currency: 'USD',
  amount: 2500, // USD 25.00, expressed in cents
  billingEmail: 'customer@example.com',
});

console.log(result);
```

The returned result follows this shape:

```json
{
  "code": 200,
  "message": "Breeze checkout page created successfully",
  "data": {
    "link": "https://pay.breeze.cash/...",
    "paymentPageId": "provider-payment-page-id",
    "clientReferenceId": "deposit-user-123-unique-id",
    "status": "provider-status"
  }
}
```

The values above are illustrative; the actual ID, URL, and status come from the Breeze API response.

### Checkout validation rules

- `userId` must be a string containing 1–100 permitted identifier characters.
- `currency` must be `USD`.
- `amount` must be a positive safe integer in cents. For example, `2500` represents USD 25.00.
- `billingEmail` must be a valid-looking email address and no longer than 254 characters.
- All required Breeze configuration variables must be present.
- Configured base and frontend URLs must use HTTPS.
- The returned checkout URL must use HTTPS, the `pay.breeze.cash` hostname, and no explicit port.

The service appends `/deposit-success` and `/deposit-failed` to the frontend base URL for the return destinations.

## Wallet transaction concepts

The wallet module defines these constants:

| Constant | Values |
|---|---|
| `TRANSACTION_ACTION` | `DEBIT`, `CREDIT` |
| `TRANSACTION_TYPE` | `BET`, `WIN`, `REFUND`, `REVERSAL`, `DEPOSIT` |

For non-reversal transactions, the sample requires `BET` to use `DEBIT`; the other listed transaction types use `CREDIT`. A reversal may specify either supported action, because its action is expected to follow the original transaction.

Amounts are represented as integer minor units (for example, cents), rather than floating-point currency values. Currency codes are validated as two- or three-letter uppercase strings.

The supplied wallet file imports database and transaction helpers, but the provided sample does not show a complete exported wallet API or all database operations. Consult the full implementation before relying on specific wallet method names or behavior.

## Error handling

The Breeze service raises `AppError` instances with status codes and machine-readable codes for cases such as:

- `INVALID_INPUT`
- `INVALID_CURRENCY`
- `INVALID_AMOUNT`
- `BREEZE_NOT_CONFIGURED`
- `BREEZE_INVALID_URL`
- `BREEZE_API_ERROR`
- `BREEZE_REQUEST_FAILED`
- `BREEZE_INVALID_RESPONSE`

The wallet module also uses `AppError` for validation failures, including invalid transaction type/action, currency, amount, and metadata.

Ensure the host application has an error handler that translates `AppError` instances into safe API responses. Avoid returning credentials or sensitive provider response details to clients.

## Important operational notes

- **Do not automatically retry a checkout-creation request after a timeout.** The provider may have created the payment page even if the client did not receive the response. Reconcile the request with Breeze before retrying.
- Treat the browser redirect as a user-experience flow, not proof that a deposit has been paid. Confirm payment using the provider's trusted server-side status/notification mechanism before crediting a wallet.
- Keep API keys in environment variables or a secrets manager.
- Use database transactions and appropriate locking in the complete wallet implementation to protect balance updates from concurrent requests.
- Ensure duplicate transaction protection and reversal rules are enforced in the complete wallet/ledger layer.
- Add authentication and authorization at the API layer before exposing wallet or checkout operations.

## Testing guidance

The Breeze service accepts injected `env` and `fetchImpl` dependencies, which can be used to test configuration and API behavior without calling the live provider.

Example test setup:

```js
import { createBreezePaymentService } from './services/breezePayment.service.js';

const service = createBreezePaymentService({
  env: {
    BREEZE_API_KEY: 'test-key',
    BREEZE_BASE_URL: 'https://api.example.test',
    FRONTEND_REDIRECT_URL: 'https://frontend.example.test',
    BREEZE_CROSS_DOMAIN: 'frontend.example.test',
  },
  fetchImpl: async (url, options) => {
    // Return a mock response matching the provider response shape.
  },
});
```

Recommended cases to cover:

- Missing configuration
- Invalid user ID, email, currency, or amount
- Non-HTTPS configured URLs
- Provider HTTP errors, invalid JSON, and timeout/network failures
- Unexpected checkout hostname, missing payment page ID, or malformed response
- Wallet amount/currency/action validation
- Duplicate transaction requests, concurrent balance changes, insufficient funds, and reversal handling in the complete implementation

## Scope and limitations

This README documents the behavior visible in the supplied sample files. It does not claim that the sample is a complete, production-ready application. Before deployment, verify the complete wallet service implementation, database schema and migrations, API routes, Breeze account configuration, trusted payment-confirmation flow, authentication, logging, and automated tests.

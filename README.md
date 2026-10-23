# Sale05 Mini App — SBP backend

This repo now contains a working Node.js backend for the mini app checkout flow.

## Quick start

1. Install dependencies:
   npm install
2. Copy environment variables:
   cp .env.example .env
3. Start the server:
   npm start
4. Open:
   http://localhost:3000

## What it does

- Serves the existing mini app frontend from the root folder
- Exposes payment endpoints:
  - POST /api/payments/create
  - POST /api/payments/verify
  - GET /api/payments/sbp-demo/:orderId
- Supports three modes:
  - demo (default)
  - yookassa
  - tinkoff

## Important note

The default mode is `demo`. This means the app is ready to work with the UI and API flow, but real bank processing requires a payment provider account and credentials.

For true production SBP payment processing, configure one of the providers in `.env` and set the required keys.

## Example endpoints

### Create payment

```bash
curl -X POST http://localhost:3000/api/payments/create \
  -H "Content-Type: application/json" \
  -d '{
    "total": 1320,
    "items": [{"id":"shawarma-bun","qty":2}],
    "paymentMethod":"sbp"
  }'
```

### Verify payment

```bash
curl -X POST http://localhost:3000/api/payments/verify \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "SBP-123",
    "status": "paid"
  }'
```

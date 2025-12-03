# Satoshi Wallet Backend

Backend server for the Satoshi wallet app. Handles transaction signing and submission to the Movement blockchain.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   Update `.env` with your configuration if needed.

3. **Run locally:**
   ```bash
   node index.js
   ```
   Server will start at `http://localhost:3000`

## Deployment to Vercel

1. **Push to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Initial backend setup"
   git remote add origin https://github.com/yourusername/satoshi-backend.git
   git push -u origin main
   ```

2. **Deploy on Vercel:**
   - Go to https://vercel.com
   - Import your GitHub repository
   - Select `expo-backend` as root directory (if in monorepo)
   - Add environment variables from `.env`
   - Click Deploy

3. **Update app configuration:**
   After deployment, update these files with your Vercel URL:
   - `config/backend.ts` → `PRODUCTION_HOST`
   - `services/movement_service/constants.ts` → `BACKEND_URL`

## Environment Variables

- `PORT` - Server port (default: 3000)
- `MOVEMENT_MAINNET_RPC` - Movement mainnet RPC endpoint
- `MOVEMENT_TESTNET_RPC` - Movement testnet RPC endpoint
- `DEFAULT_MOVEMENT_NETWORK` - Default network (mainnet or testnet)

## Endpoints

- `POST /generate-hash` - Generate transaction hash
- `POST /submit-transaction` - Submit signed transaction

## Tech Stack

- Node.js
- Express
- @aptos-labs/ts-sdk (Movement blockchain)
- Vercel (deployment)

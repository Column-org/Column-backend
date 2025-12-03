import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { toHex } from 'viem';
import os from 'os';
import {
    Aptos,
    AptosConfig,
    Network,
    AccountAddress,
    AccountAuthenticatorEd25519,
    Ed25519PublicKey,
    Ed25519Signature,
    generateSigningMessageForTransaction,
    SimpleTransaction,
    Hex,
    Deserializer,
} from '@aptos-labs/ts-sdk';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Log all incoming requests (can be disabled in production)
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
});

const NETWORK_CONFIGS = {
    mainnet: {
        key: 'mainnet',
        rpcUrl: process.env.MOVEMENT_MAINNET_RPC || 'https://full.mainnet.movementinfra.xyz/v1',
        faucetUrl: null,
    },
    testnet: {
        key: 'testnet',
        rpcUrl: process.env.MOVEMENT_TESTNET_RPC || 'https://testnet.movementnetwork.xyz/v1',
        faucetUrl: process.env.MOVEMENT_TESTNET_FAUCET || 'https://faucet.testnet.movementnetwork.xyz/',
    },
};

const isNetwork = (value) => value === 'mainnet' || value === 'testnet';

const DEFAULT_NETWORK = isNetwork(process.env.DEFAULT_MOVEMENT_NETWORK)
    ? process.env.DEFAULT_MOVEMENT_NETWORK
    : 'testnet';

const aptosClients = new Map();

const getAptosClient = (networkKey) => {
    const resolvedNetwork = isNetwork(networkKey) ? networkKey : DEFAULT_NETWORK;

    if (aptosClients.has(resolvedNetwork)) {
        return aptosClients.get(resolvedNetwork);
    }

    const config = NETWORK_CONFIGS[resolvedNetwork];
    const aptosConfig = new AptosConfig({
        network: Network.CUSTOM,
        fullnode: config.rpcUrl,
    });
    const client = new Aptos(aptosConfig);
    aptosClients.set(resolvedNetwork, client);
    return client;
};

const resolveNetwork = (input) => {
    if (typeof input === 'string' && isNetwork(input)) {
        return input;
    }
    return DEFAULT_NETWORK;
};

// ======================================
// 1️⃣ Generate hash (Generic Transaction Builder)
// ======================================
app.post('/generate-hash', async (req, res) => {
    const { sender, function: func, typeArguments, functionArguments, network: networkInput } = req.body;

    if (!sender || !func || !Array.isArray(functionArguments)) {
        return res.status(400).json({
            error: 'Missing required fields: sender, function, or functionArguments',
        });
    }

    try {
        const networkKey = resolveNetwork(networkInput);
        const aptos = getAptosClient(networkKey);
        const senderAddress = AccountAddress.from(sender);

        // Build generic Move transaction
        const rawTxn = await aptos.transaction.build.simple({
            sender: senderAddress,
            data: {
                function: func,
                typeArguments: typeArguments || [],
                functionArguments,
            },
        });

        // Generate hash for Privy signing
        const message = generateSigningMessageForTransaction(rawTxn);
        const hash = toHex(message);

        const rawTxnHex = rawTxn.bcsToHex().toString();

        res.json({
            success: true,
            hash,
            rawTxnHex: rawTxnHex,
        });
    } catch (error) {
        console.error('Error generating signing hash:', error);
        res.status(500).json({ error: 'Failed to generate signing hash' });
    }
});

// ======================================
// 2️⃣ Submit signed transaction
// ======================================
app.post('/submit-transaction', async (req, res) => {
    const { rawTxnHex, publicKey, signature, network: networkInput } = req.body;

    if (!rawTxnHex || !publicKey || !signature) {
        return res.status(400).json({ error: 'Missing rawTxnHex, publicKey, or signature' });
    }

    // Process the public key to ensure it's in the correct format
    let processedPublicKey = publicKey;

    // Remove 0x prefix if present
    if (processedPublicKey.toLowerCase().startsWith('0x')) {
        processedPublicKey = processedPublicKey.slice(2);
    }

    // Remove leading zeros if present (sometimes keys have 00 prefix)
    if (processedPublicKey.length === 66 && processedPublicKey.startsWith('00')) {
        processedPublicKey = processedPublicKey.substring(2);
    }

    // Ensure we have exactly 64 characters (32 bytes in hex)
    if (processedPublicKey.length !== 64) {
        throw new Error(`Invalid public key length: expected 64 characters, got ${processedPublicKey.length}. Key: ${processedPublicKey}`);
    }

    try {
        const networkKey = resolveNetwork(networkInput);
        const aptos = getAptosClient(networkKey);
        const senderAuthenticator = new AccountAuthenticatorEd25519(
            new Ed25519PublicKey(processedPublicKey),
            new Ed25519Signature(signature)
        );

       const backendRawTxn = SimpleTransaction.deserialize(new Deserializer(Hex.fromHexInput(rawTxnHex).toUint8Array()));

        const pendingTxn = await aptos.transaction.submit.simple({
            transaction: backendRawTxn,
            senderAuthenticator: senderAuthenticator,
        });

        const executedTxn = await aptos.waitForTransaction({ transactionHash: pendingTxn.hash });

        res.json({
            success: executedTxn.success,
            transactionHash: executedTxn.hash,
            vmStatus: executedTxn.vm_status,
        });
    } catch (error) {
        console.error('Error submitting signed transaction:', error);
        res.status(500).json({ error: 'Failed to submit signed transaction' });
    }
});

// ======================================
// 3️⃣ Faucet tokens
// ======================================
app.post('/faucet', async (req, res) => {
    const { address, amount, network: networkInput } = req.body;
    if (!address || !amount) {
        return res.status(400).json({ error: 'Missing address or amount' });
    }

    try {
        const networkKey = resolveNetwork(networkInput);
        const networkConfig = NETWORK_CONFIGS[networkKey];

        if (!networkConfig.faucetUrl) {
            return res.status(400).json({ error: 'Faucet is not available on the selected network' });
        }

        const response = await fetch(`${networkConfig.faucetUrl}?amount=${amount}&address=${address}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Faucet request failed: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        res.json({ success: true, data });
    } catch (error) {
        console.error('Error requesting faucet tokens:', error);
        res.status(500).json({ error: 'Failed to request faucet tokens' });
    }
});

// ======================================
// 4️⃣ Get MOVE balance
// ======================================
app.get('/balance/:address', async (req, res) => {
    const { address } = req.params;
    const networkKey = resolveNetwork(req.query.network);
    try {
        const aptos = getAptosClient(networkKey);
        const accountAddress = AccountAddress.from(address);
        const balance = await aptos.getAccountAPTAmount({ accountAddress });
        res.json({ balance });
    } catch (error) {
        console.error('Error fetching balance:', error);
        res.status(500).json({ error: 'Failed to fetch balance' });
    }
});

// ======================================
// 5️⃣ Get account info
// ======================================
app.get('/account-info/:address', async (req, res) => {
    const { address } = req.params;
    const networkKey = resolveNetwork(req.query.network);
    try {
        const aptos = getAptosClient(networkKey);
        const accountAddress = AccountAddress.from(address);
        const info = await aptos.getAccountInfo({ accountAddress });
        res.json(info);
    } catch (error) {
        console.error('Error fetching account info:', error);
        res.status(500).json({ error: 'Failed to fetch account info' });
    }
});

// ======================================
// 6️⃣ View transfer details
// ======================================
const MODULE_ADDRESS = '0x00eb30f24eab56506b8abaea431fb0c6f6aa64622018298b54b1c3d40006fc75';

app.post('/view-transfer', async (req, res) => {
    const { code, network: networkInput } = req.body;

    console.log('View transfer request:', { code, network: networkInput, codeType: typeof code });

    if (!code) {
        return res.status(400).json({ error: 'Missing required field: code' });
    }

    try {
        const networkKey = resolveNetwork(networkInput);
        const aptos = getAptosClient(networkKey);

        // Try MOVE transfer first
        try {
            console.log('Calling get_transfer with code:', code);
            const moveResult = await aptos.view({
                payload: {
                    function: `${MODULE_ADDRESS}::sendmove::get_transfer`,
                    functionArguments: [code],
                },
            });

            if (!moveResult || !Array.isArray(moveResult) || moveResult.length < 4) {
                throw new Error('Invalid response from get_transfer');
            }

            // MOVE transfer: [sender, amount, created_at, expiration]
            const [sender, amount, createdAt, expiration] = moveResult;
            
            let isClaimable = false;
            try {
                const claimableResult = await aptos.view({
                    payload: {
                        function: `${MODULE_ADDRESS}::sendmove::is_transfer_claimable`,
                        functionArguments: [code],
                    },
                });
                isClaimable = claimableResult && Array.isArray(claimableResult) ? claimableResult[0] : false;
            } catch (claimableError) {
                console.warn('Failed to check claimability for MOVE transfer:', claimableError.message);
                // Continue with isClaimable = false
            }

            return res.json({
                type: 'move',
                sender: sender?.toString() || '',
                amount: amount?.toString() || '0',
                createdAt: createdAt?.toString() || '0',
                expiration: expiration?.toString() || '0',
                isClaimable,
            });
        } catch (moveError) {
            console.log('MOVE transfer not found, trying FA transfer:', moveError.message);
            
            // If MOVE transfer fails, try FA transfer
            try {
                console.log('Calling get_fa_transfer with code:', code);
                const faResult = await aptos.view({
                    payload: {
                        function: `${MODULE_ADDRESS}::sendmove::get_fa_transfer`,
                        functionArguments: [code],
                    },
                });

                if (!faResult || !Array.isArray(faResult) || faResult.length < 5) {
                    throw new Error('Invalid response from get_fa_transfer');
                }

                // FA transfer: [sender, asset_metadata, amount, created_at, expiration]
                const [sender, assetMetadata, amount, createdAt, expiration] = faResult;
                
                let isClaimable = false;
                try {
                    const claimableResult = await aptos.view({
                        payload: {
                            function: `${MODULE_ADDRESS}::sendmove::is_fa_transfer_claimable`,
                            functionArguments: [code],
                        },
                    });
                    isClaimable = claimableResult && Array.isArray(claimableResult) ? claimableResult[0] : false;
                } catch (claimableError) {
                    console.warn('Failed to check claimability for FA transfer:', claimableError.message);
                    // Continue with isClaimable = false
                }

                return res.json({
                    type: 'fa',
                    sender: sender?.toString() || '',
                    assetMetadata: assetMetadata?.toString() || null,
                    amount: amount?.toString() || '0',
                    createdAt: createdAt?.toString() || '0',
                    expiration: expiration?.toString() || '0',
                    isClaimable,
                });
            } catch (faError) {
                console.log('FA transfer also not found:', faError.message);

                // Try the opposite network before giving up
                const alternateNetwork = networkKey === 'mainnet' ? 'testnet' : 'mainnet';
                console.log(`Transfer not found on ${networkKey}, trying ${alternateNetwork}...`);

                try {
                    const alternateAptos = getAptosClient(alternateNetwork);

                    // Try MOVE on alternate network
                    try {
                        const alternateMoveResult = await alternateAptos.view({
                            payload: {
                                function: `${MODULE_ADDRESS}::sendmove::get_transfer`,
                                functionArguments: [code],
                            },
                        });

                        if (alternateMoveResult && Array.isArray(alternateMoveResult) && alternateMoveResult.length >= 4) {
                            console.log(`Found MOVE transfer on ${alternateNetwork}!`);
                            return res.json({
                                error: 'Wrong network',
                                details: `This transfer exists on ${alternateNetwork}, but you're connected to ${networkKey}. Please switch networks in the app.`,
                                correctNetwork: alternateNetwork,
                            });
                        }
                    } catch (e) {
                        // Try FA on alternate network
                        try {
                            const alternateFaResult = await alternateAptos.view({
                                payload: {
                                    function: `${MODULE_ADDRESS}::sendmove::get_fa_transfer`,
                                    functionArguments: [code],
                                },
                            });

                            if (alternateFaResult && Array.isArray(alternateFaResult) && alternateFaResult.length >= 5) {
                                console.log(`Found FA transfer on ${alternateNetwork}!`);
                                return res.json({
                                    error: 'Wrong network',
                                    details: `This transfer exists on ${alternateNetwork}, but you're connected to ${networkKey}. Please switch networks in the app.`,
                                    correctNetwork: alternateNetwork,
                                });
                            }
                        } catch (e2) {
                            // Continue to final error
                        }
                    }
                } catch (alternateError) {
                    console.log('Error checking alternate network:', alternateError.message);
                }

                // Neither network worked
                return res.status(404).json({
                    error: 'Transfer not found',
                    details: 'The code does not match any existing transfer on mainnet or testnet. Make sure the code is correct.',
                });
            }
        }
    } catch (error) {
        console.error('Error viewing transfer:', error);
        res.status(500).json({
            error: 'Failed to view transfer',
            details: error.message || 'Unknown error occurred',
        });
    }
});

// ======================================
// 7️⃣ Get owned fungible asset objects
// ======================================
app.get('/owned-objects/:address', async (req, res) => {
    const { address } = req.params;
    const networkKey = resolveNetwork(req.query.network);

    try {
        const aptos = getAptosClient(networkKey);
        const accountAddress = address;

        // Query for objects owned by this address
        // We need to use the indexer or scan for objects
        // For now, use a view function to get owned objects

        const ownedObjects = [];

        // Alternative: Query account resources and look for object references
        const resourcesResponse = await fetch(
            `${NETWORK_CONFIGS[networkKey].rpcUrl}/accounts/${accountAddress}/resources?limit=9999`
        );

        if (!resourcesResponse.ok) {
            throw new Error('Failed to fetch account resources');
        }

        const resources = await resourcesResponse.json();

        // Look for ObjectCore resources owned by this address
        // These would be at different addresses, so we need a different approach
        // Use Aptos SDK to get account resources of type fungible_asset

        // For Movement Network, we'll need to query the indexer or use events
        // For now, return empty array and use indexer on mainnet

        res.json({
            success: true,
            owned_objects: ownedObjects,
            note: 'Object discovery requires indexer. Use mainnet for full functionality.'
        });
    } catch (error) {
        console.error('Error fetching owned objects:', error);
        res.status(500).json({ error: 'Failed to fetch owned objects' });
    }
});

// Test endpoint
app.get('/test', (req, res) => {
    res.json({ success: true, message: 'Backend is reachable!' });
});

// 404 handler - ensure JSON response
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.path,
        method: req.method,
    });
});

// Error handler - ensure JSON response for all errors
app.use((err, req, res, next) => {
    console.error('Express error handler:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
});

// Get local IP address automatically
function getLocalIPAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            // Skip internal (loopback) and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const localIP = getLocalIPAddress();

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Backend running at http://localhost:${port}`);
    console.log(`📱 Access from phone at http://${localIP}:${port}`);
});
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { Buffer } = require('buffer');
const { ReclaimProofRequest, verifyProof } = require('@reclaimprotocol/js-sdk');
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { createTransferInstruction, getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount } = require('@solana/spl-token');

// Environment validation
function validateEnvironment() {
  const requiredVars = [
    "WALLET_PRIVATE_KEY",
    "REWARD_TOKEN_MINT",
    "APP_ID",
    "APP_SECRET",
    "FLIPKART_PROVIDER_ID",
    "AMAZON_PROVIDER_ID",
    "CALLBACK_URL"
  ];

  const missingVars = requiredVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    console.error("Error: Required environment variables are not set:");
    missingVars.forEach(varName => {
      console.error(`  ${varName}`);
    });
    process.exit(1);
  }
}

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.text({ type: "*/*", limit: "50mb" })); // For parsing the urlencoded proof object
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Initialize Solana connection
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com');

// Initialize Solana wallet from private key
const privateKeyArray = Buffer.from(process.env.WALLET_PRIVATE_KEY, 'base64');
const walletKeypair = Keypair.fromSecretKey(privateKeyArray);

// Token mint address
const REWARD_TOKEN_MINT = new PublicKey(process.env.REWARD_TOKEN_MINT);

console.log(`Server wallet address: ${walletKeypair.publicKey.toString()}`);
console.log(`Reward token mint: ${REWARD_TOKEN_MINT.toString()}`);

// Generate signed Reclaim Proof configuration for Flipkart
const generateReclaimProofForFlipkart = async (userAddress) => {
  try {
    // Use the same initialization pattern as Amazon
    const reclaimProofRequest = await ReclaimProofRequest.init(
      process.env.APP_ID,              // 0xa77352A40c5e9E6f450878FD2Dbf12B35eBC48bb
      process.env.APP_SECRET,          // 0x023256e8c34c6076b85743acf8ff878f08e6657117df9de1bfcf4ff2f8210107
      process.env.FLIPKART_PROVIDER_ID, // 1f97a642-468b-4349-ac03-00eb98c71e27
      {
        isTestMode: true, // Enable test mode
        testData: {
          // Simulate Flipkart SuperCoins balance
          text: "500", // This will be the amount of SuperCoins
          contextMessage: userAddress // This will be the user's wallet address
        }
      }
    );

    // Set the callback URL
    reclaimProofRequest.setRedirectUrl(process.env.CALLBACK_URL);
    
    // Add user address to context if provided
    if (userAddress) {
      reclaimProofRequest.addContext("address", userAddress);
    }

    // Generate the signature and request URL
    const requestUrl = await reclaimProofRequest.getRequestUrl();
    
    return {
      requestUrl,
      statusUrl: reclaimProofRequest.getStatusUrl(),
      // Include session ID if it exists
      sessionId: reclaimProofRequest.sessionId || reclaimProofRequest.id
    };
  } catch (error) {
    console.error("Error generating Flipkart config:", error);
    throw error;
  }
};

// Generate signed Reclaim Proof configuration for Amazon
async function generateReclaimProofForAmazon(userAddress) {
  try {
    // Use your environment variables
    const reclaimProofRequest = await ReclaimProofRequest.init(
      process.env.APP_ID,           // 0xa77352A40c5e9E6f450878FD2Dbf12B35eBC48bb
      process.env.APP_SECRET,       // 0x023256e8c34c6076b85743acf8ff878f08e6657117df9de1bfcf4ff2f8210107
      process.env.AMAZON_PROVIDER_ID, // 4a0ce842-d430-4ef1-b0d2-a1ff1217c9a8
      {
        isTestMode: true, // Enable test mode
        testData: {
          // Simulate Amazon Pay Balance
          balance: "₹1000", // This will be the amount of Amazon Pay Balance
          contextMessage: userAddress // This will be the user's wallet address
        }
      }
    );

    // **Important**: Set the callback URL before generating request
    reclaimProofRequest.setRedirectUrl(process.env.CALLBACK_URL);
    
    // Generate the signature and request URL
    const requestUrl = await reclaimProofRequest.getRequestUrl();
    
    return {
      requestUrl,
      statusUrl: reclaimProofRequest.getStatusUrl()
    };
  } catch (error) {
    console.error('Error generating Amazon config:', error);
    throw error;
  }
}

// Extract data from Flipkart proof
const getDataFromFlipkart = async (proof) => {
  console.log("Processing Flipkart proof");
  
  const isValid = await verifyProof(proof);
  if (!isValid) {
    throw new Error("Invalid proof");
  }
  
  // Parse context and extract information
  const contextData = JSON.parse(proof.claimData.context);
  const amount = contextData.extractedParameters.text;
  const address = contextData.contextMessage;
  
  console.log(`Flipkart reward amount: ${amount}, address: ${address}`);
  return { amount, address, platform: "flipkart" };
};

// Extract data from Amazon proof
const getDataFromAmazon = async (proof) => {
  console.log("Processing Amazon proof");
  
  const isValid = await verifyProof(proof);
  if (!isValid) {
    throw new Error("Invalid proof");
  }
  
  // Parse context and extract information
  const contextData = JSON.parse(proof.claimData.context);
  const amount = contextData.extractedParameters.balance.replace("&#x20b9;", "");
  const address = contextData.contextMessage;
  
  console.log(`Amazon reward amount: ${amount}, address: ${address}`);
  return { amount, address, platform: "amazon" };
};

// Transfer reward tokens
const transferReward = async (amount, recipientAddress) => {
  try {
    console.log(`Transferring ${amount} tokens to ${recipientAddress}`);
    
    // Convert recipient address string to PublicKey
    const recipientPublicKey = new PublicKey(recipientAddress);
    
    // Get the source token account (server wallet)
    const fromTokenAccount = await getAssociatedTokenAddress(
      REWARD_TOKEN_MINT,
      walletKeypair.publicKey
    );
    
    // Get or create the destination token account
    const toTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      walletKeypair,
      REWARD_TOKEN_MINT,
      recipientPublicKey
    );
    
    // Convert amount to proper format with token decimals (assuming 9 decimals)
    const tokenAmount = BigInt(Math.floor(parseFloat(amount) * 1e9));
    
    console.log(`Transferring ${tokenAmount} tokens (${amount} with decimals)`);
    
    // Create transfer instruction
    const transferInstruction = createTransferInstruction(
      fromTokenAccount,
      toTokenAccount.address,
      walletKeypair.publicKey,
      tokenAmount
    );
    
    // Create and sign transaction
    const transaction = new Transaction().add(transferInstruction);
    transaction.feePayer = walletKeypair.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    
    // Send transaction
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [walletKeypair]
    );
    
    console.log(`Transaction successful! Signature: ${signature}`);
    
    return {
      success: true,
      signature,
      transactionUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      amount
    };
  } catch (error) {
    console.error("Transfer failed:", error);
    throw error;
  }
};

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Solana Rewards API is running' });
});

// Endpoint to generate Flipkart Reclaim proof configuration
app.post('/reclaim/generate-config-flipkart', async (req, res) => {
  try {
    const { userAddress } = req.body || {};
    const config = await generateReclaimProofForFlipkart(userAddress);
    res.json(config);
  } catch (error) {
    console.error("Error generating Flipkart config:", error);
    res.status(500).json({ error: "Failed to generate configuration" });
  }
});

// Endpoint to generate Amazon Reclaim proof configuration
app.post('/reclaim/generate-config-amazon', async (req, res) => {
  try {
    const { userAddress } = req.body || {};
    const config = await generateReclaimProofForAmazon(userAddress);
    res.json(config);
  } catch (error) {
    console.error("Error generating Amazon config:", error);
    res.status(500).json({ error: "Failed to generate configuration" });
  }
});

// Endpoint to receive proofs
app.post('/receive-proofs', async (req, res) => {
  try {
    console.log("Received proof");
    
    // Parse proof from request body
    const decodedBody = decodeURIComponent(req.body);
    const proof = JSON.parse(decodedBody);
    
    // Determine platform from proof
    let platform = null;
    if (JSON.parse(proof.claimData.parameters).url.includes("amazon")) {
      platform = "amazon";
    } else if (JSON.parse(proof.claimData.parameters).url.includes("flipkart")) {
      platform = "flipkart";
    } else {
      return res.status(400).json({ error: "Unsupported platform" });
    }
    
    console.log(`Processing proof for platform: ${platform}`);
    
    // Extract data from proof
    const { amount, address } = platform === "amazon" 
      ? await getDataFromAmazon(proof) 
      : await getDataFromFlipkart(proof);
    
    // Validate the extracted data
    if (!amount || !address) {
      return res.status(400).json({ error: "Missing amount or address in proof" });
    }
    
    // Transfer reward tokens
    const transferResult = await transferReward(amount, address);
    
    // Send success notification via WebSocket
    broadcastMessage({
      type: 'agent',
      content: `Reward of ${amount} tokens has been successfully transferred to wallet ${address}. Transaction URL: ${transferResult.transactionUrl}`
    });
    
    return res.status(200).json({ 
      success: true,
      message: "Reward processed successfully",
      transaction: transferResult
    });
  } catch (error) {
    console.error("Error processing proof:", error);
    
    // Send error notification via WebSocket
    broadcastMessage({
      type: 'error',
      content: `Error processing reward: ${error.message}`
    });
    
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Start the HTTP server
let server;
let wss;

// Function to broadcast messages to all connected WebSocket clients
function broadcastMessage(message) {
  if (wss && wss.clients) {
    wss.clients.forEach(client => {
      if (client.readyState === 1) { // OPEN
        client.send(JSON.stringify(message));
      }
    });
  }
}

// Start the servers
function startServers() {
  validateEnvironment();
  
  // Start HTTP server
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server running on port ${PORT}`);
  });
  
  // Start WebSocket server
  const WS_PORT = parseInt(PORT) + 1;
  wss = new WebSocketServer({ port: WS_PORT });
  console.log(`WebSocket server running on port ${WS_PORT}`);
  
  wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');
    
    ws.on('message', (message) => {
      console.log(`Received message: ${message}`);
    });
    
    ws.on('close', () => {
      console.log('Client disconnected from WebSocket');
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
      type: 'agent',
      content: 'Connected to Solana Rewards server. Ready to process verification requests.'
    }));
  });
  
  return { server, wss };
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down servers...');
  
  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
    });
  }
  
  if (wss) {
    wss.close(() => {
      console.log('WebSocket server closed');
    });
  }
  
  process.exit(0);
});

// Start the servers if this file is run directly
if (require.main === module) {
  startServers();
}

// Export for testing or importing
module.exports = { app, startServers };
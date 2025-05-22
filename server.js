require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { createTransferInstruction, getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount } = require('@solana/spl-token');

// Environment validation
function validateEnvironment() {
  const requiredVars = [
    "WALLET_PRIVATE_KEY",
    "REWARD_TOKEN_MINT",
    "SOLANA_RPC_URL"
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

// Endpoint to handle token transfers
app.post('/transfer-tokens', async (req, res) => {
  try {
    const { amount, address, platform, proof } = req.body;
    
    // Log the incoming request
    console.log('Transfer request:', { amount, address, platform });
    console.log('Proof:', JSON.stringify(proof, null, 2));
    
    // Validate required fields
    if (!amount || !address || !platform) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }
    
    // Transfer tokens
    const transferResult = await transferReward(amount, address);
    
    return res.status(200).json(transferResult);
  } catch (error) {
    console.error("Error processing transfer:", error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Start the server
function startServer() {
  validateEnvironment();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  process.exit(0);
});

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}

// Export for testing or importing
module.exports = { app, startServer };
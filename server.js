
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');

// Load .env file if exists
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Default API keys (same as in the frontend for consistency)
const DEFAULT_API_KEY = '694b5331ce3749e8f6f643339a2b4600601a65a7131b3f1935d0bfc547b8b97d';
const DEFAULT_API_SECRET = '412af251d49dbb381081db36fed567b1d621ec89460317fe78b7edb96a669426';

// Binance API base URL for futures testnet
const BINANCE_BASE_URL = 'https://testnet.binancefuture.com';

// Helper function to generate signature
const generateSignature = (queryString, apiSecret) => {
  return crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');
};

// Price endpoint - no authentication needed
app.get('/api/price', async (req, res) => {
  try {
    console.log('Fetching price data from Binance');
    
    const response = await axios.get(`${BINANCE_BASE_URL}/fapi/v1/ticker/price`, {
      params: { symbol: 'BTCUSDT' }
    });
    
    console.log('Price data received:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching price data:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch price data',
      details: error.response?.data || error.message
    });
  }
});

// Account data endpoint - requires authentication
app.get('/api/account', async (req, res) => {
  try {
    console.log('Fetching account data from Binance');
    
    // Get API keys from request or use defaults
    const apiKey = req.headers['binance-api-key'] || DEFAULT_API_KEY;
    const apiSecret = req.headers['binance-api-secret'] || DEFAULT_API_SECRET;
    
    // Create timestamp for the request
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    
    // Generate signature
    const signature = generateSignature(queryString, apiSecret);
    
    // Send request to Binance
    const response = await axios.get(
      `${BINANCE_BASE_URL}/fapi/v2/account?${queryString}&signature=${signature}`, 
      {
        headers: {
          'X-MBX-APIKEY': apiKey
        }
      }
    );
    
    console.log('Account data received');
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching account data:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch account data',
      details: error.response?.data || error.message
    });
  }
});

// Order endpoint - Create new order
app.post('/api/order', async (req, res) => {
  try {
    console.log('Creating order on Binance with params:', req.body);
    
    // Get API keys from request or use defaults
    const apiKey = req.headers['binance-api-key'] || DEFAULT_API_KEY;
    const apiSecret = req.headers['binance-api-secret'] || DEFAULT_API_SECRET;
    
    // Create timestamp and extract order parameters
    const timestamp = Date.now();
    const { symbol, side, type, quantity, price } = req.body;
    
    // Build query string with all parameters
    let queryParams = {
      symbol,
      side,
      type,
      timestamp,
      newOrderRespType: 'RESULT'
    };
    
    // Add quantity parameter
    if (quantity) {
      queryParams.quantity = quantity;
    }
    
    // Add price for limit orders
    if (price && type === 'LIMIT') {
      queryParams.price = price;
      queryParams.timeInForce = 'GTC';
    }
    
    // Convert params object to query string
    const queryString = Object.keys(queryParams)
      .map(key => `${key}=${encodeURIComponent(queryParams[key])}`)
      .join('&');
    
    // Generate signature
    const signature = generateSignature(queryString, apiSecret);
    
    // Send request to Binance
    const response = await axios.post(
      `${BINANCE_BASE_URL}/fapi/v1/order?${queryString}&signature=${signature}`, 
      null,
      {
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Order created successfully:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('Error creating order:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to create order',
      details: error.response?.data || error.message
    });
  }
});

// Klines/candlestick data
app.get('/api/klines', async (req, res) => {
  try {
    console.log('Fetching klines data from Binance');
    
    const { symbol = 'BTCUSDT', interval = '5m', limit = 100 } = req.query;
    
    const response = await axios.get(`${BINANCE_BASE_URL}/fapi/v1/klines`, {
      params: { symbol, interval, limit }
    });
    
    console.log(`Received ${response.data.length} klines for ${symbol}`);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching klines:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch klines data',
      details: error.response?.data || error.message
    });
  }
});

// Server health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`API proxy available at http://localhost:${PORT}/api`);
});

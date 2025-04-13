const express = require('express');
const axios = require('axios');
const CryptoJS = require('crypto-js');
const cors = require('cors');
const axiosRetry = require('axios-retry').default;
const dotenv = require('dotenv');

// Load .env file if exists
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const API_KEY = process.env.BINANCE_API_KEY || '694b5331ce3749e8f6f643339a2b4600601a65a7131b3f1935d0bfc547b8b97d';
const SECRET_KEY = process.env.BINANCE_API_SECRET || '412af251d49dbb381081db36fed567b1d621ec89460317fe78b7edb96a669426';
const BASE_URL = 'https://testnet.binancefuture.com';

// Configure axios
const axiosInstance = axios.create({
  timeout: 45000, // 45 seconds to handle Testnet delays
  maxRedirects: 5,
  proxy: false,
});

// Add retry logic
axiosRetry(axiosInstance, {
  retries: 5,
  retryDelay: (retryCount) => retryCount * 3000, // 3s, 6s, 9s, etc.
  retryCondition: (error) => {
    return (
      error.response?.status === 408 ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.response?.data?.code === -1007
    );
  },
});

// Axios interceptor for logging
axiosInstance.interceptors.response.use(
  (response) => {
    console.log('Response headers:', response.headers);
    return response;
  },
  (error) => {
    console.error('Axios error:', error.message, error.config?.url, error.response?.data);
    throw error;
  }
);

// Generate signature
const generateSignature = (queryString) => {
  console.log('Generating signature for:', queryString);
  const signature = CryptoJS.HmacSHA256(queryString, SECRET_KEY).toString(CryptoJS.enc.Hex);
  console.log('Generated signature:', signature);
  return signature;
};

// Get Binance server time
const getBinanceServerTime = async () => {
  try {
    const response = await axios.get(`${BASE_URL}/fapi/v1/time`);
    return response.data.serverTime;
  } catch (error) {
    console.error('Failed to get Binance server time:', error.message);
    return Date.now();
  }
};

// Cache server time offset
let serverTimeOffset = 0;

const syncServerTime = async () => {
  const binanceTime = await getBinanceServerTime();
  serverTimeOffset = binanceTime - Date.now();
  console.log(`Synced with Binance server time. Offset: ${serverTimeOffset}ms`);
};

// Sync on startup and every 5 minutes
syncServerTime();
setInterval(syncServerTime, 300000);

const getAdjustedTimestamp = () => {
  return Date.now() + serverTimeOffset;
};

// Fetch symbol filters for BTCUSDT
let symbolFilters = null;

const getSymbolFilters = async () => {
  if (symbolFilters) return symbolFilters;

  try {
    const response = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
    symbolFilters = response.data.symbols.find((s) => s.symbol === 'BTCUSDT').filters;
    console.log('Fetched symbol filters:', symbolFilters);
    return symbolFilters;
  } catch (error) {
    console.error('Failed to fetch symbol filters:', error.message);
    return null;
  }
};

// Check rate limits
const checkRateLimits = async () => {
  try {
    const response = await axiosInstance.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
    console.log('Exchange info (rate limits):', response.data.rateLimits);
    return response.data.rateLimits;
  } catch (error) {
    console.error('Failed to check rate limits:', error.response ? error.response.data : error.message);
    return null;
  }
};

// Make signed request
const makeSignedRequest = async (endpoint, method, params = {}) => {
  const timestamp = getAdjustedTimestamp();
  const paramsWithTimestamp = { ...params, timestamp, recvWindow: 60000 };

  console.log('Params before sorting:', paramsWithTimestamp);

  const sortedParams = Object.keys(paramsWithTimestamp)
    .sort()
    .reduce((obj, key) => {
      obj[key] = paramsWithTimestamp[key];
      return obj;
    }, {});

  console.log('Sorted params:', sortedParams);

  const queryString = Object.entries(sortedParams)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  console.log('Query string:', queryString);

  const signature = generateSignature(queryString);

  const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

  console.log('Final URL:', url);

  try {
    const response = await axiosInstance({
      method,
      url,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
      },
    });

    console.log('Binance response:', response.data);
    return response.data;
  } catch (error) {
    console.error('Signed request failed:', error.response ? error.response.data : error.message);
    throw error;
  }
};

// Make unsigned request
const makeUnsignedRequest = async (endpoint, method, params = {}) => {
  const queryString = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  const url = `${BASE_URL}${endpoint}${queryString ? `?${queryString}` : ''}`;

  console.log('Making unsigned request to:', url);

  try {
    const response = await axiosInstance({
      method,
      url,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    console.log('Unsigned response:', response.data);
    return response.data;
  } catch (error) {
    console.error('Unsigned request failed:', error.response ? error.response.data : error.message);
    throw error;
  }
};

// Endpoint: Get BTCUSDT price
app.get('/api/price', async (req, res) => {
  try {
    const priceData = await makeUnsignedRequest('/fapi/v1/ticker/price', 'GET', { symbol: 'BTCUSDT' });
    res.json(priceData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch price', details: error.message });
  }
});

// Endpoint: Get account information
app.get('/api/account', async (req, res) => {
  try {
    const accountData = await makeSignedRequest('/fapi/v2/account', 'GET');
    res.json(accountData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch account data', details: error.message });
  }
});

// Endpoint: Place market order
app.post('/api/order', async (req, res) => {
  console.log('Received order request:', req.body);

  const { side, quantity, symbol = 'BTCUSDT', type = 'MARKET', price } = req.body;

  if (!side || !quantity) {
    return res.status(400).json({ error: 'Side and quantity are required' });
  }

  // Round quantity to 4 decimal places
  const roundedQuantity = Number(quantity).toFixed(4);

  // Validate quantity against symbol filters
  const filters = await getSymbolFilters();
  if (!filters) {
    return res.status(500).json({ error: 'Failed to fetch symbol filters' });
  }

  const lotSizeFilter = filters.find((f) => f.filterType === 'LOT_SIZE');
  const minQty = parseFloat(lotSizeFilter.minQty);
  const stepSize = parseFloat(lotSizeFilter.stepSize);
  const notionalFilter = filters.find((f) => f.filterType === 'MIN_NOTIONAL');
  const minNotional = parseFloat(notionalFilter.minNotional);

  // Fetch current price to check notional
  try {
    const priceData = await makeUnsignedRequest('/fapi/v1/ticker/price', 'GET', { symbol: 'BTCUSDT' });
    const currentPrice = parseFloat(priceData.price);
    const notionalValue = currentPrice * parseFloat(roundedQuantity);

    console.log('Notional value:', notionalValue);

    if (notionalValue < minNotional) {
      return res.status(400).json({
        error: `Notional value (${notionalValue.toFixed(2)}) must be at least ${minNotional}`,
      });
    }

    // Round quantity to match stepSize
    const adjustedQuantity = Math.round(parseFloat(roundedQuantity) / stepSize) * stepSize;
    if (adjustedQuantity < minQty) {
      return res.status(400).json({
        error: `Quantity (${adjustedQuantity}) must be at least ${minQty}`,
      });
    }
  } catch (priceError) {
    console.error('Failed to fetch price for notional check:', priceError.message);
  }

  // Check rate limits
  await checkRateLimits();

  try {
    const orderParams = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: roundedQuantity,
      newOrderRespType: 'RESULT',
      positionSide: 'BOTH',
    };

    if (price && type === 'LIMIT') {
      orderParams.price = price.toString();
    }

    console.log('Sending to Binance with params:', orderParams);

    const orderResponse = await makeSignedRequest('/fapi/v1/order', 'POST', orderParams);
    res.json(orderResponse);
  } catch (error) {
    console.error('Binance API error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to place order', details: error.message });
  }
});

// Endpoint: Get klines/candlestick data
app.get('/api/klines', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = '5m', limit = 100 } = req.query;
    const priceData = await makeUnsignedRequest('/fapi/v1/klines', 'GET', { symbol, interval, limit });
    res.json(priceData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch klines data', details: error.message });
  }
});

// Endpoint: Server health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Start server
app.listen(port, () => {
  console.log(`Backend server running at http://localhost:${port}`);
});

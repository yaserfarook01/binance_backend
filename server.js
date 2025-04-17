const express = require('express');
const axios = require('axios');
const CryptoJS = require('crypto-js');
const cors = require('cors');
const axiosRetry = require('axios-retry').default;
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Binance API Configuration
const API_KEY = process.env.BINANCE_API_KEY || 'your_api_key_here';
const SECRET_KEY = process.env.BINANCE_API_SECRET || 'your_secret_key_here';
const BASE_URL = 'https://testnet.binancefuture.com';

// Axios Instance with retry logic
const axiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'X-MBX-APIKEY': API_KEY
  }
});

axiosRetry(axiosInstance, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return (
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT' ||
      error.response?.status >= 500
    );
  }
});

// Server time synchronization
let serverTimeOffset = 0;

const syncServerTime = async () => {
  try {
    const response = await axiosInstance.get('/fapi/v1/time');
    serverTimeOffset = response.data.serverTime - Date.now();
    console.log(`Time sync complete. Offset: ${serverTimeOffset}ms`);
  } catch (error) {
    console.error('Failed to sync server time:', error.message);
  }
};

// Initial sync and periodic sync every 5 minutes
syncServerTime();
setInterval(syncServerTime, 300000);

const getAdjustedTimestamp = () => Date.now() + serverTimeOffset;

// Signature generation
const generateSignature = (queryString) => {
  return CryptoJS.HmacSHA256(queryString, SECRET_KEY).toString(CryptoJS.enc.Hex);
};

// Symbol filters cache
let symbolFiltersCache = {};
const CACHE_TTL = 300000; // 5 minutes

const getSymbolFilters = async (symbol = 'BTCUSDT') => {
  if (symbolFiltersCache[symbol] && 
      Date.now() - symbolFiltersCache[symbol].timestamp < CACHE_TTL) {
    return symbolFiltersCache[symbol].filters;
  }

  try {
    const response = await axiosInstance.get('/fapi/v1/exchangeInfo');
    const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
    
    if (!symbolInfo) throw new Error('Symbol not found');
    
    symbolFiltersCache[symbol] = {
      filters: symbolInfo.filters,
      timestamp: Date.now()
    };
    
    return symbolInfo.filters;
  } catch (error) {
    console.error('Failed to fetch symbol filters:', error.message);
    throw error;
  }
};

// Validate order parameters against symbol filters
const validateOrderParams = async (symbol, quantity, price) => {
  const filters = await getSymbolFilters(symbol);
  
  // LOT_SIZE filter validation
  const lotSizeFilter = filters.find(f => f.filterType === 'LOT_SIZE');
  const minQty = parseFloat(lotSizeFilter.minQty);
  const maxQty = parseFloat(lotSizeFilter.maxQty);
  const stepSize = parseFloat(lotSizeFilter.stepSize);
  
  // PRICE_FILTER validation
  const priceFilter = filters.find(f => f.filterType === 'PRICE_FILTER');
  const minPrice = parseFloat(priceFilter.minPrice);
  const maxPrice = parseFloat(priceFilter.maxPrice);
  const tickSize = parseFloat(priceFilter.tickSize);
  
  // MIN_NOTIONAL validation
  const notionalFilter = filters.find(f => f.filterType === 'MIN_NOTIONAL');
  const minNotional = parseFloat(notionalFilter.minNotional);
  
  // Quantity validation
  const qty = parseFloat(quantity);
  if (qty < minQty || qty > maxQty) {
    throw new Error(`Quantity must be between ${minQty} and ${maxQty}`);
  }
  
  // Step size validation
  if (Math.round(qty / stepSize) * stepSize !== qty) {
    throw new Error(`Quantity must be a multiple of ${stepSize}`);
  }
  
  // Price validation (for limit orders)
  if (price) {
    const priceVal = parseFloat(price);
    if (priceVal < minPrice || priceVal > maxPrice) {
      throw new Error(`Price must be between ${minPrice} and ${maxPrice}`);
    }
    
    // Tick size validation
    if (Math.round(priceVal / tickSize) * tickSize !== priceVal) {
      throw new Error(`Price must be a multiple of ${tickSize}`);
    }
    
    // Notional validation
    if (qty * priceVal < minNotional) {
      throw new Error(`Notional value must be at least ${minNotional}`);
    }
  }
};

// ATR calculation
const calculateATR = async (symbol = 'BTCUSDT', interval = '15m', period = 14) => {
  try {
    const klines = await axiosInstance.get('/fapi/v1/klines', {
      params: { symbol, interval, limit: period + 1 }
    });

    if (!klines.data || klines.data.length < period) {
      throw new Error('Insufficient data for ATR calculation');
    }

    let trueRanges = [];
    for (let i = 1; i < klines.data.length; i++) {
      const high = parseFloat(klines.data[i][2]);
      const low = parseFloat(klines.data[i][3]);
      const prevClose = parseFloat(klines.data[i-1][4]);
      
      const tr1 = high - low;
      const tr2 = Math.abs(high - prevClose);
      const tr3 = Math.abs(low - prevClose);
      
      trueRanges.push(Math.max(tr1, tr2, tr3));
    }

    return trueRanges.reduce((sum, tr) => sum + tr, 0) / period;
  } catch (error) {
    console.error('ATR calculation error:', error.message);
    throw error;
  }
};

// Dynamic SL/TP calculation
const calculateDynamicSLTP = async (side, entryPrice) => {
  try {
    const atr = await calculateATR();
    const atrMultiplier = 1.5;
    const riskRewardRatio = 2;

    if (side.toUpperCase() === 'BUY') {
      return {
        stopLossPrice: entryPrice - (atr * atrMultiplier),
        takeProfitPrice: entryPrice + (atr * atrMultiplier * riskRewardRatio)
      };
    } else {
      return {
        stopLossPrice: entryPrice + (atr * atrMultiplier),
        takeProfitPrice: entryPrice - (atr * atrMultiplier * riskRewardRatio)
      };
    }
  } catch (error) {
    console.error('Dynamic SL/TP calculation failed, using fallback');
    const riskPercentage = 0.02; // 2%
    
    if (side.toUpperCase() === 'BUY') {
      return {
        stopLossPrice: entryPrice * (1 - riskPercentage),
        takeProfitPrice: entryPrice * (1 + riskPercentage * 2)
      };
    } else {
      return {
        stopLossPrice: entryPrice * (1 + riskPercentage),
        takeProfitPrice: entryPrice * (1 - riskPercentage * 2)
      };
    }
  }
};

// Place SL/TP orders
const placeSLTPOrders = async (symbol, side, quantity, entryPrice, slPrice, tpPrice) => {
  const closeSide = side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
  const orders = [];

  try {
    // Place Stop Loss
    const slResponse = await makeSignedRequest('/fapi/v1/order', 'POST', {
      symbol,
      side: closeSide,
      type: 'STOP_MARKET',
      stopPrice: slPrice.toFixed(2),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
      timeInForce: 'GTC',
      priceProtect: 'true'
    });
    orders.push({ type: 'stopLoss', ...slResponse });
  } catch (error) {
    orders.push({ type: 'stopLoss', error: error.message });
  }

  try {
    // Place Take Profit
    const tpResponse = await makeSignedRequest('/fapi/v1/order', 'POST', {
      symbol,
      side: closeSide,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tpPrice.toFixed(2),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
      timeInForce: 'GTC',
      priceProtect: 'true'
    });
    orders.push({ type: 'takeProfit', ...tpResponse });
  } catch (error) {
    orders.push({ type: 'takeProfit', error: error.message });
  }

  return orders;
};

// Make signed request helper
const makeSignedRequest = async (endpoint, method, params = {}) => {
  const timestamp = getAdjustedTimestamp();
  const paramsWithTime = { ...params, timestamp, recvWindow: 5000 };
  
  const queryString = Object.keys(paramsWithTime)
    .sort()
    .map(key => `${key}=${paramsWithTime[key]}`)
    .join('&');
  
  const signature = generateSignature(queryString);
  const url = `${endpoint}?${queryString}&signature=${signature}`;

  try {
    const response = await axiosInstance({
      method,
      url,
      headers: { 'X-MBX-APIKEY': API_KEY }
    });
    return response.data;
  } catch (error) {
    console.error('API Error:', error.response?.data || error.message);
    throw error;
  }
};

// API Endpoints

// Place order endpoint
app.post('/api/order', async (req, res) => {
  try {
    const {
      side,
      quantity,
      symbol = 'BTCUSDT',
      type = 'MARKET',
      price,
      placeSLTP = false,
      stopLossPrice,
      takeProfitPrice
    } = req.body;

    // Validate order parameters
    await validateOrderParams(symbol, quantity, price);

    // Prepare order parameters
    const orderParams = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: parseFloat(quantity).toFixed(4),
      newOrderRespType: 'RESULT'
    };

    if (price && type.toUpperCase() === 'LIMIT') {
      orderParams.price = price;
      orderParams.timeInForce = 'GTC';
    }

    // Place the main order
    const orderResponse = await makeSignedRequest('/fapi/v1/order', 'POST', orderParams);

    // Handle SL/TP if requested and order was filled
    if (placeSLTP && orderResponse.status === 'FILLED') {
      const entryPrice = parseFloat(orderResponse.avgPrice || orderResponse.price);
      let slPrice, tpPrice;

      // Use manual prices if provided, otherwise calculate dynamically
      if (stopLossPrice && takeProfitPrice) {
        slPrice = parseFloat(stopLossPrice);
        tpPrice = parseFloat(takeProfitPrice);
        
        // Validate SL/TP prices
        if (side.toUpperCase() === 'BUY') {
          if (slPrice >= entryPrice) throw new Error('Stop loss must be below entry for BUY');
          if (tpPrice <= entryPrice) throw new Error('Take profit must be above entry for BUY');
        } else {
          if (slPrice <= entryPrice) throw new Error('Stop loss must be above entry for SELL');
          if (tpPrice >= entryPrice) throw new Error('Take profit must be below entry for SELL');
        }
      } else {
        const dynamicSLTP = await calculateDynamicSLTP(side, entryPrice);
        slPrice = dynamicSLTP.stopLossPrice;
        tpPrice = dynamicSLTP.takeProfitPrice;
      }

      // Place SL/TP orders
      const sltpOrders = await placeSLTPOrders(
        symbol,
        side,
        quantity,
        entryPrice,
        slPrice,
        tpPrice
      );

      orderResponse.sltp = {
        stopLossPrice: slPrice,
        takeProfitPrice: tpPrice,
        orders: sltpOrders
      };
    }

    res.json(orderResponse);
  } catch (error) {
    res.status(500).json({
      error: 'Order placement failed',
      message: error.message,
      details: error.response?.data || null
    });
  }
});

// Get price endpoint
app.get('/api/price', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT' } = req.query;
    const response = await axiosInstance.get('/fapi/v1/ticker/price', {
      params: { symbol }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch price' });
  }
});

// Get account info endpoint
app.get('/api/account', async (req, res) => {
  try {
    const accountInfo = await makeSignedRequest('/fapi/v2/account', 'GET');
    res.json(accountInfo);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch account info' });
  }
});

// Get klines endpoint
// In the /api/klines endpoint
app.get('/api/klines', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = '1h', limit = 1000, startTime, endTime } = req.query;
    const params = { symbol, interval, limit };
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;

    const klines = await axiosInstance.get('/fapi/v1/klines', { params });
    
    if (!klines.data || klines.data.length === 0) {
      return res.status(404).json({ error: 'No klines data available for the requested period' });
    }

    // Warn if fewer candles than requested
    if (klines.data.length < limit) {
      console.warn(`Requested ${limit} candles but received ${klines.data.length}`);
    }

    res.json(klines.data);
  } catch (error) {
    console.error('Klines fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch klines', message: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    serverTimeOffset,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Start server
app.listen(port, () => {
  console.log(`Binance Futures API proxy running on port ${port}`);
});

const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// ========== ENVIRONMENT VALIDATION ==========
function validateEnv() {
  const requiredVars = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
    'API_KEY',
    'ADMIN_UID'
  ];
  
  const missing = requiredVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(', ')}`);
    console.error(`Please set these in Vercel Environment Variables`);
    process.exit(1);
  }
  
  console.log('✅ Environment variables validated');
}

validateEnv();

// ========== CORS CONFIGURATION ==========
app.use(cors({
  origin: ['https://happyotp.com', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-Total-Count', 'X-RateLimit-Limit', 'X-RateLimit-Remaining']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Disable ETag for all responses to prevent 304
app.disable('etag');

// ========== FIREBASE INITIALIZATION ==========
try {
  if (!admin.apps.length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    
    if (!privateKey) {
      throw new Error('Firebase private key is missing');
    }
    
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL || "https://royal-5b527-default-rtdb.firebaseio.com"
    });
    console.log('✅ Firebase initialized successfully');
  }
} catch (error) {
  console.error('❌ Firebase initialization error:', error.message);
  process.exit(1);
}

const API_KEY = process.env.API_KEY;
const ADMIN_UID = process.env.ADMIN_UID;

// ========== RATE LIMITING ==========
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false
});

const normalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// ========== COUNTRIES DATABASE ==========
const countries = {
  'philippines_51': { code: '51', name: 'WhatsApp Philippines', country: 'Philippines', price: 52, flag: '🇵🇭' },
  'india_115': { code: '115', name: 'WhatsApp Indian', country: 'India', price: 103, flag: '🇮🇳' },
  'vietnam_118': { code: '118', name: 'WhatsApp Vietnam', country: 'Vietnam', price: 61, flag: '🇻🇳' },
  'india_66': { code: '66', name: 'WhatsApp Indian', country: 'India', price: 140, flag: '🇮🇳' },
  'fire_premium_106': { code: '106', name: 'Fire Server Premium 1', country: 'India', price: 79, flag: '🇮🇳' },
  'southafrica_52': { code: '52', name: 'WhatsApp South Africa', country: 'South Africa', price: 45, flag: '🇿🇦' },
  'colombia_53': { code: '53', name: 'WhatsApp Colombia', country: 'Colombia', price: 71, flag: '🇨🇴' },
  'philippines2_117': { code: '117', name: 'WhatsApp Philippines 2', country: 'Philippines', price: 64, flag: '🇵🇭' },
  'indonesia_54': { code: '54', name: 'WhatsApp Indonesia', country: 'Indonesia', price: 49, flag: '🇮🇳' },
  'telegram_usa_123': { code: '123', name: 'Telegram USA', country: 'USA', price: 65, flag: '🇺🇸' },
  'telegram_usa2_124': { code: '124', name: 'Telegram USA 2', country: 'USA', price: 92, flag: '🇺🇸' }
};

// Cache for services data
let servicesCache = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// ========== HELPER FUNCTIONS ==========
async function getUserByApiKey(apiKey) {
  try {
    if (!apiKey || !apiKey.startsWith('sk_')) {
      return null;
    }
    
    const usersRef = admin.database().ref('users');
    const snapshot = await usersRef.orderByChild('apiKey').equalTo(apiKey).once('value');
    
    if (snapshot.exists()) {
      const users = snapshot.val();
      const uid = Object.keys(users)[0];
      return { uid, ...users[uid] };
    }
    return null;
  } catch (error) {
    console.error('Error getting user by API key:', error);
    return null;
  }
}

async function getUserByToken(token) {
  try {
    if (!token) return null;
    
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userRef = admin.database().ref('users/' + decodedToken.uid);
    const snapshot = await userRef.once('value');
    
    if (snapshot.exists()) {
      const userData = snapshot.val();
      return {
        uid: decodedToken.uid,
        email: decodedToken.email || userData.email,
        name: userData.name,
        wallet: userData.wallet || 0,
        apiKey: userData.apiKey,
        apiRequests: userData.apiRequests || 0,
        apiSuccess: userData.apiSuccess || 0,
        apiFailed: userData.apiFailed || 0,
        totalSpent: userData.totalSpent || 0,
        resellerId: userData.resellerId,
        referredBy: userData.referredBy
      };
    }
    return null;
  } catch (error) {
    console.error('Error getting user by token:', error);
    return null;
  }
}

async function deductBalance(uid, amount, service) {
  const db = admin.database();
  const userRef = db.ref('users/' + uid);
  
  try {
    // Use transaction to ensure atomic operation
    await userRef.transaction((currentData) => {
      if (currentData === null) {
        throw new Error('User not found');
      }
      
      const currentBalance = currentData.wallet || 0;
      
      if (currentBalance < amount) {
        throw new Error(`Insufficient balance. Available: ₹${currentBalance}, Required: ₹${amount}`);
      }
      
      // Update all fields in one go
      currentData.wallet = currentBalance - amount;
      currentData.apiRequests = (currentData.apiRequests || 0) + 1;
      currentData.apiSuccess = (currentData.apiSuccess || 0) + 1;
      currentData.totalSpent = (currentData.totalSpent || 0) + amount;
      
      return currentData;
    });
    
    const snapshot = await userRef.once('value');
    return snapshot.val().wallet;
  } catch (error) {
    console.error('Deduct balance error:', error);
    throw error;
  }
}

async function refundBalance(uid, amount, reason) {
  const db = admin.database();
  const userRef = db.ref('users/' + uid);
  
  try {
    await userRef.transaction((currentData) => {
      if (currentData === null) {
        throw new Error('User not found');
      }
      
      currentData.wallet = (currentData.wallet || 0) + amount;
      currentData.apiFailed = (currentData.apiFailed || 0) + 1;
      
      return currentData;
    });
    
    const snapshot = await userRef.once('value');
    return snapshot.val().wallet;
  } catch (error) {
    console.error('Refund balance error:', error);
    throw error;
  }
}

// ========== RESELLER FUNCTIONS ==========
function generateResellerId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return 'RS' + timestamp.substring(timestamp.length - 4) + random.toUpperCase();
}

function calculatePriceWithCommission(basePrice, commissionPercent) {
  const commission = Math.round(basePrice * commissionPercent / 100);
  return basePrice + commission;
}

async function getReseller(resellerId) {
  try {
    const resellerRef = admin.database().ref('resellers/' + resellerId);
    const snapshot = await resellerRef.once('value');
    return snapshot.val();
  } catch (error) {
    console.error('Get reseller error:', error);
    return null;
  }
}

async function updateResellerStats(resellerId, amount, commission) {
  try {
    const resellerRef = admin.database().ref('resellers/' + resellerId);
    
    await resellerRef.transaction((currentData) => {
      if (currentData === null) {
        return { id: resellerId };
      }
      
      currentData.wallet = (currentData.wallet || 0) + commission;
      currentData.totalSales = (currentData.totalSales || 0) + amount;
      currentData.totalCommission = (currentData.totalCommission || 0) + commission;
      currentData.referralCount = (currentData.referralCount || 0) + 1;
      currentData.lastSale = Date.now();
      
      return currentData;
    });
    
    return true;
  } catch (error) {
    console.error('Update reseller stats error:', error);
    return false;
  }
}

// ========== MIDDLEWARE ==========
function authMiddleware(req, res, next) {
  const { api_key } = req.query;
  const authHeader = req.headers.authorization;
  
  if (!api_key && (!authHeader || !authHeader.startsWith('Bearer '))) {
    return res.status(401).json({ 
      success: false, 
      error: 'Authentication required. Provide API key or Bearer token' 
    });
  }
  next();
}

// ========== API ENDPOINTS ==========

// HEALTH CHECK - No cache
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  res.json({
    success: true,
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Happy OTP API',
    version: '2.1',
    uptime: process.uptime()
  });
});

// SERVICES - With controlled caching
app.get('/api/services', (req, res) => {
  // Check if cache is valid
  const now = Date.now();
  if (servicesCache && (now - cacheTimestamp) < CACHE_DURATION) {
    // Return cached data with cache headers
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.json(servicesCache);
    return;
  }
  
  // Update cache
  servicesCache = {
    success: true,
    services: countries,
    count: Object.keys(countries).length,
    timestamp: now
  };
  cacheTimestamp = now;
  
  res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
  res.json(servicesCache);
});

// GET BALANCE
app.get('/api/getBalance', authMiddleware, async (req, res) => {
  try {
    const { api_key } = req.query;
    const authHeader = req.headers.authorization;
    
    let user = null;
    
    if (api_key) {
      user = await getUserByApiKey(api_key);
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      user = await getUserByToken(token);
    }
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      balance: user.wallet || 0,
      currency: 'INR',
      user: user.email,
      name: user.name
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET NUMBER - With rate limiting
app.get('/api/getNumber', sensitiveLimiter, authMiddleware, async (req, res) => {
  try {
    const { api_key, country, ref } = req.query;
    const authHeader = req.headers.authorization;
    
    let user = null;
    
    if (api_key) {
      user = await getUserByApiKey(api_key);
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      user = await getUserByToken(token);
    }
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    if (!country) {
      return res.status(400).json({ success: false, error: 'Country parameter required' });
    }
    
    const service = countries[country];
    if (!service) {
      return res.status(400).json({ success: false, error: 'Invalid service' });
    }
    
    // Calculate price with commission if referred
    let finalPrice = service.price;
    let commission = 0;
    let resellerId = null;
    
    if (ref) {
      const reseller = await getReseller(ref);
      if (reseller) {
        finalPrice = calculatePriceWithCommission(service.price, reseller.commissionPercent || 10);
        commission = finalPrice - service.price;
        resellerId = ref;
        
        // Save referral in user data
        await admin.database().ref('users/' + user.uid + '/referredBy').set(ref);
      }
    }
    
    if ((user.wallet || 0) < finalPrice) {
      return res.status(402).json({ 
        success: false, 
        error: `Insufficient balance. Required: ₹${finalPrice}, Available: ₹${user.wallet || 0}` 
      });
    }
    
    // Get number from FireXOTP provider
    const url = `https://firexotp.com/stubs/handler_api.php?action=getNumber&api_key=${API_KEY}&service=wa&country=${service.code}`;
    const response = await axios.get(url, { timeout: 15000 });
    const data = response.data;
    
    const parts = data.split(':');
    if (parts[0] === 'ACCESS_NUMBER' && parts.length === 3) {
      const transactionId = parts[1];
      const phoneNumber = parts[2];
      
      // Deduct balance
      const newBalance = await deductBalance(user.uid, finalPrice, service);
      
      // Save active transaction
      const activeRef = admin.database().ref('activeTransactions/' + user.uid);
      await activeRef.set({
        id: transactionId,
        number: phoneNumber,
        service: country,
        price: finalPrice,
        basePrice: service.price,
        commission: commission,
        resellerId: resellerId,
        startTime: Date.now(),
        expiresAt: Date.now() + (15 * 60 * 1000)
      });
      
      // Save to history
      const historyRef = admin.database().ref('userHistory/' + user.uid).push();
      await historyRef.set({
        transactionId: transactionId,
        number: phoneNumber,
        service: service.name,
        country: service.country,
        price: finalPrice,
        basePrice: service.price,
        commission: commission,
        resellerId: resellerId,
        status: 'active',
        timestamp: Date.now(),
        expiresAt: Date.now() + (15 * 60 * 1000)
      });
      
      // Update reseller stats if commission exists
      if (commission > 0 && resellerId) {
        await updateResellerStats(resellerId, finalPrice, commission);
      }
      
      res.json({
        success: true,
        id: transactionId,
        number: phoneNumber,
        country: service.country,
        service: service.name,
        price: finalPrice,
        basePrice: service.price,
        commission: commission,
        expiresIn: 900,
        newBalance: newBalance,
        message: 'Number purchased successfully'
      });
    } else {
      res.json({ 
        success: false, 
        error: data,
        providerMessage: data
      });
    }
  } catch (error) {
    console.error('Get number error:', error);
    
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ 
        success: false, 
        error: 'Provider timeout. Please try again.' 
      });
    }
    
    if (error.response) {
      return res.status(502).json({ 
        success: false, 
        error: 'Provider error. Please contact support.' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Service temporarily unavailable. Please try again.' 
    });
  }
});

// GET OTP
app.get('/api/getOtp', sensitiveLimiter, authMiddleware, async (req, res) => {
  try {
    const { api_key, id } = req.query;
    const authHeader = req.headers.authorization;
    
    let user = null;
    
    if (api_key) {
      user = await getUserByApiKey(api_key);
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      user = await getUserByToken(token);
    }
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    if (!id) {
      return res.status(400).json({ success: false, error: 'Transaction ID required' });
    }
    
    const activeRef = admin.database().ref('activeTransactions/' + user.uid);
    const activeSnapshot = await activeRef.once('value');
    const activeTransaction = activeSnapshot.val();
    
    if (!activeTransaction || activeTransaction.id !== id) {
      return res.status(404).json({ success: false, error: 'Transaction not found or expired' });
    }
    
    const timeElapsed = Date.now() - activeTransaction.startTime;
    if (timeElapsed > 15 * 60 * 1000) {
      await admin.database().ref('activeTransactions/' + user.uid).remove();
      
      const historyRef = admin.database().ref('userHistory/' + user.uid);
      const historySnapshot = await historyRef.orderByChild('transactionId').equalTo(id).once('value');
      
      if (historySnapshot.exists()) {
        const key = Object.keys(historySnapshot.val())[0];
        await historyRef.child(key).update({
          status: 'expired',
          cancelledAt: Date.now()
        });
      }
      
      return res.json({
        success: false,
        error: 'Time expired. Number auto-cancelled.'
      });
    }
    
    const url = `https://firexotp.com/stubs/handler_api.php?action=getStatus&api_key=${API_KEY}&id=${id}`;
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    
    const otpMatch = data.match(/\b\d{4,8}\b/);
    let otpCode = null;
    
    if (otpMatch) {
      otpCode = otpMatch[0];
      
      const historyRef = admin.database().ref('userHistory/' + user.uid);
      const snapshot = await historyRef.orderByChild('transactionId').equalTo(id).once('value');
      
      if (snapshot.exists()) {
        const key = Object.keys(snapshot.val())[0];
        await historyRef.child(key).update({
          status: 'success',
          otp: otpCode,
          completedAt: Date.now()
        });
      }
      
      await admin.database().ref('activeTransactions/' + user.uid).remove();
    }
    
    res.json({
      success: true,
      data: data,
      otp: otpCode,
      hasOtp: !!otpCode,
      timeLeft: Math.max(0, (15 * 60 * 1000 - timeElapsed) / 1000)
    });
  } catch (error) {
    console.error('Get OTP error:', error);
    res.status(500).json({ success: false, error: 'Failed to check OTP' });
  }
});

// CANCEL NUMBER
app.get('/api/cancelNumber', sensitiveLimiter, authMiddleware, async (req, res) => {
  try {
    const { api_key, id } = req.query;
    const authHeader = req.headers.authorization;
    
    let user = null;
    
    if (api_key) {
      user = await getUserByApiKey(api_key);
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      user = await getUserByToken(token);
    }
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    if (!id) {
      return res.status(400).json({ success: false, error: 'Transaction ID required' });
    }
    
    const activeRef = admin.database().ref('activeTransactions/' + user.uid);
    const activeSnapshot = await activeRef.once('value');
    const activeTransaction = activeSnapshot.val();
    
    if (!activeTransaction || activeTransaction.id !== id) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    
    const url = `https://firexotp.com/stubs/handler_api.php?action=getStatus&api_key=${API_KEY}&id=${id}`;
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    
    const otpMatch = data.match(/\b\d{4,8}\b/);
    
    if (otpMatch) {
      return res.json({
        success: false,
        error: 'Cannot cancel. OTP already received.',
        otp: otpMatch[0]
      });
    }
    
    const timeElapsed = Date.now() - activeTransaction.startTime;
    const timeLeft = 15 * 60 * 1000 - timeElapsed;
    
    if (timeLeft <= 0) {
      await admin.database().ref('activeTransactions/' + user.uid).remove();
      
      const historyRef = admin.database().ref('userHistory/' + user.uid);
      const snapshot = await historyRef.orderByChild('transactionId').equalTo(id).once('value');
      
      if (snapshot.exists()) {
        const key = Object.keys(snapshot.val())[0];
        await historyRef.child(key).update({
          status: 'expired',
          cancelledAt: Date.now()
        });
      }
      
      return res.json({
        success: true,
        message: 'Number expired and auto-cancelled',
        refundAmount: 0
      });
    }
    
    const cancelUrl = `https://firexotp.com/stubs/handler_api.php?action=setStatus&api_key=${API_KEY}&id=${id}&status=8`;
    await axios.get(cancelUrl, { timeout: 10000 });
    
    const price = activeTransaction.price || 0;
    let refundAmount = 0;
    
    if (timeLeft > 0) {
      refundAmount = price;
      await refundBalance(user.uid, price, 'user_cancelled');
    }
    
    const historyRef = admin.database().ref('userHistory/' + user.uid);
    const snapshot = await historyRef.orderByChild('transactionId').equalTo(id).once('value');
    
    if (snapshot.exists()) {
      const key = Object.keys(snapshot.val())[0];
      await historyRef.child(key).update({
        status: 'cancelled',
        cancelledAt: Date.now(),
        refundAmount: refundAmount
      });
    }
    
    await admin.database().ref('activeTransactions/' + user.uid).remove();
    
    res.json({
      success: true,
      message: 'Number cancelled successfully',
      refundAmount: refundAmount,
      timeLeft: Math.floor(timeLeft / 1000)
    });
  } catch (error) {
    console.error('Cancel number error:', error);
    res.status(500).json({ success: false, error: 'Failed to cancel number' });
  }
});

// GET HISTORY
app.get('/api/getHistory', authMiddleware, async (req, res) => {
  try {
    const { api_key } = req.query;
    const authHeader = req.headers.authorization;
    
    let user = null;
    
    if (api_key) {
      user = await getUserByApiKey(api_key);
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      user = await getUserByToken(token);
    }
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    const historyRef = admin.database().ref('userHistory/' + user.uid);
    const snapshot = await historyRef.orderByChild('timestamp').limitToLast(50).once('value');
    const history = snapshot.val() || {};
    
    const activeRef = admin.database().ref('activeTransactions/' + user.uid);
    const activeSnapshot = await activeRef.once('value');
    const activeTransaction = activeSnapshot.val();
    
    const historyArray = Object.values(history).sort((a, b) => b.timestamp - a.timestamp);
    
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      history: historyArray,
      active: activeTransaction,
      count: historyArray.length
    });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ success: false, error: 'Failed to load history' });
  }
});

// REGISTER USER
app.post('/api/register', normalLimiter, async (req, res) => {
  try {
    const { email, password, name, ref } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email, password and name are required' 
      });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must be at least 6 characters long' 
      });
    }
    
    // Check if user already exists
    try {
      await admin.auth().getUserByEmail(email);
      return res.status(409).json({ 
        success: false, 
        error: 'User already exists with this email' 
      });
    } catch (error) {
      // User doesn't exist, continue
    }
    
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: name,
      emailVerified: false
    });
    
    const apiKey = 'sk_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    
    const userData = {
      name: name,
      email: email,
      wallet: 0,
      joined: Date.now(),
      apiKey: apiKey,
      apiRequests: 0,
      apiSuccess: 0,
      apiFailed: 0,
      totalSpent: 0,
      lastActive: Date.now()
    };
    
    // Add referral if provided
    if (ref) {
      const reseller = await getReseller(ref);
      if (reseller) {
        userData.referredBy = ref;
        
        // Update reseller referral count
        await admin.database().ref('resellers/' + ref).update({
          referralCount: (reseller.referralCount || 0) + 1
        });
      }
    }
    
    await admin.database().ref('users/' + userRecord.uid).set(userData);
    
    // Send welcome email (optional - implement email service)
    
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      userId: userRecord.uid,
      apiKey: apiKey,
      email: email
    });
  } catch (error) {
    console.error('Register error:', error);
    
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ 
        success: false, 
        error: 'Email already exists' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Registration failed. Please try again.' 
    });
  }
});

// ========== DASHBOARD ENDPOINTS ==========

// GET USER DASHBOARD INFO
app.get('/api/dashboard/user', authMiddleware, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Bearer token required' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const user = await getUserByToken(token);
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const activeRef = admin.database().ref('activeTransactions/' + user.uid);
    const activeSnapshot = await activeRef.once('value');
    const activeTransaction = activeSnapshot.val();
    
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      user: {
        uid: user.uid,
        email: user.email,
        name: user.name,
        wallet: user.wallet || 0,
        apiKey: user.apiKey,
        apiRequests: user.apiRequests || 0,
        apiSuccess: user.apiSuccess || 0,
        apiFailed: user.apiFailed || 0,
        totalSpent: user.totalSpent || 0,
        resellerId: user.resellerId,
        referredBy: user.referredBy
      },
      active: activeTransaction
    });
  } catch (error) {
    console.error('Dashboard user error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// API KEY MANAGEMENT ENDPOINTS
const changeKeyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per hour
  message: { success: false, error: 'Too many API key changes. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.post('/api/dashboard/changeApiKey', changeKeyLimiter, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const user = await getUserByToken(token);
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const newApiKey = 'sk_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    
    await admin.database().ref('users/' + user.uid + '/apiKey').set(newApiKey);
    
    const logRef = admin.database().ref('apiKeyLogs/' + user.uid).push();
    await logRef.set({
      oldKey: user.apiKey ? user.apiKey.substring(0, 10) + '...' : 'No key',
      newKey: newApiKey.substring(0, 10) + '...',
      timestamp: Date.now(),
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      changeType: 'dashboard_request'
    });
    
    res.json({
      success: true,
      message: 'API key changed successfully',
      newApiKey: newApiKey,
      warning: 'Old API key is now invalid. Update all your applications immediately.',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Dashboard change API key error:', error);
    res.status(500).json({ success: false, error: 'Failed to change API key' });
  }
});

app.get('/api/dashboard/apiKeyHistory', authMiddleware, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const user = await getUserByToken(token);
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const historyRef = admin.database().ref('apiKeyLogs/' + user.uid);
    const snapshot = await historyRef.orderByChild('timestamp').limitToLast(10).once('value');
    const history = snapshot.val() || {};
    
    const historyArray = Object.values(history).sort((a, b) => b.timestamp - a.timestamp);
    
    res.json({
      success: true,
      history: historyArray,
      count: historyArray.length,
      lastChange: historyArray.length > 0 ? new Date(historyArray[0].timestamp).toISOString() : null
    });
    
  } catch (error) {
    console.error('Get API key history error:', error);
    res.status(500).json({ success: false, error: 'Failed to load history' });
  }
});

// ========== RESELLER ENDPOINTS ==========

app.post('/api/reseller/register', authMiddleware, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const user = await getUserByToken(token);
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const { name, commissionPercent } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, error: 'Name required' });
    }
    
    const commission = parseInt(commissionPercent) || 10;
    if (commission < 5 || commission > 30) {
      return res.status(400).json({ success: false, error: 'Commission must be between 5-30%' });
    }
    
    // Check if already a reseller
    const existingReseller = await admin.database().ref('users/' + user.uid + '/resellerId').once('value');
    if (existingReseller.exists()) {
      return res.status(400).json({ 
        success: false, 
        error: 'You are already a reseller',
        resellerId: existingReseller.val()
      });
    }
    
    // Generate reseller ID
    const resellerId = generateResellerId();
    
    // Create reseller record
    const resellerData = {
      id: resellerId,
      userId: user.uid,
      name: name,
      email: user.email,
      commissionPercent: commission,
      wallet: 0,
      totalSales: 0,
      totalCommission: 0,
      referralCount: 0,
      status: 'active',
      createdAt: Date.now(),
      referralLink: `https://happyotp.com/resell.html?ref=${resellerId}`,
      dashboardLink: `https://happyotp.com/dashboard?reseller=${resellerId}`
    };
    
    await admin.database().ref('resellers/' + resellerId).set(resellerData);
    await admin.database().ref('users/' + user.uid + '/resellerId').set(resellerId);
    
    res.status(201).json({
      success: true,
      message: 'Reseller account created successfully!',
      resellerId: resellerId,
      referralLink: `https://happyotp.com/resell.html?ref=${resellerId}`,
      commissionPercent: commission,
      dashboardLink: `https://happyotp.com/dashboard?reseller=${resellerId}`
    });
    
  } catch (error) {
    console.error('Reseller register error:', error);
    res.status(500).json({ success: false, error: 'Failed to create reseller account' });
  }
});

app.get('/api/reseller/info', authMiddleware, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const user = await getUserByToken(token);
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    if (!user.resellerId) {
      return res.json({
        success: false,
        message: 'You are not a reseller'
      });
    }
    
    const reseller = await getReseller(user.resellerId);
    
    if (!reseller) {
      return res.status(404).json({ success: false, error: 'Reseller not found' });
    }
    
    res.json({
      success: true,
      reseller: reseller
    });
    
  } catch (error) {
    console.error('Get reseller info error:', error);
    res.status(500).json({ success: false, error: 'Failed to get reseller info' });
  }
});

app.get('/api/reseller/stats', authMiddleware, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const user = await getUserByToken(token);
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    if (!user.resellerId) {
      return res.json({
        success: false,
        message: 'You are not a reseller'
      });
    }
    
    const reseller = await getReseller(user.resellerId);
    
    if (!reseller) {
      return res.status(404).json({ success: false, error: 'Reseller not found' });
    }
    
    // Get referred users
    const referredUsersRef = admin.database().ref('users').orderByChild('referredBy').equalTo(user.resellerId);
    const snapshot = await referredUsersRef.once('value');
    const referredUsers = snapshot.val() || {};
    const referredCount = Object.keys(referredUsers).length;
    
    // Calculate recent sales (last 30 days)
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let recentSales = 0;
    
    Object.values(referredUsers).forEach(user => {
      if (user.joined && user.joined > thirtyDaysAgo) {
        recentSales++;
      }
    });
    
    res.json({
      success: true,
      stats: {
        wallet: reseller.wallet || 0,
        totalSales: reseller.totalSales || 0,
        totalCommission: reseller.totalCommission || 0,
        referralCount: referredCount,
        recentSales: recentSales,
        commissionPercent: reseller.commissionPercent || 10,
        referralLink: reseller.referralLink || `https://happyotp.com/?ref=${user.resellerId}`,
        dashboardLink: reseller.dashboardLink || `https://happyotp.com/dashboard?reseller=${user.resellerId}`
      },
      reseller: reseller
    });
    
  } catch (error) {
    console.error('Get reseller stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to get reseller stats' });
  }
});

// Get prices with commission (Public endpoint)
app.get('/api/reseller/prices', normalLimiter, async (req, res) => {
  try {
    const { ref } = req.query;
    
    if (!ref) {
      return res.status(400).json({ success: false, error: 'Referral code required' });
    }
    
    const reseller = await getReseller(ref);
    
    if (!reseller) {
      return res.status(404).json({ success: false, error: 'Invalid referral code' });
    }
    
    const commissionPercent = reseller.commissionPercent || 10;
    const pricesWithCommission = {};
    
    Object.keys(countries).forEach(key => {
      const service = countries[key];
      const finalPrice = calculatePriceWithCommission(service.price, commissionPercent);
      pricesWithCommission[key] = {
        ...service,
        basePrice: service.price,
        commission: finalPrice - service.price,
        finalPrice: finalPrice
      };
    });
    
    res.setHeader('Cache-Control', 'public, max-age=600'); // 10 minutes
    res.json({
      success: true,
      resellerName: reseller.name,
      commissionPercent: commissionPercent,
      prices: pricesWithCommission,
      message: `Prices include ${commissionPercent}% commission for ${reseller.name}`
    });
    
  } catch (error) {
    console.error('Get reseller prices error:', error);
    res.status(500).json({ success: false, error: 'Failed to get prices' });
  }
});

// ========== ADMIN ENDPOINTS ==========
async function adminAuthMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    const user = await getUserByToken(token);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    if (user.uid !== ADMIN_UID) {
      // Check if user is in admin list
      const adminRef = admin.database().ref('admins/' + user.uid);
      const snapshot = await adminRef.once('value');
      
      if (!snapshot.exists() || snapshot.val() !== true) {
        return res.status(403).json({ success: false, error: 'Admin access required' });
      }
    }
    
    req.adminUser = user;
    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
}

// Admin login
app.post('/api/admin/login', normalLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    
    // This endpoint is for admin dashboard login
    // You should implement proper authentication here
    // For now, just check if it's the main admin email
    
    const userRecord = await admin.auth().getUserByEmail(email);
    
    if (userRecord.uid === ADMIN_UID) {
      const customToken = await admin.auth().createCustomToken(userRecord.uid);
      
      res.json({
        success: true,
        message: 'Admin login successful',
        userId: userRecord.uid,
        customToken: customToken,
        user: {
          uid: userRecord.uid,
          email: userRecord.email,
          name: userRecord.displayName || 'Admin'
        }
      });
    } else {
      const adminRef = admin.database().ref('admins/' + userRecord.uid);
      const snapshot = await adminRef.once('value');
      
      if (snapshot.exists() && snapshot.val() === true) {
        const customToken = await admin.auth().createCustomToken(userRecord.uid);
        
        res.json({
          success: true,
          message: 'Admin login successful',
          userId: userRecord.uid,
          customToken: customToken,
          user: {
            uid: userRecord.uid,
            email: userRecord.email,
            name: userRecord.displayName || 'Admin'
          }
        });
      } else {
        res.status(403).json({ success: false, error: 'Admin access required' });
      }
    }
  } catch (error) {
    console.error('Admin login endpoint error:', error);
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

// Get all users (Admin)
app.get('/api/admin/users', adminAuthMiddleware, normalLimiter, async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    
    const usersRef = admin.database().ref('users');
    const snapshot = await usersRef.once('value');
    const users = snapshot.val() || {};
    
    let userList = Object.entries(users).map(([uid, data]) => ({
      uid,
      email: data.email || 'No email',
      name: data.name || 'User',
      wallet: data.wallet || 0,
      joined: data.joined || Date.now(),
      apiKey: data.apiKey ? `${data.apiKey.substring(0, 10)}...` : 'No key',
      apiRequests: data.apiRequests || 0,
      totalSpent: data.totalSpent || 0,
      apiSuccess: data.apiSuccess || 0,
      apiFailed: data.apiFailed || 0,
      resellerId: data.resellerId || null,
      referredBy: data.referredBy || null,
      lastActive: data.lastActive || data.joined
    }));
    
    // Apply search filter
    if (search) {
      const searchLower = search.toLowerCase();
      userList = userList.filter(user => 
        user.email.toLowerCase().includes(searchLower) ||
        user.name.toLowerCase().includes(searchLower) ||
        user.uid.toLowerCase().includes(searchLower)
      );
    }
    
    // Sort by last active
    userList.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    
    // Pagination
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = pageNum * limitNum;
    const paginatedUsers = userList.slice(startIndex, endIndex);
    
    res.json({
      success: true,
      users: paginatedUsers,
      pagination: {
        total: userList.length,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(userList.length / limitNum)
      }
    });
  } catch (error) {
    console.error('Admin get users error:', error);
    res.status(500).json({ success: false, error: 'Failed to load users' });
  }
});

// Add balance to user (Admin)
app.post('/api/admin/addBalance', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId, amount, reason } = req.body;
    
    if (!userId || !amount) {
      return res.status(400).json({ success: false, error: 'User ID and amount required' });
    }
    
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    const userRef = admin.database().ref('users/' + userId + '/wallet');
    const currentBalance = await userRef.once('value');
    const balance = currentBalance.val() || 0;
    
    const newBalance = balance + parseFloat(amount);
    await userRef.set(newBalance);
    
    const transactionRef = admin.database().ref('transactions/' + userId).push();
    await transactionRef.set({
      type: 'bonus',
      amount: amount,
      reason: reason || 'Admin added',
      addedBy: req.adminUser.uid,
      timestamp: Date.now()
    });
    
    res.json({
      success: true,
      message: `₹${amount} added to user`,
      newBalance: newBalance
    });
  } catch (error) {
    console.error('Admin add balance error:', error);
    res.status(500).json({ success: false, error: 'Failed to add balance' });
  }
});

// Get admin stats
app.get('/api/admin/stats', adminAuthMiddleware, async (req, res) => {
  try {
    const usersRef = admin.database().ref('users');
    const snapshot = await usersRef.once('value');
    const users = snapshot.val() || {};
    
    let totalUsers = 0;
    let totalBalance = 0;
    let totalRequests = 0;
    let totalSpent = 0;
    let activeUsers = 0;
    let todayUsers = 0;
    
    const userArray = Object.values(users);
    totalUsers = userArray.length;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();
    
    userArray.forEach(user => {
      totalBalance += user.wallet || 0;
      totalRequests += user.apiRequests || 0;
      totalSpent += user.totalSpent || 0;
      
      if (user.lastActive && (Date.now() - user.lastActive) < (7 * 24 * 60 * 60 * 1000)) {
        activeUsers++;
      }
      
      if (user.joined && user.joined >= todayTimestamp) {
        todayUsers++;
      }
    });
    
    const activeTransactionsRef = admin.database().ref('activeTransactions');
    const activeSnapshot = await activeTransactionsRef.once('value');
    const activeTransactions = activeSnapshot.val() || {};
    const activeNumbers = Object.keys(activeTransactions).length;
    
    // Get resellers count
    const resellersRef = admin.database().ref('resellers');
    const resellersSnapshot = await resellersRef.once('value');
    const resellers = resellersSnapshot.val() || {};
    const resellersCount = Object.keys(resellers).length;
    
    // Today's revenue (simplified)
    const todayRevenue = 0; // Implement if you have revenue tracking
    
    res.json({
      success: true,
      stats: {
        totalUsers,
        totalBalance,
        totalRequests,
        totalSpent,
        activeUsers,
        todayUsers,
        activeNumbers,
        resellersCount,
        todayRevenue,
        averageBalance: totalUsers > 0 ? Math.round(totalBalance / totalUsers) : 0,
        averageSpent: totalUsers > 0 ? Math.round(totalSpent / totalUsers) : 0,
        successRate: totalRequests > 0 ? Math.round((userArray.reduce((sum, user) => sum + (user.apiSuccess || 0), 0) / totalRequests) * 100) : 0
      }
    });
    
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to load stats' });
  }
});

// ========== ERROR HANDLING ==========
app.use((error, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error:`, {
    path: req.path,
    method: req.method,
    error: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
  });
  
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    requestId: req.headers['x-request-id'] || Math.random().toString(36).substring(7)
  });
});

// 404 Handler
app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    available: [
      '/api/health',
      '/api/services',
      '/api/getBalance',
      '/api/getNumber',
      '/api/getOtp',
      '/api/cancelNumber',
      '/api/getHistory',
      '/api/register',
      '/api/dashboard/user',
      '/api/dashboard/changeApiKey',
      '/api/dashboard/apiKeyHistory',
      '/api/reseller/register',
      '/api/reseller/info',
      '/api/reseller/stats',
      '/api/reseller/prices',
      '/api/admin/login',
      '/api/admin/users',
      '/api/admin/stats',
      '/api/admin/addBalance'
    ]
  });
});

// ========== PORT LISTENING ==========
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 API Base URL: http://localhost:${PORT}/api`);
  });
}

// Export for Vercel
module.exports = app;

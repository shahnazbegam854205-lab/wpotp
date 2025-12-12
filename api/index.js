const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// CORS Configuration
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Firebase Initialization
try {
  if (!admin.apps.length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    
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
}

const API_KEY = process.env.API_KEY || "api key ko ve vercel ke env me dalna hai ";
const ADMIN_UID = process.env.ADMIN_UID || "admin ka firebase uid de alna hai env me ";

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { success: false, error: 'Too many requests' }
});

app.use('/api', apiLimiter);

// Countries Database
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

// ========== HELPER FUNCTIONS ==========
async function getUserByApiKey(apiKey) {
  try {
    if (!apiKey || !apiKey.startsWith('sk_')) return null;
    
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
        totalSpent: userData.totalSpent || 0
      };
    }
    return null;
  } catch (error) {
    console.error('Error getting user by token:', error);
    return null;
  }
}

async function deductBalance(uid, amount, service) {
  try {
    const userRef = admin.database().ref('users/' + uid + '/wallet');
    const currentBalance = await userRef.once('value');
    const balance = currentBalance.val() || 0;
    
    if (balance < amount) {
      throw new Error(`Insufficient balance. Available: ₹${balance}, Required: ₹${amount}`);
    }
    
    const newBalance = balance - amount;
    await userRef.set(newBalance);
    
    // Update stats
    const requestsRef = admin.database().ref('users/' + uid + '/apiRequests');
    const currentRequests = await requestsRef.once('value');
    await requestsRef.set((currentRequests.val() || 0) + 1);
    
    const successRef = admin.database().ref('users/' + uid + '/apiSuccess');
    const currentSuccess = await successRef.once('value');
    await successRef.set((currentSuccess.val() || 0) + 1);
    
    const spentRef = admin.database().ref('users/' + uid + '/totalSpent');
    const currentSpent = await spentRef.once('value');
    await spentRef.set((currentSpent.val() || 0) + amount);
    
    return newBalance;
  } catch (error) {
    console.error('Deduct balance error:', error);
    throw error;
  }
}

async function refundBalance(uid, amount, reason) {
  try {
    const userRef = admin.database().ref('users/' + uid + '/wallet');
    const currentBalance = await userRef.once('value');
    const balance = currentBalance.val() || 0;
    
    const newBalance = balance + amount;
    await userRef.set(newBalance);
    
    const failedRef = admin.database().ref('users/' + uid + '/apiFailed');
    const currentFailed = await failedRef.once('value');
    await failedRef.set((currentFailed.val() || 0) + 1);
    
    return newBalance;
  } catch (error) {
    console.error('Refund balance error:', error);
    throw error;
  }
}

// ========== NEW: API KEY CHANGE FUNCTIONS ==========

// Rate limiting for API key change (3 times per hour)
const changeKeyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Max 3 changes per hour
  message: { success: false, error: 'Too many API key changes. Try again later.' }
});

// User can change their own API key (using API key)
app.post('/api/changeApiKey', changeKeyLimiter, async (req, res) => {
  try {
    const { api_key } = req.query;
    
    if (!api_key) {
      return res.status(400).json({ success: false, error: 'API key required' });
    }
    
    // Get user by current API key
    const user = await getUserByApiKey(api_key);
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }
    
    // Generate new API key
    const newApiKey = 'sk_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    
    // Update in Firebase
    await admin.database().ref('users/' + user.uid + '/apiKey').set(newApiKey);
    
    // Log the change
    const logRef = admin.database().ref('apiKeyLogs/' + user.uid).push();
    await logRef.set({
      oldKey: user.apiKey ? user.apiKey.substring(0, 10) + '...' : 'No key',
      newKey: newApiKey.substring(0, 10) + '...',
      timestamp: Date.now(),
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      changeType: 'user_request'
    });
    
    res.json({
      success: true,
      message: 'API key changed successfully',
      newApiKey: newApiKey,
      warning: 'Old API key is now invalid. Update all your applications immediately.',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Change API key error:', error);
    res.status(500).json({ success: false, error: 'Failed to change API key' });
  }
});

// User can change API key using Firebase token (for dashboard)
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
    
    // Generate new API key
    const newApiKey = 'sk_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    
    // Update in Firebase
    await admin.database().ref('users/' + user.uid + '/apiKey').set(newApiKey);
    
    // Log the change
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

// User can view API key change history
app.get('/api/dashboard/apiKeyHistory', async (req, res) => {
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
    
    // Get change history
    const historyRef = admin.database().ref('apiKeyLogs/' + user.uid);
    const snapshot = await historyRef.orderByChild('timestamp').once('value');
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

// ========== PUBLIC API ENDPOINTS ==========

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Happy OTP API',
    version: '2.0'
  });
});

// Get all services
app.get('/api/services', (req, res) => {
  res.json({
    success: true,
    services: countries,
    count: Object.keys(countries).length
  });
});

// Get balance (supports both API key and Token)
app.get('/api/getBalance', async (req, res) => {
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
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    res.json({
      success: true,
      balance: user.wallet || 0,
      currency: 'INR',
      user: user.email
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get virtual number (supports both API key and Token)
app.get('/api/getNumber', async (req, res) => {
  try {
    const { api_key, country } = req.query;
    const authHeader = req.headers.authorization;
    
    let user = null;
    
    if (api_key) {
      user = await getUserByApiKey(api_key);
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      user = await getUserByToken(token);
    }
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    if (!country) {
      return res.status(400).json({ success: false, error: 'Country parameter required' });
    }
    
    const service = countries[country];
    if (!service) {
      return res.status(400).json({ success: false, error: 'Invalid service' });
    }
    
    if ((user.wallet || 0) < service.price) {
      return res.status(402).json({ 
        success: false, 
        error: `Insufficient balance. Required: ₹${service.price}, Available: ₹${user.wallet || 0}` 
      });
    }
    
    // Get number from FireXOTP provider
    const url = `https://firexotp.com/stubs/handler_api.php?action=getNumber&api_key=${API_KEY}&service=wa&country=${service.code}`;
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    
    const parts = data.split(':');
    if (parts[0] === 'ACCESS_NUMBER' && parts.length === 3) {
      const transactionId = parts[1];
      const phoneNumber = parts[2];
      
      // Deduct balance
      const newBalance = await deductBalance(user.uid, service.price, service);
      
      // Save active transaction
      const activeRef = admin.database().ref('activeTransactions/' + user.uid);
      await activeRef.set({
        id: transactionId,
        number: phoneNumber,
        service: country,
        price: service.price,
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
        price: service.price,
        status: 'active',
        timestamp: Date.now(),
        expiresAt: Date.now() + (15 * 60 * 1000)
      });
      
      res.json({
        success: true,
        id: transactionId,
        number: phoneNumber,
        country: service.country,
        service: service.name,
        price: service.price,
        expiresIn: 900,
        newBalance: newBalance,
        message: 'Number purchased successfully'
      });
    } else {
      res.json({ success: false, error: data });
    }
  } catch (error) {
    console.error('Get number error:', error);
    res.status(500).json({ success: false, error: 'Service temporarily unavailable' });
  }
});

// Get OTP (supports both API key and Token)
app.get('/api/getOtp', async (req, res) => {
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
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    if (!id) {
      return res.status(400).json({ success: false, error: 'Transaction ID required' });
    }
    
    // Check if transaction exists and belongs to user
    const activeRef = admin.database().ref('activeTransactions/' + user.uid);
    const activeSnapshot = await activeRef.once('value');
    const activeTransaction = activeSnapshot.val();
    
    if (!activeTransaction || activeTransaction.id !== id) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    
    // Check time limit (15 minutes)
    const timeElapsed = Date.now() - activeTransaction.startTime;
    if (timeElapsed > 15 * 60 * 1000) {
      // Auto cancel if time expired
      await admin.database().ref('activeTransactions/' + user.uid).remove();
      
      // Update history
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
    
    // Get OTP from provider
    const url = `https://firexotp.com/stubs/handler_api.php?action=getStatus&api_key=${API_KEY}&id=${id}`;
    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;
    
    const otpMatch = data.match(/\b\d{6}\b/);
    let otpCode = null;
    
    if (otpMatch) {
      otpCode = otpMatch[0];
      
      // Update history
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
      
      // Clear active transaction
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

// Cancel number with OTP check (supports both API key and Token)
app.get('/api/cancelNumber', async (req, res) => {
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
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    if (!id) {
      return res.status(400).json({ success: false, error: 'Transaction ID required' });
    }
    
    // Check if transaction exists
    const activeRef = admin.database().ref('activeTransactions/' + user.uid);
    const activeSnapshot = await activeRef.once('value');
    const activeTransaction = activeSnapshot.val();
    
    if (!activeTransaction || activeTransaction.id !== id) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    
    // First check if OTP received
    const url = `https://firexotp.com/stubs/handler_api.php?action=getStatus&api_key=${API_KEY}&id=${id}`;
    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;
    
    const otpMatch = data.match(/\b\d{6}\b/);
    
    if (otpMatch) {
      // OTP received, cannot cancel
      return res.json({
        success: false,
        error: 'Cannot cancel. OTP already received.',
        otp: otpMatch[0]
      });
    }
    
    // Check time elapsed
    const timeElapsed = Date.now() - activeTransaction.startTime;
    const timeLeft = 15 * 60 * 1000 - timeElapsed;
    
    if (timeLeft <= 0) {
      // Time expired, auto cancel
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
    
    // Cancel with provider (only if within 15 minutes)
    const cancelUrl = `https://firexotp.com/stubs/handler_api.php?action=setStatus&api_key=${API_KEY}&id=${id}&status=8`;
    await axios.get(cancelUrl, { timeout: 5000 });
    
    // Calculate refund (full refund if cancelled within 15 minutes)
    const price = activeTransaction.price || 0;
    let refundAmount = 0;
    
    if (timeLeft > 0) {
      refundAmount = price;
      await refundBalance(user.uid, price, 'user_cancelled');
    }
    
    // Update history
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
    
    // Clear active transaction
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

// Get history (supports both API key and Token)
app.get('/api/getHistory', async (req, res) => {
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
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    const historyRef = admin.database().ref('userHistory/' + user.uid);
    const snapshot = await historyRef.orderByChild('timestamp').once('value');
    const history = snapshot.val() || {};
    
    // Get active transaction if any
    const activeRef = admin.database().ref('activeTransactions/' + user.uid);
    const activeSnapshot = await activeRef.once('value');
    const activeTransaction = activeSnapshot.val();
    
    const historyArray = Object.values(history).sort((a, b) => b.timestamp - a.timestamp);
    
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

// Dashboard user data (Token only)
app.get('/api/dashboard/user', async (req, res) => {
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
    
    // Get active transaction
    const activeRef = admin.database().ref('activeTransactions/' + user.uid);
    const activeSnapshot = await activeRef.once('value');
    const activeTransaction = activeSnapshot.val();
    
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
        joined: user.joined
      },
      active: activeTransaction
    });
  } catch (error) {
    console.error('Dashboard user error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Generate new API key (Token only) - OLD VERSION (keep for compatibility)
app.post('/api/dashboard/generateApiKey', async (req, res) => {
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
    
    res.json({
      success: true,
      apiKey: newApiKey,
      message: 'New API key generated'
    });
  } catch (error) {
    console.error('Generate API key error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate API key' });
  }
});

// Register user
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ success: false, error: 'Email, password and name required' });
    }
    
    // Create user in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: name
    });
    
    // Generate API key
    const apiKey = 'sk_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    
    // Save user data
    await admin.database().ref('users/' + userRecord.uid).set({
      name: name,
      email: email,
      wallet: 0,
      joined: Date.now(),
      apiKey: apiKey,
      apiRequests: 0,
      apiSuccess: 0,
      apiFailed: 0,
      totalSpent: 0
    });
    
    res.json({
      success: true,
      message: 'User registered successfully',
      userId: userRecord.uid,
      apiKey: apiKey
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== ADMIN API ENDPOINTS ==========

// Admin middleware
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
    
    // Check if user is admin
    if (user.uid !== ADMIN_UID) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    
    req.adminUser = user;
    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
}

// Get all users (admin)
app.get('/api/admin/getUsers', adminAuthMiddleware, async (req, res) => {
  try {
    const usersRef = admin.database().ref('users');
    const snapshot = await usersRef.once('value');
    const users = snapshot.val() || {};
    
    const userList = Object.entries(users).map(([uid, data]) => ({
      uid,
      email: data.email || 'No email',
      name: data.name || 'User',
      wallet: data.wallet || 0,
      joined: data.joined || Date.now(),
      apiKey: data.apiKey ? `${data.apiKey.substring(0, 10)}...` : 'No key',
      apiRequests: data.apiRequests || 0,
      totalSpent: data.totalSpent || 0,
      apiSuccess: data.apiSuccess || 0,
      apiFailed: data.apiFailed || 0
    }));
    
    res.json({
      success: true,
      users: userList,
      count: userList.length
    });
  } catch (error) {
    console.error('Admin get users error:', error);
    res.status(500).json({ success: false, error: 'Failed to load users' });
  }
});

// Add balance to user (admin)
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
    
    // Save transaction
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

// Remove user (admin) - NEW
app.post('/api/admin/removeUser', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID required' });
    }
    
    // Don't allow removing main admin
    if (userId === ADMIN_UID) {
      return res.status(403).json({ success: false, error: 'Cannot remove main admin' });
    }
    
    // Delete user data from all paths
    const deletePromises = [
      admin.database().ref('users/' + userId).remove(),
      admin.database().ref('activeTransactions/' + userId).remove(),
      admin.database().ref('userHistory/' + userId).remove(),
      admin.database().ref('apiKeyLogs/' + userId).remove(),
      admin.database().ref('transactions/' + userId).remove(),
    ];
    
    await Promise.all(deletePromises);
    
    // Delete from Firebase Auth (optional)
    try {
      await admin.auth().deleteUser(userId);
    } catch (authError) {
      console.log('Auth delete optional:', authError.message);
    }
    
    res.json({
      success: true,
      message: 'User removed successfully'
    });
  } catch (error) {
    console.error('Admin remove user error:', error);
    res.status(500).json({ success: false, error: 'Failed to remove user' });
  }
});

// Reset user password (admin) - NEW
app.post('/api/admin/resetPassword', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID required' });
    }
    
    // Get user email from database
    const userRef = admin.database().ref('users/' + userId + '/email');
    const snapshot = await userRef.once('value');
    const email = snapshot.val();
    
    if (!email) {
      return res.status(404).json({ success: false, error: 'User email not found' });
    }
    
    // Generate password reset link using Firebase Admin SDK
    const actionCodeSettings = {
      url: `${req.headers.origin || 'https://your-domain.com'}/login`,
      handleCodeInApp: false
    };
    
    try {
      const resetLink = await admin.auth().generatePasswordResetLink(email, actionCodeSettings);
      
      res.json({
        success: true,
        message: 'Password reset link generated',
        resetLink: resetLink,
        email: email
      });
    } catch (firebaseError) {
      console.error('Firebase reset link error:', firebaseError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to generate reset link. Make sure Firebase Auth API is enabled.' 
      });
    }
    
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});

// Regenerate API key (admin) - NEW
app.post('/api/admin/regenerateApiKey', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID required' });
    }
    
    // Generate new API key
    const newApiKey = 'sk_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    
    // Update in database
    await admin.database().ref('users/' + userId + '/apiKey').set(newApiKey);
    
    // Log the change
    const logRef = admin.database().ref('apiKeyLogs/' + userId).push();
    await logRef.set({
      changedBy: req.adminUser.uid,
      newKey: newApiKey.substring(0, 10) + '...',
      timestamp: Date.now(),
      changeType: 'admin_forced'
    });
    
    res.json({
      success: true,
      message: 'API key regenerated',
      newApiKey: newApiKey
    });
  } catch (error) {
    console.error('Regenerate API key error:', error);
    res.status(500).json({ success: false, error: 'Failed to regenerate API key' });
  }
});

// Get user details with history (admin) - NEW
app.get('/api/admin/user/:userId', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID required' });
    }
    
    // Get user data
    const userRef = admin.database().ref('users/' + userId);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val();
    
    if (!userData) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    // Get user history (last 20 records)
    const historyRef = admin.database().ref('userHistory/' + userId);
    const historySnapshot = await historyRef.orderByChild('timestamp').limitToLast(20).once('value');
    const history = historySnapshot.val() || {};
    
    // Get transactions (admin deposits)
    const transactionsRef = admin.database().ref('transactions/' + userId);
    const transactionsSnapshot = await transactionsRef.orderByChild('timestamp').limitToLast(10).once('value');
    const transactions = transactionsSnapshot.val() || {};
    
    // Get API key logs
    const apiKeyLogsRef = admin.database().ref('apiKeyLogs/' + userId);
    const apiKeyLogsSnapshot = await apiKeyLogsRef.orderByChild('timestamp').limitToLast(5).once('value');
    const apiKeyLogs = apiKeyLogsSnapshot.val() || {};
    
    res.json({
      success: true,
      user: {
        uid: userId,
        ...userData
      },
      history: history,
      transactions: transactions,
      apiKeyLogs: apiKeyLogs
    });
    
  } catch (error) {
    console.error('Admin get user details error:', error);
    res.status(500).json({ success: false, error: 'Failed to load user details' });
  }
});

// Get system stats (admin) - NEW
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
    
    const userArray = Object.values(users);
    totalUsers = userArray.length;
    
    userArray.forEach(user => {
      totalBalance += user.wallet || 0;
      totalRequests += user.apiRequests || 0;
      totalSpent += user.totalSpent || 0;
      
      // Check if user was active in last 7 days
      if (user.joined && (Date.now() - user.joined) < (7 * 24 * 60 * 60 * 1000)) {
        activeUsers++;
      }
    });
    
    // Get today's transactions
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();
    
    // Count active numbers
    const activeTransactionsRef = admin.database().ref('activeTransactions');
    const activeSnapshot = await activeTransactionsRef.once('value');
    const activeTransactions = activeSnapshot.val() || {};
    const activeNumbers = Object.keys(activeTransactions).length;
    
    res.json({
      success: true,
      stats: {
        totalUsers,
        totalBalance,
        totalRequests,
        totalSpent,
        activeUsers,
        activeNumbers,
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

// Update user info (admin) - NEW
app.post('/api/admin/updateUser', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId, updates } = req.body;
    
    if (!userId || !updates) {
      return res.status(400).json({ success: false, error: 'User ID and updates required' });
    }
    
    // Don't allow updating main admin
    if (userId === ADMIN_UID) {
      return res.status(403).json({ success: false, error: 'Cannot update main admin' });
    }
    
    // Validate updates
    const allowedUpdates = ['name', 'email', 'wallet'];
    const validUpdates = {};
    
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) {
        validUpdates[key] = updates[key];
      }
    });
    
    if (Object.keys(validUpdates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid updates provided' });
    }
    
    // Update in database
    const userRef = admin.database().ref('users/' + userId);
    await userRef.update(validUpdates);
    
    // If email was updated, update Firebase Auth too
    if (validUpdates.email) {
      try {
        await admin.auth().updateUser(userId, {
          email: validUpdates.email
        });
      } catch (authError) {
        console.error('Auth update error:', authError);
      }
    }
    
    res.json({
      success: true,
      message: 'User updated successfully',
      updates: validUpdates
    });
    
  } catch (error) {
    console.error('Admin update user error:', error);
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// ========== ADMIN LOGIN ENDPOINT ==========

// Admin login (separate from regular login)
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    
    // Verify credentials using Firebase Auth
    // Note: Firebase Admin SDK doesn't have direct password verification
    // This is a placeholder - in production, use Firebase Client SDK for login
    
    // For now, we'll just verify the user exists and is admin
    try {
      const userRecord = await admin.auth().getUserByEmail(email);
      
      // Check if user is admin
      if (userRecord.uid === ADMIN_UID) {
        // Generate custom token for frontend
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
        // Check if user is in admins list
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
      console.error('Admin login error:', error);
      res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
  } catch (error) {
    console.error('Admin login endpoint error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ========== 404 HANDLER ==========

// 404 handler
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
      '/api/dashboard/user',
      '/api/dashboard/generateApiKey',
      '/api/dashboard/changeApiKey',
      '/api/dashboard/apiKeyHistory',
      '/api/changeApiKey',
      '/api/register',

    ]
  });
});

// Export for Vercel
module.exports = app;

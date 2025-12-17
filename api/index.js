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

// Countries Database (FIXED with correct codes)
const countries = {
  'philippines_51': { code: '51', name: 'WhatsApp Philippines', country: 'Philippines', price: 52, flag: '🇵🇭' },
  'india_115': { code: '115', name: 'WhatsApp Indian', country: 'India', price: 103, flag: '🇮🇳' },
  'vietnam_118': { code: '118', name: 'WhatsApp Vietnam', country: 'Vietnam', price: 61, flag: '🇻🇳' },
  'india_66': { code: '66', name: 'WhatsApp Indian', country: 'India', price: 140, flag: '🇮🇳' },
  'fire_premium_106': { code: '106', name: 'Fire Server Premium 1', country: 'India', price: 79, flag: '🇮🇳' },
  'southafrica_52': { code: '52', name: 'WhatsApp South Africa', country: 'South Africa', price: 45, flag: '🇿🇦' },
  'colombia_53': { code: '53', name: 'WhatsApp Colombia', country: 'Colombia', price: 71, flag: '🇨🇴' },
  'philippines2_117': { code: '117', name: 'WhatsApp Philippines 2', country: 'Philippines', price: 64, flag: '🇵🇭' },
  'indonesia_54': { code: '54', name: 'WhatsApp Indonesia', country: 'Indonesia', price: 49, flag: '🇮🇩' },
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

// ========== RESELLER FUNCTIONS ==========
function generateResellerId() {
  return 'RS' + Math.random().toString(36).substring(2, 8).toUpperCase();
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
    const snapshot = await resellerRef.once('value');
    const reseller = snapshot.val() || {};
    
    const updates = {
      wallet: (reseller.wallet || 0) + commission,
      totalSales: (reseller.totalSales || 0) + amount,
      totalCommission: (reseller.totalCommission || 0) + commission,
      referralCount: (reseller.referralCount || 0) + 1,
      lastSale: Date.now()
    };
    
    await resellerRef.update(updates);
    return true;
  } catch (error) {
    console.error('Update reseller stats error:', error);
    return false;
  }
}

async function getReferredUsersCount(resellerId) {
  try {
    const usersRef = admin.database().ref('users');
    const snapshot = await usersRef.orderByChild('referredBy').equalTo(resellerId).once('value');
    return snapshot.exists() ? Object.keys(snapshot.val()).length : 0;
  } catch (error) {
    console.error('Get referred users error:', error);
    return 0;
  }
}

// ========== API KEY CHANGE FUNCTIONS ==========
const changeKeyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { success: false, error: 'Too many API key changes. Try again later.' }
});

app.post('/api/changeApiKey', changeKeyLimiter, async (req, res) => {
  try {
    const { api_key } = req.query;
    
    if (!api_key) {
      return res.status(400).json({ success: false, error: 'API key required' });
    }
    
    const user = await getUserByApiKey(api_key);
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }
    
    const newApiKey = 'sk_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    
    await admin.database().ref('users/' + user.uid + '/apiKey').set(newApiKey);
    
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

// ========== ENHANCED RESELLER SYSTEM ==========

// 1. Reseller Registration
app.post('/api/reseller/register', async (req, res) => {
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
    
    // Check if user already referred by someone (cannot become reseller)
    if (user.referredBy) {
      return res.status(403).json({ 
        success: false, 
        error: 'Referred users cannot become resellers' 
      });
    }
    
    // Check if already a reseller
    if (user.resellerId) {
      return res.status(400).json({ 
        success: false, 
        error: 'You are already a reseller' 
      });
    }
    
    const { commissionPercent, customName } = req.body;
    
    const commission = parseInt(commissionPercent) || 15;
    if (commission < 5 || commission > 30) {
      return res.status(400).json({ success: false, error: 'Commission must be 5-30%' });
    }
    
    // Generate reseller ID
    const resellerId = generateResellerId();
    
    // Create reseller record
    const resellerData = {
      id: resellerId,
      userId: user.uid,
      name: user.name,
      customName: customName || `${user.name}'s OTP Panel`,
      email: user.email,
      commissionPercent: commission,
      wallet: 0,
      totalSales: 0,
      totalCommission: 0,
      referralCount: 0,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      referralLink: `https://wpotp.vercel.app/?ref=${resellerId}`,
      brandedLink: `https://wpotp.vercel.app/?ref=${resellerId}&brand=1`
    };
    
    await admin.database().ref('resellers/' + resellerId).set(resellerData);
    await admin.database().ref('users/' + user.uid + '/resellerId').set(resellerId);
    
    res.json({
      success: true,
      message: 'Reseller account created successfully!',
      resellerId: resellerId,
      referralLink: `https://wpotp.vercel.app/?ref=${resellerId}`,
      brandedLink: `https://wpotp.vercel.app/?ref=${resellerId}&brand=1`,
      customName: resellerData.customName,
      commissionPercent: commission
    });
    
  } catch (error) {
    console.error('Reseller register error:', error);
    res.status(500).json({ success: false, error: 'Failed to create reseller account' });
  }
});

// 2. Get Reseller Info (For Modal)
app.get('/api/reseller/info', async (req, res) => {
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
    const referredCount = await getReferredUsersCount(user.resellerId);
    
    if (!reseller) {
      return res.status(404).json({ success: false, error: 'Reseller not found' });
    }
    
    // Get recent sales (last 7 days)
    const salesRef = admin.database().ref('resellerSales/' + user.resellerId);
    const salesSnapshot = await salesRef.orderByChild('timestamp').limitToLast(20).once('value');
    const recentSales = salesSnapshot.val() || {};
    
    res.json({
      success: true,
      reseller: {
        ...reseller,
        referredCount: referredCount
      },
      recentSales: recentSales,
      stats: {
        wallet: reseller.wallet || 0,
        totalSales: reseller.totalSales || 0,
        totalCommission: reseller.totalCommission || 0,
        referralCount: referredCount,
        commissionPercent: reseller.commissionPercent || 15
      }
    });
    
  } catch (error) {
    console.error('Get reseller info error:', error);
    res.status(500).json({ success: false, error: 'Failed to get reseller info' });
  }
});

// 3. Update Reseller Branding
app.post('/api/reseller/updateBranding', async (req, res) => {
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
      return res.status(403).json({ success: false, error: 'You are not a reseller' });
    }
    
    const { customName, themeColor, welcomeMessage } = req.body;
    
    const updates = {
      updatedAt: Date.now()
    };
    
    if (customName) updates.customName = customName;
    if (themeColor) updates.themeColor = themeColor;
    if (welcomeMessage) updates.welcomeMessage = welcomeMessage;
    
    await admin.database().ref('resellers/' + user.resellerId).update(updates);
    
    res.json({
      success: true,
      message: 'Branding updated successfully',
      updates: updates
    });
    
  } catch (error) {
    console.error('Update branding error:', error);
    res.status(500).json({ success: false, error: 'Failed to update branding' });
  }
});

// 4. Request Withdrawal
app.post('/api/reseller/withdraw', async (req, res) => {
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
      return res.status(403).json({ success: false, error: 'You are not a reseller' });
    }
    
    const { amount, paymentMethod, upiId } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    const reseller = await getReseller(user.resellerId);
    
    if (!reseller || (reseller.wallet || 0) < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }
    
    // Minimum withdrawal ₹100
    if (amount < 100) {
      return res.status(400).json({ success: false, error: 'Minimum withdrawal is ₹100' });
    }
    
    // Create withdrawal request
    const withdrawalId = 'WD' + Date.now() + Math.random().toString(36).substring(2, 6).toUpperCase();
    
    const withdrawalData = {
      id: withdrawalId,
      resellerId: user.resellerId,
      resellerName: reseller.name,
      amount: amount,
      paymentMethod: paymentMethod || 'UPI',
      upiId: upiId,
      status: 'pending',
      createdAt: Date.now(),
      walletBefore: reseller.wallet || 0,
      walletAfter: (reseller.wallet || 0) - amount
    };
    
    // Save withdrawal request
    await admin.database().ref('withdrawals/' + withdrawalId).set(withdrawalData);
    
    // Deduct from reseller wallet (temporarily held)
    await admin.database().ref('resellers/' + user.resellerId + '/wallet').set(withdrawalData.walletAfter);
    
    // Add to withdrawal history
    await admin.database().ref('resellerWithdrawals/' + user.resellerId + '/' + withdrawalId).set(withdrawalData);
    
    res.json({
      success: true,
      message: 'Withdrawal request submitted successfully',
      withdrawalId: withdrawalId,
      amount: amount,
      status: 'pending',
      estimatedTime: '24-48 hours'
    });
    
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ success: false, error: 'Failed to process withdrawal' });
  }
});

// 5. Get Reseller Prices (Public - For referred users) - COMMISSION HIDDEN
app.get('/api/reseller/prices', async (req, res) => {
  try {
    const { ref } = req.query;
    
    if (!ref) {
      return res.status(400).json({ success: false, error: 'Referral code required' });
    }
    
    const reseller = await getReseller(ref);
    
    if (!reseller) {
      return res.status(404).json({ success: false, error: 'Invalid referral code' });
    }
    
    const commissionPercent = reseller.commissionPercent || 15;
    const pricesWithCommission = {};
    
    Object.keys(countries).forEach(key => {
      const service = countries[key];
      const finalPrice = calculatePriceWithCommission(service.price, commissionPercent);
      pricesWithCommission[key] = {
        ...service,
        basePrice: service.price,
        finalPrice: finalPrice, // Only final price sent
        commissionPercent: commissionPercent
        // COMMISSION FIELD REMOVED - Hide from user
      };
    });
    
    res.json({
      success: true,
      reseller: {
        name: reseller.name,
        customName: reseller.customName || reseller.name,
        commissionPercent: commissionPercent
      },
      prices: pricesWithCommission
      // MESSAGE REMOVED - Don't show commission info
    });
    
  } catch (error) {
    console.error('Get reseller prices error:', error);
    res.status(500).json({ success: false, error: 'Failed to get prices' });
  }
});

// 6. Get Reseller Config (Public - For frontend branding)
app.get('/api/reseller/config', async (req, res) => {
  try {
    const { ref, brand } = req.query;
    
    if (!ref) {
      return res.json({
        success: false,
        isReseller: false,
        message: 'No referral code'
      });
    }
    
    const reseller = await getReseller(ref);
    
    if (!reseller) {
      return res.json({
        success: false,
        isReseller: false,
        message: 'Invalid referral code'
      });
    }
    
    // Check if branding is requested
    const showBranding = brand === '1';
    
    res.json({
      success: true,
      isReseller: true,
      showBranding: showBranding,
      reseller: {
        id: reseller.id,
        name: reseller.name,
        customName: reseller.customName || `${reseller.name}'s OTP Panel`,
        themeColor: reseller.themeColor || '#00ff99',
        welcomeMessage: reseller.welcomeMessage || 'Welcome to OTP Service',
        commissionPercent: reseller.commissionPercent || 15
      },
      referralLink: `https://wpotp.vercel.app/?ref=${ref}`,
      brandedLink: `https://wpotp.vercel.app/?ref=${ref}&brand=1`
    });
    
  } catch (error) {
    console.error('Get reseller config error:', error);
    res.status(500).json({ success: false, error: 'Failed to load config' });
  }
});

// 7. Check if user can become reseller
app.get('/api/reseller/canBecome', async (req, res) => {
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
    
    // Check conditions
    const canBecome = !user.referredBy && !user.resellerId;
    const reason = user.referredBy ? 'Referred users cannot become resellers' : 
                   user.resellerId ? 'You are already a reseller' : 'Eligible';
    
    res.json({
      success: true,
      canBecome: canBecome,
      reason: reason,
      isReferred: !!user.referredBy,
      isReseller: !!user.resellerId
    });
    
  } catch (error) {
    console.error('Check reseller eligibility error:', error);
    res.status(500).json({ success: false, error: 'Failed to check eligibility' });
  }
});

// 8. Get withdrawal history
app.get('/api/reseller/withdrawals', async (req, res) => {
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
      return res.status(403).json({ success: false, error: 'You are not a reseller' });
    }
    
    const withdrawalsRef = admin.database().ref('resellerWithdrawals/' + user.resellerId);
    const snapshot = await withdrawalsRef.orderByChild('createdAt').once('value');
    const withdrawals = snapshot.val() || {};
    
    const withdrawalsArray = Object.values(withdrawals).sort((a, b) => b.createdAt - a.createdAt);
    
    res.json({
      success: true,
      withdrawals: withdrawalsArray,
      count: withdrawalsArray.length
    });
    
  } catch (error) {
    console.error('Get withdrawals error:', error);
    res.status(500).json({ success: false, error: 'Failed to load withdrawals' });
  }
});

// ========== PUBLIC API ENDPOINTS ==========
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Happy OTP API',
    version: '2.1'
  });
});

app.get('/api/services', (req, res) => {
  res.json({
    success: true,
    services: countries,
    count: Object.keys(countries).length
  });
});

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

// ========== FIXED GET NUMBER WITH COMMISSION ==========
app.get('/api/getNumber', async (req, res) => {
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
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    if (!country) {
      return res.status(400).json({ success: false, error: 'Country parameter required' });
    }
    
    const service = countries[country];
    if (!service) {
      return res.status(400).json({ success: false, error: 'Invalid service' });
    }
    
    // ========== COMMISSION CALCULATION FIXED ==========
    let finalPrice = service.price;
    let commission = 0;
    let resellerId = null;
    
    // Check multiple sources for ref
    let referralCode = ref || user.referredBy;
    
    // If no ref in query/user, check the referer header
    if (!referralCode && req.headers.referer) {
      try {
        const refererUrl = new URL(req.headers.referer);
        const refParam = refererUrl.searchParams.get('ref');
        if (refParam) referralCode = refParam;
      } catch (e) {
        console.log('Error parsing referer URL:', e.message);
      }
    }
    
    if (referralCode) {
      const reseller = await getReseller(referralCode);
      
      if (reseller) {
        // Calculate commission
        finalPrice = calculatePriceWithCommission(service.price, reseller.commissionPercent || 15);
        commission = finalPrice - service.price;
        resellerId = referralCode;
        
        console.log(`Commission Applied: Base ₹${service.price} + Commission ₹${commission} = Final ₹${finalPrice}`);
        
        // Save referral if not already saved
        if (!user.referredBy) {
          await admin.database().ref('users/' + user.uid + '/referredBy').set(referralCode);
          console.log(`User ${user.uid} marked as referred by ${referralCode}`);
        }
      }
    }
    
    // Check balance with FINAL PRICE (including commission)
    if ((user.wallet || 0) < finalPrice) {
      return res.status(402).json({ 
        success: false, 
        error: `Insufficient balance. Required: ₹${finalPrice}, Available: ₹${user.wallet || 0}` 
      });
    }
    
    // Get number from FireXOTP provider
    const url = `https://firexotp.com/stubs/handler_api.php?action=getNumber&api_key=${API_KEY}&service=wa&country=${service.code}`;
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    
    console.log('FireXOTP Response:', data);
    
    if (data.includes('ACCESS_NUMBER')) {
      const parts = data.split(':');
      if (parts.length >= 3) {
        const transactionId = parts[1];
        const phoneNumber = parts[2];
        
        // Deduct FINAL PRICE from user balance
        const newBalance = await deductBalance(user.uid, finalPrice, service);
        
        // Save active transaction
        const activeRef = admin.database().ref('activeTransactions/' + user.uid);
        await activeRef.set({
          id: transactionId,
          number: phoneNumber,
          service: country,
          price: finalPrice, // Save final price
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
          price: finalPrice, // Save final price
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
          
          // Record sale for reseller
          const saleId = 'SALE' + Date.now();
          const saleRef = admin.database().ref('resellerSales/' + resellerId + '/' + saleId);
          await saleRef.set({
            id: saleId,
            userId: user.uid,
            userEmail: user.email,
            service: service.name,
            amount: finalPrice,
            commission: commission,
            transactionId: transactionId,
            timestamp: Date.now()
          });
          
          console.log(`₹${commission} commission added to reseller ${resellerId}`);
        }
        
        // RESPONSE WITHOUT COMMISSION DETAILS
        res.json({
          success: true,
          id: transactionId,
          number: phoneNumber,
          country: service.country,
          service: service.name,
          price: finalPrice, // Only final price sent
          expiresIn: 900,
          newBalance: newBalance,
          message: 'Number purchased successfully'
          // NO basePrice, commission details sent
        });
      } else {
        res.json({ success: false, error: 'Invalid response format from provider' });
      }
    } else if (data.includes('NO_NUMBERS')) {
      res.json({ 
        success: false, 
        error: 'No numbers available for this service. Please try another country.' 
      });
    } else if (data.includes('NO_BALANCE')) {
      res.json({ 
        success: false, 
        error: 'Provider balance low. Please try again later.' 
      });
    } else {
      res.json({ success: false, error: data });
    }
  } catch (error) {
    console.error('Get number error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Service temporarily unavailable. Please try again.' 
    });
  }
});

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
    
    const activeRef = admin.database().ref('activeTransactions/' + user.uid);
    const activeSnapshot = await activeRef.once('value');
    const activeTransaction = activeSnapshot.val();
    
    if (!activeTransaction || activeTransaction.id !== id) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
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
    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;
    
    const otpMatch = data.match(/\b\d{6}\b/);
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
    
    const activeRef = admin.database().ref('activeTransactions/' + user.uid);
    const activeSnapshot = await activeRef.once('value');
    const activeTransaction = activeSnapshot.val();
    
    if (!activeTransaction || activeTransaction.id !== id) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    
    const url = `https://firexotp.com/stubs/handler_api.php?action=getStatus&api_key=${API_KEY}&id=${id}`;
    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;
    
    const otpMatch = data.match(/\b\d{6}\b/);
    
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
    await axios.get(cancelUrl, { timeout: 5000 });
    
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
        joined: user.joined,
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

app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name, ref } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ success: false, error: 'Email, password and name required' });
    }
    
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: name
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
      totalSpent: 0
    };
    
    // Add referral if provided
    if (ref) {
      const reseller = await getReseller(ref);
      if (reseller) {
        userData.referredBy = ref;
        
        // Update reseller referral count
        const resellerRef = admin.database().ref('resellers/' + ref);
        await resellerRef.update({
          referralCount: (reseller.referralCount || 0) + 1
        });
      }
    }
    
    await admin.database().ref('users/' + userRecord.uid).set(userData);
    
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
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    
    req.adminUser = user;
    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
}

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
      apiFailed: data.apiFailed || 0,
      resellerId: data.resellerId || null,
      referredBy: data.referredBy || null
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

app.post('/api/admin/removeUser', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID required' });
    }
    
    if (userId === ADMIN_UID) {
      return res.status(403).json({ success: false, error: 'Cannot remove main admin' });
    }
    
    const deletePromises = [
      admin.database().ref('users/' + userId).remove(),
      admin.database().ref('activeTransactions/' + userId).remove(),
      admin.database().ref('userHistory/' + userId).remove(),
      admin.database().ref('apiKeyLogs/' + userId).remove(),
      admin.database().ref('transactions/' + userId).remove(),
    ];
    
    await Promise.all(deletePromises);
    
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

app.post('/api/admin/resetPassword', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID required' });
    }
    
    const userRef = admin.database().ref('users/' + userId + '/email');
    const snapshot = await userRef.once('value');
    const email = snapshot.val();
    
    if (!email) {
      return res.status(404).json({ success: false, error: 'User email not found' });
    }
    
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

app.post('/api/admin/regenerateApiKey', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID required' });
    }
    
    const newApiKey = 'sk_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    
    await admin.database().ref('users/' + userId + '/apiKey').set(newApiKey);
    
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

app.get('/api/admin/user/:userId', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID required' });
    }
    
    const userRef = admin.database().ref('users/' + userId);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val();
    
    if (!userData) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const historyRef = admin.database().ref('userHistory/' + userId);
    const historySnapshot = await historyRef.orderByChild('timestamp').limitToLast(20).once('value');
    const history = historySnapshot.val() || {};
    
    const transactionsRef = admin.database().ref('transactions/' + userId);
    const transactionsSnapshot = await transactionsRef.orderByChild('timestamp').limitToLast(10).once('value');
    const transactions = transactionsSnapshot.val() || {};
    
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
      
      if (user.joined && (Date.now() - user.joined) < (7 * 24 * 60 * 60 * 1000)) {
        activeUsers++;
      }
    });
    
    const activeTransactionsRef = admin.database().ref('activeTransactions');
    const activeSnapshot = await activeTransactionsRef.once('value');
    const activeTransactions = activeSnapshot.val() || {};
    const activeNumbers = Object.keys(activeTransactions).length;
    
    // Get reseller stats
    const resellersRef = admin.database().ref('resellers');
    const resellersSnapshot = await resellersRef.once('value');
    const resellers = resellersSnapshot.val() || {};
    const totalResellers = Object.keys(resellers).length;
    const totalCommission = Object.values(resellers).reduce((sum, r) => sum + (r.totalCommission || 0), 0);
    
    res.json({
      success: true,
      stats: {
        totalUsers,
        totalBalance,
        totalRequests,
        totalSpent,
        activeUsers,
        activeNumbers,
        totalResellers,
        totalCommission,
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

app.post('/api/admin/updateUser', adminAuthMiddleware, async (req, res) => {
  try {
    const { userId, updates } = req.body;
    
    if (!userId || !updates) {
      return res.status(400).json({ success: false, error: 'User ID and updates required' });
    }
    
    if (userId === ADMIN_UID) {
      return res.status(403).json({ success: false, error: 'Cannot update main admin' });
    }
    
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
    
    const userRef = admin.database().ref('users/' + userId);
    await userRef.update(validUpdates);
    
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

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    
    try {
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
      console.error('Admin login error:', error);
      res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
  } catch (error) {
    console.error('Admin login endpoint error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ========== NEW: ADMIN RESELLER MANAGEMENT ==========
app.get('/api/admin/resellers', adminAuthMiddleware, async (req, res) => {
  try {
    const resellersRef = admin.database().ref('resellers');
    const snapshot = await resellersRef.once('value');
    const resellers = snapshot.val() || {};
    
    const resellerList = await Promise.all(
      Object.entries(resellers).map(async ([id, data]) => {
        const referredCount = await getReferredUsersCount(id);
        return {
          id,
          name: data.name,
          email: data.email,
          customName: data.customName,
          commissionPercent: data.commissionPercent || 15,
          wallet: data.wallet || 0,
          totalSales: data.totalSales || 0,
          totalCommission: data.totalCommission || 0,
          referralCount: referredCount,
          status: data.status || 'active',
          createdAt: data.createdAt,
          lastSale: data.lastSale
        };
      })
    );
    
    res.json({
      success: true,
      resellers: resellerList,
      count: resellerList.length
    });
    
  } catch (error) {
    console.error('Admin get resellers error:', error);
    res.status(500).json({ success: false, error: 'Failed to load resellers' });
  }
});

app.post('/api/admin/reseller/approveWithdrawal', adminAuthMiddleware, async (req, res) => {
  try {
    const { withdrawalId } = req.body;
    
    if (!withdrawalId) {
      return res.status(400).json({ success: false, error: 'Withdrawal ID required' });
    }
    
    const withdrawalRef = admin.database().ref('withdrawals/' + withdrawalId);
    const snapshot = await withdrawalRef.once('value');
    const withdrawal = snapshot.val();
    
    if (!withdrawal) {
      return res.status(404).json({ success: false, error: 'Withdrawal not found' });
    }
    
    // Update withdrawal status
    await withdrawalRef.update({
      status: 'completed',
      completedAt: Date.now(),
      approvedBy: req.adminUser.uid
    });
    
    // Update reseller withdrawal history
    await admin.database().ref('resellerWithdrawals/' + withdrawal.resellerId + '/' + withdrawalId).update({
      status: 'completed',
      completedAt: Date.now()
    });
    
    // Send notification to reseller (you can add email/notification system here)
    
    res.json({
      success: true,
      message: 'Withdrawal approved successfully',
      withdrawalId: withdrawalId
    });
    
  } catch (error) {
    console.error('Approve withdrawal error:', error);
    res.status(500).json({ success: false, error: 'Failed to approve withdrawal' });
  }
});

// ========== 404 HANDLER ==========
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
      // Reseller endpoints
      '/api/reseller/register',
      '/api/reseller/info',
      '/api/reseller/updateBranding',
      '/api/reseller/withdraw',
      '/api/reseller/prices',
      '/api/reseller/config',
      '/api/reseller/canBecome',
      '/api/reseller/withdrawals'
    ]
  });
});

// Export for Vercel
module.exports = app;

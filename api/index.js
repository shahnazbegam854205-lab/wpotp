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
        totalSpent: userData.totalSpent || 0,
        resellerId: userData.resellerId,
        sellerId: userData.sellerId
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

// ========== SELLER HELPER FUNCTIONS ==========
function generateSellerSlug(name) {
  let slug = name.toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .substring(0, 30);
  const timestamp = Date.now().toString(36);
  return `${slug}-${timestamp}`;
}

async function getSeller(sellerId) {
  try {
    const sellerRef = admin.database().ref('sellers/' + sellerId);
    const snapshot = await sellerRef.once('value');
    return snapshot.val();
  } catch (error) {
    console.error('Get seller error:', error);
    return null;
  }
}

async function getSellerBySlug(slug) {
  try {
    const sellersRef = admin.database().ref('sellers');
    const snapshot = await sellersRef.orderByChild('slug').equalTo(slug).once('value');
    
    if (snapshot.exists()) {
      const sellers = snapshot.val();
      const sellerId = Object.keys(sellers)[0];
      return { id: sellerId, ...sellers[sellerId] };
    }
    return null;
  } catch (error) {
    console.error('Get seller by slug error:', error);
    return null;
  }
}

function calculatePriceWithCommission(basePrice, commission) {
  return basePrice + commission;
}

async function updateSellerWallet(sellerId, amount, type = 'commission') {
  try {
    const walletRef = admin.database().ref('sellerWallets/' + sellerId);
    const snapshot = await walletRef.once('value');
    const wallet = snapshot.val() || { balance: 0, pending: 0, totalEarned: 0 };
    
    const updates = {};
    if (type === 'commission') {
      updates.pending = (wallet.pending || 0) + amount;
      updates.totalEarned = (wallet.totalEarned || 0) + amount;
    } else if (type === 'balance') {
      updates.balance = (wallet.balance || 0) + amount;
    }
    updates.lastUpdated = Date.now();
    
    await walletRef.update(updates);
    return true;
  } catch (error) {
    console.error('Update seller wallet error:', error);
    return false;
  }
}

async function recordSellerSale(sellerId, saleData) {
  try {
    const saleId = 'SALE' + Date.now().toString(36).toUpperCase();
    const saleRef = admin.database().ref('sellerSales/' + saleId);
    await saleRef.set({
      id: saleId,
      sellerId: sellerId,
      ...saleData,
      timestamp: Date.now()
    });
    
    // Update seller stats
    const sellerRef = admin.database().ref('sellers/' + sellerId);
    const sellerSnapshot = await sellerRef.once('value');
    const seller = sellerSnapshot.val() || {};
    
    await sellerRef.update({
      totalSales: (seller.totalSales || 0) + 1,
      totalEarnings: (seller.totalEarnings || 0) + (saleData.commission || 0),
      lastSale: Date.now()
    });
    
    return saleId;
  } catch (error) {
    console.error('Record seller sale error:', error);
    return null;
  }
}

// ========== SELLER API ENDPOINTS ==========

// 1. REGISTER AS SELLER
app.post('/api/seller/register', async (req, res) => {
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
    
    const { shopName, commissionAmount } = req.body;
    
    if (!shopName || !commissionAmount) {
      return res.status(400).json({ success: false, error: 'Shop name and commission required' });
    }
    
    const commission = parseInt(commissionAmount);
    if (commission < 5 || commission > 50) {
      return res.status(400).json({ success: false, error: 'Commission must be ₹5-₹50' });
    }
    
    // Check if already a seller
    const existingSeller = await admin.database().ref('users/' + user.uid + '/sellerId').once('value');
    if (existingSeller.exists()) {
      return res.json({ 
        success: false, 
        error: 'You are already a seller',
        sellerId: existingSeller.val()
      });
    }
    
    // Generate unique seller ID and slug
    const sellerId = 'SEL' + Date.now().toString(36).toUpperCase();
    const sellerSlug = generateSellerSlug(shopName);
    
    // Create seller data
    const sellerData = {
      id: sellerId,
      userId: user.uid,
      shopName: shopName,
      email: user.email,
      name: user.name || shopName,
      slug: sellerSlug,
      commission: commission,
      wallet: 0,
      totalSales: 0,
      totalEarnings: 0,
      totalCustomers: 0,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      websiteUrl: `https://${req.headers.host}/seller-page.html?seller=${sellerSlug}`,
      dashboardUrl: `https://${req.headers.host}/seller-dashboard.html?seller=${sellerId}`
    };
    
    // Save to sellers collection
    await admin.database().ref('sellers/' + sellerId).set(sellerData);
    
    // Update user record
    await admin.database().ref('users/' + user.uid).update({
      sellerId: sellerId,
      sellerSlug: sellerSlug,
      isSeller: true
    });
    
    // Create seller's wallet record
    await admin.database().ref('sellerWallets/' + sellerId).set({
      balance: 0,
      pending: 0,
      totalEarned: 0,
      lastUpdated: Date.now()
    });
    
    console.log(`✅ New seller registered: ${shopName} (${sellerId})`);
    
    res.json({
      success: true,
      message: 'Seller account created successfully!',
      sellerId: sellerId,
      sellerSlug: sellerSlug,
      sellerUrl: sellerData.websiteUrl,
      dashboardUrl: sellerData.dashboardUrl,
      commission: commission,
      shopName: shopName
    });
    
  } catch (error) {
    console.error('❌ Seller registration error:', error);
    res.status(500).json({ success: false, error: 'Failed to create seller account: ' + error.message });
  }
});

// 2. GET SELLER INFO BY ID
app.get('/api/seller/:sellerId', async (req, res) => {
  try {
    const { sellerId } = req.params;
    
    const seller = await getSeller(sellerId);
    
    if (!seller) {
      return res.status(404).json({ success: false, error: 'Seller not found' });
    }
    
    // Get wallet balance
    const walletRef = admin.database().ref('sellerWallets/' + sellerId);
    const walletSnapshot = await walletRef.once('value');
    const wallet = walletSnapshot.val() || { balance: 0, pending: 0, totalEarned: 0 };
    
    seller.walletBalance = wallet.balance || 0;
    seller.pendingBalance = wallet.pending || 0;
    seller.totalEarned = wallet.totalEarned || 0;
    
    // Get sales count
    const salesRef = admin.database().ref('sellerSales').orderByChild('sellerId').equalTo(sellerId);
    const salesSnapshot = await salesRef.once('value');
    seller.totalSalesCount = salesSnapshot.exists() ? Object.keys(salesSnapshot.val()).length : 0;
    
    // Remove sensitive data
    delete seller.userId;
    delete seller.email;
    
    res.json({
      success: true,
      seller: seller
    });
    
  } catch (error) {
    console.error('Get seller error:', error);
    res.status(500).json({ success: false, error: 'Failed to get seller info' });
  }
});

// 3. GET SELLER BY SLUG (for white-label page)
app.get('/api/seller/slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const seller = await getSellerBySlug(slug);
    
    if (!seller) {
      return res.status(404).json({ success: false, error: 'Seller not found' });
    }
    
    // Get prices with commission
    const pricesWithCommission = {};
    Object.keys(countries).forEach(key => {
      const service = countries[key];
      const finalPrice = calculatePriceWithCommission(service.price, seller.commission);
      pricesWithCommission[key] = {
        ...service,
        basePrice: service.price,
        commission: seller.commission,
        finalPrice: finalPrice,
        sellerPrice: finalPrice
      };
    });
    
    res.json({
      success: true,
      seller: {
        id: seller.id,
        shopName: seller.shopName,
        slug: seller.slug,
        commission: seller.commission,
        websiteUrl: seller.websiteUrl,
        createdAt: seller.createdAt
      },
      services: pricesWithCommission,
      message: `Prices include ₹${seller.commission} commission for ${seller.shopName}`
    });
    
  } catch (error) {
    console.error('Get seller by slug error:', error);
    res.status(500).json({ success: false, error: 'Failed to get seller' });
  }
});

// 4. GET SELLER PRICES (for main website)
app.get('/api/seller/:sellerId/prices', async (req, res) => {
  try {
    const { sellerId } = req.params;
    
    const seller = await getSeller(sellerId);
    
    if (!seller) {
      return res.status(404).json({ success: false, error: 'Seller not found' });
    }
    
    // Get prices with commission
    const pricesWithCommission = {};
    Object.keys(countries).forEach(key => {
      const service = countries[key];
      const finalPrice = calculatePriceWithCommission(service.price, seller.commission);
      pricesWithCommission[key] = {
        ...service,
        basePrice: service.price,
        commission: seller.commission,
        finalPrice: finalPrice,
        sellerPrice: finalPrice
      };
    });
    
    res.json({
      success: true,
      seller: {
        id: seller.id,
        shopName: seller.shopName,
        commission: seller.commission
      },
      prices: pricesWithCommission
    });
    
  } catch (error) {
    console.error('Get seller prices error:', error);
    res.status(500).json({ success: false, error: 'Failed to get seller prices' });
  }
});

// 5. GET SELLER DASHBOARD STATS
app.get('/api/seller/:sellerId/dashboard', async (req, res) => {
  try {
    const { sellerId } = req.params;
    const authHeader = req.headers.authorization;
    
    // Verify auth
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const user = await getUserByToken(token);
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    // Verify seller ownership
    const seller = await getSeller(sellerId);
    
    if (!seller) {
      return res.status(404).json({ success: false, error: 'Seller not found' });
    }
    
    if (seller.userId !== user.uid) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    
    // Get wallet
    const walletRef = admin.database().ref('sellerWallets/' + sellerId);
    const walletSnapshot = await walletRef.once('value');
    const wallet = walletSnapshot.val() || { balance: 0, pending: 0, totalEarned: 0 };
    
    // Get sales (last 30 days)
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const salesRef = admin.database().ref('sellerSales').orderByChild('sellerId').equalTo(sellerId);
    const salesSnapshot = await salesRef.once('value');
    const allSales = salesSnapshot.val() || {};
    
    // Calculate stats
    let totalSales = 0;
    let totalEarnings = 0;
    let recentSales = 0;
    let recentEarnings = 0;
    const salesArray = [];
    
    Object.entries(allSales).forEach(([saleId, sale]) => {
      totalSales++;
      totalEarnings += sale.commission || 0;
      
      if (sale.timestamp > thirtyDaysAgo) {
        recentSales++;
        recentEarnings += sale.commission || 0;
      }
      
      if (salesArray.length < 10) {
        salesArray.push({
          id: saleId,
          ...sale
        });
      }
    });
    
    // Get customer count
    const customersRef = admin.database().ref('sellerCustomers').orderByChild('sellerId').equalTo(sellerId);
    const customersSnapshot = await customersRef.once('value');
    const customers = customersSnapshot.val() || {};
    const customerCount = Object.keys(customers).length;
    
    res.json({
      success: true,
      stats: {
        walletBalance: wallet.balance || 0,
        pendingBalance: wallet.pending || 0,
        totalEarned: wallet.totalEarned || 0,
        totalSales: totalSales,
        totalEarnings: totalEarnings,
        recentSales: recentSales,
        recentEarnings: recentEarnings,
        customerCount: customerCount,
        commissionRate: seller.commission
      },
      recentSales: salesArray.reverse(),
      seller: {
        id: sellerId,
        shopName: seller.shopName,
        slug: seller.slug,
        websiteUrl: seller.websiteUrl
      }
    });
    
  } catch (error) {
    console.error('Seller dashboard error:', error);
    res.status(500).json({ success: false, error: 'Failed to load dashboard' });
  }
});

// 6. RECORD SELLER SALE (called from getNumber endpoint)
app.post('/api/seller/record-sale', async (req, res) => {
  try {
    const { sellerId, orderId, customerId, service, basePrice, finalPrice, commission } = req.body;
    
    if (!sellerId || !orderId || !service) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const seller = await getSeller(sellerId);
    
    if (!seller) {
      return res.status(404).json({ success: false, error: 'Seller not found' });
    }
    
    // Record sale
    const saleData = {
      sellerName: seller.shopName,
      orderId: orderId,
      customerId: customerId || 'anonymous',
      service: service,
      basePrice: basePrice,
      finalPrice: finalPrice,
      commission: commission || (finalPrice - basePrice),
      status: 'completed'
    };
    
    const saleId = await recordSellerSale(sellerId, saleData);
    
    if (!saleId) {
      return res.status(500).json({ success: false, error: 'Failed to record sale' });
    }
    
    // Update seller wallet
    await updateSellerWallet(sellerId, saleData.commission, 'commission');
    
    // Record customer if exists
    if (customerId && customerId !== 'anonymous') {
      const customerRef = admin.database().ref('sellerCustomers/' + customerId);
      const customerSnapshot = await customerRef.once('value');
      const customer = customerSnapshot.val() || {};
      
      await customerRef.update({
        sellerId: sellerId,
        firstPurchase: customer.firstPurchase || Date.now(),
        lastPurchase: Date.now(),
        totalSpent: (customer.totalSpent || 0) + finalPrice,
        purchaseCount: (customer.purchaseCount || 0) + 1
      });
    }
    
    console.log(`✅ Seller sale recorded: ${seller.shopName} earned ₹${saleData.commission}`);
    
    res.json({
      success: true,
      message: 'Sale recorded successfully',
      saleId: saleId,
      commission: saleData.commission
    });
    
  } catch (error) {
    console.error('Record seller sale error:', error);
    res.status(500).json({ success: false, error: 'Failed to record sale' });
  }
});

// ========== MODIFIED GETNUMBER ENDPOINT ==========
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
    
    // Check if seller referral exists
    let sellerId = null;
    let sellerCommission = 0;
    let finalPrice = service.price;
    let sellerData = null;
    
    if (ref && ref.startsWith('SEL')) {
      sellerData = await getSeller(ref);
      if (sellerData) {
        sellerId = ref;
        sellerCommission = sellerData.commission || 0;
        finalPrice = calculatePriceWithCommission(service.price, sellerCommission);
        
        console.log(`💰 Seller commission applied: ${sellerData.shopName}, ₹${sellerCommission}`);
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
    const response = await axios.get(url, { timeout: 10000 });
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
        commission: sellerCommission,
        sellerId: sellerId,
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
        commission: sellerCommission,
        sellerId: sellerId,
        sellerName: sellerData?.shopName,
        status: 'active',
        timestamp: Date.now(),
        expiresAt: Date.now() + (15 * 60 * 1000)
      });
      
      // Record seller sale if applicable
      if (sellerId && sellerCommission > 0) {
        // Record sale in background (don't wait for it)
        recordSellerSale(sellerId, {
          sellerName: sellerData.shopName,
          orderId: transactionId,
          customerId: user.uid,
          service: service.name,
          basePrice: service.price,
          finalPrice: finalPrice,
          commission: sellerCommission,
          status: 'completed'
        }).then(saleId => {
          if (saleId) {
            console.log(`✅ Seller sale recorded in background: ${saleId}`);
          }
        }).catch(err => {
          console.error('Background sale recording failed:', err);
        });
        
        // Update seller wallet
        updateSellerWallet(sellerId, sellerCommission, 'commission').catch(err => {
          console.error('Background wallet update failed:', err);
        });
      }
      
      res.json({
        success: true,
        id: transactionId,
        number: phoneNumber,
        country: service.country,
        service: service.name,
        price: finalPrice,
        basePrice: service.price,
        commission: sellerCommission,
        sellerId: sellerId,
        sellerName: sellerData?.shopName,
        expiresIn: 900,
        newBalance: newBalance,
        message: sellerId ? `Number purchased with ₹${sellerCommission} seller commission` : 'Number purchased successfully'
      });
    } else {
      res.json({ success: false, error: data });
    }
  } catch (error) {
    console.error('Get number error:', error);
    res.status(500).json({ success: false, error: 'Service temporarily unavailable' });
  }
});

// ========== EXISTING ENDPOINTS (UNCHANGED) ==========
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Happy OTP API',
    version: '2.0'
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
        sellerId: user.sellerId
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
    if (ref && ref.startsWith('SEL')) {
      const seller = await getSeller(ref);
      if (seller) {
        userData.referredBy = ref;
        userData.sellerReferral = seller.shopName;
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
      sellerId: data.sellerId || null,
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
      '/api/register',
      '/api/seller/register',
      '/api/seller/:sellerId',
      '/api/seller/slug/:slug',
      '/api/seller/:sellerId/prices',
      '/api/seller/:sellerId/dashboard',
      '/api/seller/record-sale'
    ]
  });
});

// Export for Vercel
module.exports = app;

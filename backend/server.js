const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const app = express();
const PORT = 3000;

// ==================== FILE UPLOAD SETUP ====================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
    console.log('📁 Uploads directory created');
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'screenshot-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Only JPEG, PNG, WEBP images are allowed'), false);
    }
};

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: fileFilter
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(uploadDir));

// ==================== DATABASE ====================
let db = null;
const dbDir = path.join(__dirname, 'database');
const dbPath = path.join(dbDir, 'winpaisa.db');

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir);
}

async function initDB() {
    db = await open({ filename: dbPath, driver: sqlite3.Database });
    
    await db.exec(`DROP TABLE IF EXISTS game_history`);
    await db.exec(`DROP TABLE IF EXISTS deposits`);
    await db.exec(`DROP TABLE IF EXISTS withdrawals`);
    await db.exec(`DROP TABLE IF EXISTS otps`);
    await db.exec(`DROP TABLE IF EXISTS users`);
    
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mobile TEXT UNIQUE NOT NULL,
            name TEXT,
            balance INTEGER DEFAULT 0,
            total_deposited INTEGER DEFAULT 0,
            total_withdrawn INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS otps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mobile TEXT NOT NULL,
            otp TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            used INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS deposits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            method TEXT NOT NULL,
            transaction_id TEXT,
            screenshot TEXT,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            method TEXT NOT NULL,
            account TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS game_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            game TEXT NOT NULL,
            bet_amount INTEGER NOT NULL,
            win_amount INTEGER DEFAULT 0,
            result TEXT,
            user_choice TEXT,
            is_demo INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    
    console.log('✅ Database ready');
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ==================== API ENDPOINTS ====================

// 1. SEND OTP
app.post('/api/send-otp', async (req, res) => {
    try {
        const { mobile } = req.body;
        if (!mobile || mobile.length < 10) {
            return res.status(400).json({ success: false, message: 'Valid mobile number required' });
        }
        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60000);
        await db.run('DELETE FROM otps WHERE mobile = ?', [mobile]);
        await db.run('INSERT INTO otps (mobile, otp, expires_at) VALUES (?, ?, ?)', [mobile, otp, expiresAt.toISOString()]);
        console.log(`📱 OTP for ${mobile}: ${otp}`);
        res.json({ success: true, message: 'OTP generated!', otp: otp });
    } catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 2. VERIFY OTP
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { mobile, otp } = req.body;
        const otpRecord = await db.get(`SELECT * FROM otps WHERE mobile = ? AND otp = ? AND used = 0 AND expires_at > datetime('now')`, [mobile, otp]);
        if (!otpRecord) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }
        await db.run('UPDATE otps SET used = 1 WHERE id = ?', [otpRecord.id]);
        let user = await db.get('SELECT * FROM users WHERE mobile = ?', [mobile]);
        if (!user) {
            const result = await db.run('INSERT INTO users (mobile, name, balance) VALUES (?, ?, ?)', [mobile, `Player_${mobile.slice(-4)}`, 0]);
            user = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
        }
        const token = jwt.sign({ id: user.id, mobile: user.mobile }, 'winpaisa_secret', { expiresIn: '7d' });
        res.json({ success: true, token, user: { id: user.id, mobile: user.mobile, name: user.name, balance: user.balance, totalDeposited: user.total_deposited, totalWithdrawn: user.total_withdrawn } });
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ success: false, message: 'Verification failed' });
    }
});

// 3. DEPOSIT
app.post('/api/deposit', upload.single('screenshot'), async (req, res) => {
    try {
        const { userId, amount, method, transactionId } = req.body;
        const screenshot = req.file ? `/uploads/${req.file.filename}` : null;
        if (!userId || amount < 50) return res.status(400).json({ success: false, message: 'Minimum 50 PKR' });
        if (!transactionId) return res.status(400).json({ success: false, message: 'Transaction ID required' });
        if (!screenshot) return res.status(400).json({ success: false, message: 'Screenshot required' });
        await db.run(`INSERT INTO deposits (user_id, amount, method, transaction_id, screenshot) VALUES (?, ?, ?, ?, ?)`, [userId, amount, method, transactionId, screenshot]);
        res.json({ success: true, message: 'Deposit submitted! Admin will verify.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. ADMIN APIs
app.get('/api/admin/deposits/pending', async (req, res) => {
    const deposits = await db.all(`SELECT d.*, u.mobile, u.name FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = 'pending'`);
    res.json({ success: true, deposits });
});

app.post('/api/admin/deposit/approve', async (req, res) => {
    try {
        const { depositId } = req.body;
        const deposit = await db.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
        await db.run('UPDATE deposits SET status = "approved" WHERE id = ?', [depositId]);
        await db.run('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE id = ?', [deposit.amount, deposit.amount, deposit.user_id]);
        res.json({ success: true, message: 'Deposit approved!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/users', async (req, res) => {
    const users = await db.all('SELECT * FROM users');
    res.json({ success: true, users });
});

app.post('/api/admin/add-balance', async (req, res) => {
    const { userId, amount, reason } = req.body;
    await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
    const updated = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
    res.json({ success: true, newBalance: updated.balance });
});

app.get('/api/user/:userId', async (req, res) => {
    const user = await db.get('SELECT id, mobile, name, balance FROM users WHERE id = ?', [req.params.userId]);
    res.json({ success: true, user });
});

// ==================== GAMES - 50 PKR BET, 30% WIN, 40 PKR WIN ====================

// DEMO COIN FLIP
app.post('/api/game/demo/coinflip', async (req, res) => {
    const { userId, choice } = req.body;
    const result = Math.random() < 0.5 ? 'HEADS' : 'TAILS';
    const isWin = (choice === result) && (Math.random() < 0.3);
    const wouldWinAmount = isWin ? 40 : 0;
    await db.run(`INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, 'coinflip', 50, wouldWinAmount, result, choice, 1]);
    res.json({ success: true, demoMode: true, userChoice: choice, result, isWin, wouldWinAmount });
});

// DEMO CARD GAME
app.post('/api/game/demo/cardgame', async (req, res) => {
    const { userId, choice } = req.body;
    const cards = [{ name: 'WINNER!', winAmount: 40, message: 'YOU WIN 40 PKR!' }, { name: 'LOSER', winAmount: 0, message: 'YOU LOSE' }, { name: 'LOSER', winAmount: 0, message: 'YOU LOSE' }];
    const shuffled = [...cards];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const selected = shuffled[choice - 1];
    await db.run(`INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, 'cardgame', 50, selected.winAmount, `${selected.name} - ${selected.message}`, choice.toString(), 1]);
    res.json({ success: true, demoMode: true, userChoice: choice, card: selected.name, resultMsg: selected.message, wouldWinAmount: selected.winAmount });
});

// REAL COIN FLIP
app.post('/api/game/coinflip', async (req, res) => {
    try {
        const { userId, betAmount, choice } = req.body;
        const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        if (user.balance < betAmount) return res.status(400).json({ success: false, message: 'Insufficient balance' });
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);
        const result = Math.random() < 0.5 ? 'HEADS' : 'TAILS';
        const isWin = (choice === result) && (Math.random() < 0.3);
        let winAmount = 0;
        if (isWin) { winAmount = 40; await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [winAmount, userId]); }
        await db.run(`INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, 'coinflip', betAmount, winAmount, result, choice, 0]);
        const updated = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        res.json({ success: true, userChoice: choice, result, isWin, winAmount, newBalance: updated.balance });
    } catch (error) {
        console.error('Coin Flip error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// REAL CARD GAME
app.post('/api/game/cardgame', async (req, res) => {
    try {
        const { userId, betAmount, choice } = req.body;
        const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        if (user.balance < betAmount) return res.status(400).json({ success: false, message: 'Insufficient balance' });
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);
        const cards = [{ name: 'WINNER!', winAmount: 40, message: 'YOU WIN 40 PKR!' }, { name: 'LOSER', winAmount: 0, message: 'YOU LOSE' }, { name: 'LOSER', winAmount: 0, message: 'YOU LOSE' }];
        const shuffled = [...cards];
        for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
        const selected = shuffled[choice - 1];
        let winAmount = selected.winAmount;
        if (winAmount > 0) { await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [winAmount, userId]); }
        await db.run(`INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, 'cardgame', betAmount, winAmount, `${selected.name} - ${selected.message}`, choice.toString(), 0]);
        const updated = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        res.json({ success: true, userChoice: choice, card: selected.name, resultMsg: selected.message, winAmount, newBalance: updated.balance });
    } catch (error) {
        console.error('Card Game error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// WITHDRAW
app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, method, account } = req.body;
    const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
    if (amount < 500) return res.status(400).json({ success: false, message: 'Minimum 500 PKR' });
    if (user.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient balance' });
    await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, userId]);
    await db.run(`INSERT INTO withdrawals (user_id, amount, method, account) VALUES (?, ?, ?, ?)`, [userId, amount, method, account]);
    res.json({ success: true, message: 'Withdrawal request submitted' });
});

// LIVE WINS
app.get('/api/live-wins', async (req, res) => {
    const wins = await db.all(`SELECT gh.*, u.name FROM game_history gh JOIN users u ON gh.user_id = u.id WHERE gh.win_amount > 0 AND gh.is_demo = 0 ORDER BY gh.created_at DESC LIMIT 10`);
    res.json({ success: true, wins });
});

app.get('/api/admin/stats', async (req, res) => {
    const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
    res.json({ success: true, stats: { totalUsers: totalUsers?.count || 0 } });
});

// ==================== START SERVER ====================
async function start() {
    await initDB();
    app.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════════════════════════╗
║     🚀 WINPAISA SERVER STARTED 🚀                             ║
╠══════════════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                              ║
║                                                              ║
║  🎮 GAME RULES:                                              ║
║    • Bet: 50 PKR                                             ║
║    • Win Chance: 30%                                         ║
║    • Win Amount: 40 PKR                                      ║
║    • Lose: 0 PKR (bet deducted)                              ║
║                                                              ║
║  👑 Admin: Triple click "WINPAISA" logo                     ║
╚══════════════════════════════════════════════════════════════╝
        `);
    });
}

start();
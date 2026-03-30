const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// File upload setup
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'screenshot-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Database setup
const dbPath = process.env.NODE_ENV === 'production' 
    ? '/tmp/winpaisa.db' 
    : path.join(__dirname, 'database', 'winpaisa.db');

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
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

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ==================== API ENDPOINTS ====================

// Send OTP
app.post('/api/send-otp', (req, res) => {
    try {
        const { mobile } = req.body;
        if (!mobile || mobile.length < 10) {
            return res.status(400).json({ success: false, message: 'Valid mobile number required' });
        }
        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
        
        db.prepare('DELETE FROM otps WHERE mobile = ?').run(mobile);
        db.prepare('INSERT INTO otps (mobile, otp, expires_at) VALUES (?, ?, ?)').run(mobile, otp, expiresAt);
        
        console.log(`📱 OTP for ${mobile}: ${otp}`);
        res.json({ success: true, message: 'OTP generated!', otp: otp });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Verify OTP
app.post('/api/verify-otp', (req, res) => {
    try {
        const { mobile, otp } = req.body;
        const otpRecord = db.prepare(`SELECT * FROM otps WHERE mobile = ? AND otp = ? AND used = 0 AND expires_at > datetime('now')`).get(mobile, otp);
        if (!otpRecord) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }
        db.prepare('UPDATE otps SET used = 1 WHERE id = ?').run(otpRecord.id);
        
        let user = db.prepare('SELECT * FROM users WHERE mobile = ?').get(mobile);
        if (!user) {
            const result = db.prepare('INSERT INTO users (mobile, name, balance) VALUES (?, ?, ?)').run(mobile, `Player_${mobile.slice(-4)}`, 0);
            user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
        }
        
        const token = jwt.sign({ id: user.id, mobile: user.mobile }, 'winpaisa_secret', { expiresIn: '7d' });
        res.json({ success: true, token, user: { id: user.id, mobile: user.mobile, name: user.name, balance: user.balance } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Verification failed' });
    }
});

// Deposit
app.post('/api/deposit', upload.single('screenshot'), (req, res) => {
    try {
        const { userId, amount, method, transactionId } = req.body;
        const screenshot = req.file ? `/uploads/${req.file.filename}` : null;
        if (!userId || amount < 50) return res.status(400).json({ success: false, message: 'Minimum 50 PKR' });
        if (!transactionId) return res.status(400).json({ success: false, message: 'Transaction ID required' });
        if (!screenshot) return res.status(400).json({ success: false, message: 'Screenshot required' });
        
        db.prepare(`INSERT INTO deposits (user_id, amount, method, transaction_id, screenshot) VALUES (?, ?, ?, ?, ?)`).run(userId, amount, method, transactionId, screenshot);
        res.json({ success: true, message: 'Deposit submitted! Admin will verify.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Withdraw
app.post('/api/withdraw', (req, res) => {
    try {
        const { userId, amount, method, account } = req.body;
        const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
        if (amount < 500) return res.status(400).json({ success: false, message: 'Minimum 500 PKR' });
        if (user.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient balance' });
        
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, userId);
        db.prepare(`INSERT INTO withdrawals (user_id, amount, method, account) VALUES (?, ?, ?, ?)`).run(userId, amount, method, account);
        res.json({ success: true, message: 'Withdrawal request submitted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Coin Flip Game
app.post('/api/game/coinflip', (req, res) => {
    try {
        const { userId, betAmount, choice } = req.body;
        const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
        if (user.balance < betAmount) return res.status(400).json({ success: false, message: 'Insufficient balance' });
        
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(betAmount, userId);
        const result = Math.random() < 0.5 ? 'HEADS' : 'TAILS';
        const isWin = (choice === result) && (Math.random() < 0.3);
        let winAmount = 0;
        if (isWin) { winAmount = 40; db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(winAmount, userId); }
        
        db.prepare(`INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, 'coinflip', betAmount, winAmount, result, choice, 0);
        const updated = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
        res.json({ success: true, result, isWin, winAmount, newBalance: updated.balance });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Card Game
app.post('/api/game/cardgame', (req, res) => {
    try {
        const { userId, betAmount, choice } = req.body;
        const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
        if (user.balance < betAmount) return res.status(400).json({ success: false, message: 'Insufficient balance' });
        
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(betAmount, userId);
        const cards = [
            { name: 'WINNER!', winAmount: 40, message: 'YOU WIN 40 PKR!' },
            { name: 'LOSER', winAmount: 0, message: 'YOU LOSE' },
            { name: 'LOSER', winAmount: 0, message: 'YOU LOSE' }
        ];
        const shuffled = [...cards];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const selected = shuffled[choice - 1];
        let winAmount = selected.winAmount;
        if (winAmount > 0) db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(winAmount, userId);
        
        db.prepare(`INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, 'cardgame', betAmount, winAmount, `${selected.name} - ${selected.message}`, choice.toString(), 0);
        const updated = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
        res.json({ success: true, card: selected.name, resultMsg: selected.message, winAmount, newBalance: updated.balance });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Demo Games
app.post('/api/game/demo/coinflip', (req, res) => {
    const { userId, choice } = req.body;
    const result = Math.random() < 0.5 ? 'HEADS' : 'TAILS';
    const isWin = (choice === result) && (Math.random() < 0.3);
    const wouldWinAmount = isWin ? 40 : 0;
    db.prepare(`INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, 'coinflip', 50, wouldWinAmount, result, choice, 1);
    res.json({ success: true, demoMode: true, result, isWin, wouldWinAmount });
});

app.post('/api/game/demo/cardgame', (req, res) => {
    const { userId, choice } = req.body;
    const cards = [
        { name: 'WINNER!', winAmount: 40, message: 'YOU WIN 40 PKR!' },
        { name: 'LOSER', winAmount: 0, message: 'YOU LOSE' },
        { name: 'LOSER', winAmount: 0, message: 'YOU LOSE' }
    ];
    const shuffled = [...cards];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const selected = shuffled[choice - 1];
    db.prepare(`INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, 'cardgame', 50, selected.winAmount, `${selected.name} - ${selected.message}`, choice.toString(), 1);
    res.json({ success: true, demoMode: true, card: selected.name, resultMsg: selected.message, wouldWinAmount: selected.winAmount });
});

// Get user
app.get('/api/user/:userId', (req, res) => {
    const user = db.prepare('SELECT id, mobile, name, balance FROM users WHERE id = ?').get(req.params.userId);
    res.json({ success: true, user });
});

// Admin APIs
app.get('/api/admin/users', (req, res) => {
    const users = db.prepare('SELECT * FROM users').all();
    res.json({ success: true, users });
});

app.post('/api/admin/add-balance', (req, res) => {
    const { userId, amount, reason } = req.body;
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
    const updated = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    res.json({ success: true, newBalance: updated.balance });
});

app.get('/api/admin/deposits/pending', (req, res) => {
    const deposits = db.prepare(`SELECT d.*, u.mobile FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = 'pending'`).all();
    res.json({ success: true, deposits });
});

app.post('/api/admin/deposit/approve', (req, res) => {
    const { depositId } = req.body;
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
    db.prepare('UPDATE deposits SET status = "approved" WHERE id = ?').run(depositId);
    db.prepare('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE id = ?').run(deposit.amount, deposit.amount, deposit.user_id);
    res.json({ success: true });
});

app.get('/api/live-wins', (req, res) => {
    const wins = db.prepare(`SELECT gh.*, u.name FROM game_history gh JOIN users u ON gh.user_id = u.id WHERE gh.win_amount > 0 AND gh.is_demo = 0 ORDER BY gh.created_at DESC LIMIT 10`).all();
    res.json({ success: true, wins });
});

app.get('/api/admin/stats', (req, res) => {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
    res.json({ success: true, stats: { totalUsers: totalUsers?.count || 0 } });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║     🚀 WINPAISA BACKEND SERVER STARTED 🚀                     ║
╠══════════════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                              ║
║                                                              ║
║  🎮 GAME RULES:                                              ║
║    • Bet: 50 PKR                                             ║
║    • Win: 40 PKR                                             ║
║    • Win Chance: 30%                                         ║
║                                                              ║
║  👑 Admin: Triple click "WINPAISA" logo                     ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
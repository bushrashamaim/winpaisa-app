const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ==================== FILE UPLOAD ====================
// Render.com ke liye uploads folder - /tmp mein banayein
const uploadDir = process.env.RENDER ? '/tmp/uploads' : path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'screenshot-' + unique + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// ==================== DATABASE SETUP ====================
let db = null;
// Render.com ke liye database /tmp mein rakhein
const dbPath = process.env.RENDER ? '/tmp/winpaisa.db' : path.join(__dirname, 'database', 'winpaisa.db');

async function initDatabase() {
    try {
        console.log('📁 Database path:', dbPath);
        
        db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });

        // Create tables
        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mobile TEXT UNIQUE NOT NULL,
                name TEXT,
                balance INTEGER DEFAULT 0,
                total_deposited INTEGER DEFAULT 0,
                total_withdrawn INTEGER DEFAULT 0,
                games_played INTEGER DEFAULT 0,
                games_won INTEGER DEFAULT 0,
                is_admin INTEGER DEFAULT 0,
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
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS admins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mobile TEXT UNIQUE NOT NULL,
                name TEXT,
                role TEXT DEFAULT 'admin',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Check if admin exists
        const adminCount = await db.get('SELECT COUNT(*) as count FROM admins');
        if (adminCount.count === 0) {
            await db.run('INSERT INTO admins (mobile, name, role) VALUES (?, ?, ?)', 
                ['03075030001', 'Super Admin', 'super_admin']);
            console.log('✅ Default admin created: 03075030001');
        }

        console.log('✅ Database ready');
        return true;
    } catch (error) {
        console.error('❌ Database error:', error);
        return false;
    }
}

// ==================== AUTH MIDDLEWARE ====================
function verifyToken(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) {
        return res.status(401).json({ success: false, message: 'No token provided' });
    }
    
    try {
        const decoded = jwt.verify(token.replace('Bearer ', ''), 'winpaisa_secret');
        req.userId = decoded.id;
        req.userMobile = decoded.mobile;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
}

// Admin check middleware
async function checkAdmin(req, res, next) {
    try {
        const user = await db.get('SELECT is_admin FROM users WHERE id = ?', [req.userId]);
        if (!user || !user.is_admin) {
            const admin = await db.get('SELECT * FROM admins WHERE mobile = ?', [req.userMobile]);
            if (!admin) {
                return res.status(403).json({ success: false, message: 'Admin access required' });
            }
        }
        next();
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

// ==================== HELPERS ====================
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
        const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
        
        await db.run('DELETE FROM otps WHERE mobile = ?', [mobile]);
        await db.run('INSERT INTO otps (mobile, otp, expires_at) VALUES (?, ?, ?)', [mobile, otp, expiresAt]);
        
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
        
        const otpRecord = await db.get(
            `SELECT * FROM otps WHERE mobile = ? AND otp = ? AND used = 0 AND expires_at > datetime('now')`,
            [mobile, otp]
        );
        
        if (!otpRecord) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }
        
        await db.run('UPDATE otps SET used = 1 WHERE id = ?', [otpRecord.id]);
        
        let user = await db.get('SELECT * FROM users WHERE mobile = ?', [mobile]);
        
        if (!user) {
            const admin = await db.get('SELECT * FROM admins WHERE mobile = ?', [mobile]);
            const isAdmin = admin ? 1 : 0;
            
            const result = await db.run(
                'INSERT INTO users (mobile, name, balance, games_played, games_won, is_admin) VALUES (?, ?, ?, ?, ?, ?)',
                [mobile, `Player_${mobile.slice(-4)}`, 500, 0, 0, isAdmin]
            );
            user = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
        }
        
        const token = jwt.sign({ id: user.id, mobile: user.mobile, isAdmin: user.is_admin }, 'winpaisa_secret', { expiresIn: '7d' });
        
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                mobile: user.mobile,
                name: user.name,
                balance: user.balance,
                games_played: user.games_played || 0,
                games_won: user.games_won || 0,
                is_admin: user.is_admin || 0,
                total_deposited: user.total_deposited || 0,
                total_withdrawn: user.total_withdrawn || 0
            }
        });
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ success: false, message: 'Verification failed' });
    }
});

// 3. DEPOSIT
app.post('/api/deposit', verifyToken, upload.single('screenshot'), async (req, res) => {
    try {
        const { amount, method, transactionId } = req.body;
        const userId = req.userId;
        const screenshot = req.file ? `/uploads/${req.file.filename}` : null;
        
        if (!userId || amount < 50) {
            return res.status(400).json({ success: false, message: 'Minimum deposit 50 PKR' });
        }
        if (!transactionId) {
            return res.status(400).json({ success: false, message: 'Transaction ID required' });
        }
        if (!screenshot) {
            return res.status(400).json({ success: false, message: 'Screenshot required' });
        }
        
        await db.run(
            `INSERT INTO deposits (user_id, amount, method, transaction_id, screenshot, status) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, amount, method, transactionId, screenshot, 'pending']
        );
        
        res.json({ success: true, message: 'Deposit submitted! Admin will verify.' });
    } catch (error) {
        console.error('Deposit error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. WITHDRAW
app.post('/api/withdraw', verifyToken, async (req, res) => {
    try {
        const { amount, method, account } = req.body;
        const userId = req.userId;
        const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        if (amount < 500) {
            return res.status(400).json({ success: false, message: 'Minimum withdrawal 500 PKR' });
        }
        if (user.balance < amount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }
        
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, userId]);
        await db.run('UPDATE users SET total_withdrawn = total_withdrawn + ? WHERE id = ?', [amount, userId]);
        await db.run(
            `INSERT INTO withdrawals (user_id, amount, method, account, status) VALUES (?, ?, ?, ?, ?)`,
            [userId, amount, method, account, 'pending']
        );
        
        res.json({ success: true, message: 'Withdrawal request submitted' });
    } catch (error) {
        console.error('Withdraw error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 5. COIN FLIP GAME
app.post('/api/game/coinflip', verifyToken, async (req, res) => {
    try {
        const { betAmount, choice } = req.body;
        const userId = req.userId;
        
        const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        if (user.balance < betAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }
        
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);
        
        const result = Math.random() < 0.5 ? 'HEADS' : 'TAILS';
        const isWin = (choice === result) && (Math.random() < 0.35);
        
        let winAmount = 0;
        if (isWin) {
            winAmount = Math.floor(betAmount * 1.8);
            await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [winAmount, userId]);
            await db.run('UPDATE users SET games_won = games_won + 1 WHERE id = ?', [userId]);
        }
        
        await db.run('UPDATE users SET games_played = games_played + 1 WHERE id = ?', [userId]);
        
        await db.run(
            `INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, 'coinflip', betAmount, winAmount, result, choice]
        );
        
        const updatedUser = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        res.json({
            success: true,
            result,
            isWin,
            winAmount,
            newBalance: updatedUser.balance
        });
    } catch (error) {
        console.error('Coin Flip error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 6. SPIN WHEEL GAME
app.post('/api/game/spinwheel', verifyToken, async (req, res) => {
    try {
        const { betAmount } = req.body;
        const userId = req.userId;
        
        const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        if (user.balance < betAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }
        
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);
        
        const prizes = [
            { value: 0, name: "0 PKR - Try Again" },
            { value: 0, name: "0 PKR - Try Again" },
            { value: 50, name: "WIN 50 PKR" },
            { value: 50, name: "WIN 50 PKR" },
            { value: 100, name: "WIN 100 PKR" },
            { value: 100, name: "WIN 100 PKR" },
            { value: 150, name: "WIN 150 PKR" },
            { value: 200, name: "WIN 200 PKR 🎉" },
            { value: 300, name: "WIN 300 PKR" },
            { value: 500, name: "WIN 500 PKR" }
        ];
        
        const randomIndex = Math.floor(Math.random() * prizes.length);
        const selected = prizes[randomIndex];
        const isWin = selected.value > 0;
        const winAmount = isWin ? selected.value : 0;
        const multiplier = isWin ? (selected.value / betAmount).toFixed(1) : 0;
        
        if (isWin) {
            await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [winAmount, userId]);
            await db.run('UPDATE users SET games_won = games_won + 1 WHERE id = ?', [userId]);
        }
        
        await db.run('UPDATE users SET games_played = games_played + 1 WHERE id = ?', [userId]);
        
        await db.run(
            `INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, 'spinwheel', betAmount, winAmount, selected.name, 'spin']
        );
        
        const updatedUser = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        res.json({
            success: true,
            segment: selected.name,
            multiplier: parseFloat(multiplier),
            isWin,
            winAmount,
            newBalance: updatedUser.balance
        });
    } catch (error) {
        console.error('Spin Wheel error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 7. CARD GAME
app.post('/api/game/cardgame', verifyToken, async (req, res) => {
    try {
        const { betAmount, choice } = req.body;
        const userId = req.userId;
        
        const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        if (user.balance < betAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }
        
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);
        
        const cards = [
            { name: 'WINNER! 🎉', winAmount: Math.floor(betAmount * 1.7), message: 'YOU WIN!' },
            { name: 'LOSER', winAmount: 0, message: 'YOU LOSE' },
            { name: 'LOSER', winAmount: 0, message: 'YOU LOSE' }
        ];
        
        const shuffled = [...cards];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        
        const selected = shuffled[choice - 1];
        const isWin = selected.winAmount > 0;
        const winAmount = selected.winAmount;
        
        if (isWin) {
            await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [winAmount, userId]);
            await db.run('UPDATE users SET games_won = games_won + 1 WHERE id = ?', [userId]);
        }
        
        await db.run('UPDATE users SET games_played = games_played + 1 WHERE id = ?', [userId]);
        
        await db.run(
            `INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, 'cardgame', betAmount, winAmount, `${selected.name} - ${selected.message}`, choice.toString()]
        );
        
        const updatedUser = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        res.json({
            success: true,
            card: selected.name,
            resultMsg: selected.message,
            isWin,
            winAmount,
            newBalance: updatedUser.balance
        });
    } catch (error) {
        console.error('Card Game error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 8. GET USER
app.get('/api/user', verifyToken, async (req, res) => {
    try {
        const user = await db.get(
            'SELECT id, mobile, name, balance, games_played, games_won, total_deposited, total_withdrawn, is_admin FROM users WHERE id = ?',
            [req.userId]
        );
        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 9. GET LIVE WINS
app.get('/api/live-wins', async (req, res) => {
    try {
        const wins = await db.all(
            `SELECT gh.*, u.name, u.mobile FROM game_history gh 
             JOIN users u ON gh.user_id = u.id 
             WHERE gh.win_amount > 0 
             ORDER BY gh.created_at DESC LIMIT 10`
        );
        res.json({ success: true, wins });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 10. ADMIN APIs
app.get('/api/admin/users', verifyToken, checkAdmin, async (req, res) => {
    try {
        const users = await db.all('SELECT * FROM users ORDER BY id DESC');
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/deposits/pending', verifyToken, checkAdmin, async (req, res) => {
    try {
        const deposits = await db.all(
            `SELECT d.*, u.mobile, u.name FROM deposits d 
             JOIN users u ON d.user_id = u.id 
             WHERE d.status = 'pending' 
             ORDER BY d.created_at DESC`
        );
        res.json({ success: true, deposits });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/deposit/approve', verifyToken, checkAdmin, async (req, res) => {
    try {
        const { depositId } = req.body;
        const deposit = await db.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
        
        if (!deposit || deposit.status !== 'pending') {
            return res.status(400).json({ success: false, message: 'Invalid deposit' });
        }
        
        await db.run('UPDATE deposits SET status = "approved" WHERE id = ?', [depositId]);
        await db.run(
            'UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE id = ?',
            [deposit.amount, deposit.amount, deposit.user_id]
        );
        
        res.json({ success: true, message: 'Deposit approved!' });
    } catch (error) {
        console.error('Approve error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/add-balance', verifyToken, checkAdmin, async (req, res) => {
    try {
        const { userId, amount } = req.body;
        await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
        const updated = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        res.json({ success: true, newBalance: updated.balance });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ==================== START SERVER ====================
async function startServer() {
    try {
        console.log('🚀 Starting WINPAISA Server...');
        console.log('📁 Environment:', process.env.RENDER ? 'Render.com' : 'Local');
        
        const dbInit = await initDatabase();
        if (!dbInit) {
            throw new Error('Database initialization failed');
        }
        
        app.listen(PORT, () => {
            console.log(`
╔══════════════════════════════════════════════════════════════╗
║     🚀 WINPAISA BACKEND SERVER STARTED 🚀                     ║
╠══════════════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                              ║
║  API: http://localhost:${PORT}/api                             ║
║                                                              ║
║  🎮 3 GAMES AVAILABLE:                                        ║
║    • Coin Flip - 35% win chance, 1.7x payout                 ║
║    • Spin Wheel - Prizes: 50,100,150,200,300,500 PKR        ║
║    • Card Game - 33% win chance, 1.7x payout                 ║
║                                                              ║
║  📱 Default Admin: 03075030001                                ║
╚══════════════════════════════════════════════════════════════╝
            `);
        });
    } catch (err) {
        console.error('❌ Startup error:', err);
        process.exit(1);
    }
}

startServer();
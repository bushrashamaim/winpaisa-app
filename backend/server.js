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

// ==================== FRONTEND PATH ====================
const frontendPath = path.join(__dirname, '..', 'frontend');
console.log('📁 Frontend path:', frontendPath);

if (!fs.existsSync(frontendPath)) {
    console.error('❌ Frontend folder not found at:', frontendPath);
    const altPath = path.join(__dirname, 'frontend');
    if (fs.existsSync(altPath)) {
        console.log('✅ Found frontend at:', altPath);
        app.use(express.static(altPath));
    } else {
        console.error('❌ No frontend folder found!');
    }
} else {
    console.log('✅ Frontend folder found');
    app.use(express.static(frontendPath));
}

// ==================== FILE UPLOAD ====================
const uploadDir = process.env.RENDER ? '/tmp/uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('📁 Uploads folder created:', uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'screenshot-' + unique + path.extname(file.originalname));
    }
});
const upload = multer({ storage });
app.use('/uploads', express.static(uploadDir));

// ==================== DATABASE SETUP ====================
let db = null;
const dbPath = process.env.RENDER ? '/tmp/winpaisa.db' : path.join(__dirname, 'database', 'winpaisa.db');
console.log('📁 Database path:', dbPath);

async function initDatabase() {
    try {
        db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });

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
                user_name TEXT,
                user_mobile TEXT,
                amount INTEGER NOT NULL,
                method TEXT,
                transaction_id TEXT,
                screenshot TEXT,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS withdrawals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                user_name TEXT,
                user_mobile TEXT,
                amount INTEGER NOT NULL,
                method TEXT,
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
        `);

        console.log('✅ Database ready');
        return true;
    } catch (error) {
        console.error('❌ Database error:', error);
        return false;
    }
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
            const result = await db.run(
                'INSERT INTO users (mobile, name, balance) VALUES (?, ?, ?)',
                [mobile, `Player_${mobile.slice(-4)}`, 0]
            );
            user = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
        }
        
        const token = jwt.sign({ id: user.id, mobile: user.mobile }, 'winpaisa_secret', { expiresIn: '7d' });
        
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
app.post('/api/deposit', upload.single('screenshot'), async (req, res) => {
    try {
        const { userId, userName, userMobile, amount, method, transactionId } = req.body;
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
            `INSERT INTO deposits (user_id, user_name, user_mobile, amount, method, transaction_id, screenshot, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, userName, userMobile, amount, method, transactionId, screenshot, 'pending']
        );
        
        res.json({ success: true, message: 'Deposit submitted! Admin will verify.' });
    } catch (error) {
        console.error('Deposit error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. WITHDRAW
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, userName, userMobile, amount, method, account } = req.body;
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
            `INSERT INTO withdrawals (user_id, user_name, user_mobile, amount, method, account, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, userName, userMobile, amount, method, account, 'pending']
        );
        
        res.json({ success: true, message: 'Withdrawal request submitted' });
    } catch (error) {
        console.error('Withdraw error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 5. COIN FLIP GAME
app.post('/api/game/coinflip', async (req, res) => {
    try {
        const { userId, betAmount, choice } = req.body;
        
        const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        if (user.balance < betAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }
        
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);
        
        const result = Math.random() < 0.5 ? 'HEADS' : 'TAILS';
        const isWin = (choice === result);
        
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
app.post('/api/game/spinwheel', async (req, res) => {
    try {
        const { userId, betAmount } = req.body;
        
        const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        if (user.balance < betAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }
        
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);
        
        const prizes = [
            { value: 0, name: "0 PKR" },
            { value: 0, name: "0 PKR" },
            { value: 50, name: "50 PKR" },
            { value: 100, name: "100 PKR" },
            { value: 200, name: "200 PKR" },
            { value: 300, name: "300 PKR" },
            { value: 500, name: "500 PKR" },
            { value: 700, name: "700 PKR" },
            { value: 1000, name: "1000 PKR" },
            { value: 1500, name: "1500 PKR 🎉" },
            { value: 2000, name: "2000 PKR 🎉" },
            { value: 5000, name: "5000 PKR 🔥" }
        ];
        
// Replace your existing probability block with this:
const random = Math.random() * 100;
let selected = null;

if (random < 60) {        // 60% - Lose
    selected = prizes.find(p => p.value === 0);
} else if (random < 80) { // 20% - ₹50
    selected = prizes.find(p => p.value === 50);
} else if (random < 90) { // 10% - ₹100
    selected = prizes.find(p => p.value === 100);
} else if (random < 95) { // 5% - ₹200
    selected = prizes.find(p => p.value === 200);
} else if (random < 98) { // 3% - ₹500
    selected = prizes.find(p => p.value === 500);
} else if (random < 99.5) { // 1.5% - ₹1000
    selected = prizes.find(p => p.value === 1000);
} else {                 // 0.5% - ₹5000
    selected = prizes.find(p => p.value === 5000);
}

const isWin = selected.value > 0;
const winAmount = isWin ? selected.value : 0;        
        if (isWin) {
            await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [winAmount, userId]);
            await db.run('UPDATE users SET games_won = games_won + 1 WHERE id = ?', [userId]);
        }
        
        await db.run('UPDATE users SET games_played = games_played + 1 WHERE id = ?', [userId]);
        
        await db.run(
            `INSERT INTO game_history (user_id, game, bet_amount, win_amount, result) VALUES (?, ?, ?, ?, ?)`,
            [userId, 'spinwheel', betAmount, winAmount, selected.name]
        );
        
        const updatedUser = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        res.json({
            success: true,
            segment: selected.name,
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
app.post('/api/game/cardgame', async (req, res) => {
    try {
        const { userId, betAmount, choice } = req.body;
        
        const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        if (user.balance < betAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }
        
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);
        
        const isWin = Math.random() < 0.33;
        let winAmount = 0;
        
        if (isWin) {
            winAmount = Math.floor(betAmount * 1.8);
            await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [winAmount, userId]);
            await db.run('UPDATE users SET games_won = games_won + 1 WHERE id = ?', [userId]);
        }
        
        await db.run('UPDATE users SET games_played = games_played + 1 WHERE id = ?', [userId]);
        
        await db.run(
            `INSERT INTO game_history (user_id, game, bet_amount, win_amount, result, user_choice) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, 'cardgame', betAmount, winAmount, isWin ? 'WIN' : 'LOSE', choice.toString()]
        );
        
        const updatedUser = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        res.json({
            success: true,
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
app.get('/api/user/:userId', async (req, res) => {
    try {
        const user = await db.get(
            'SELECT id, mobile, name, balance, games_played, games_won, total_deposited, total_withdrawn FROM users WHERE id = ?',
            [req.params.userId]
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
            `SELECT gh.*, u.name FROM game_history gh 
             JOIN users u ON gh.user_id = u.id 
             WHERE gh.win_amount > 0 
             ORDER BY gh.created_at DESC LIMIT 10`
        );
        res.json({ success: true, wins });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== ADMIN APIs ====================

// Get all users
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await db.all('SELECT * FROM users ORDER BY id DESC');
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get user by mobile
app.get('/api/admin/user-by-mobile/:mobile', async (req, res) => {
    try {
        const { mobile } = req.params;
        const user = await db.get('SELECT id, name, mobile, balance FROM users WHERE mobile = ?', [mobile]);
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get all deposits
app.get('/api/admin/deposits/all', async (req, res) => {
    try {
        const deposits = await db.all(`
            SELECT d.*, u.name as user_name, u.mobile as user_mobile 
            FROM deposits d 
            JOIN users u ON d.user_id = u.id 
            ORDER BY d.created_at DESC
        `);
        res.json({ success: true, deposits });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get pending deposits
app.get('/api/admin/deposits/pending', async (req, res) => {
    try {
        const deposits = await db.all(`
            SELECT d.*, u.name as user_name, u.mobile as user_mobile 
            FROM deposits d 
            JOIN users u ON d.user_id = u.id 
            WHERE d.status = 'pending' 
            ORDER BY d.created_at DESC
        `);
        res.json({ success: true, deposits });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Approve deposit
app.post('/api/admin/deposit/approve', async (req, res) => {
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

// Reject deposit
app.post('/api/admin/deposit/reject', async (req, res) => {
    try {
        const { depositId } = req.body;
        const deposit = await db.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
        
        if (!deposit || deposit.status !== 'pending') {
            return res.status(400).json({ success: false, message: 'Invalid deposit' });
        }
        
        await db.run('UPDATE deposits SET status = "rejected" WHERE id = ?', [depositId]);
        
        res.json({ success: true, message: 'Deposit rejected' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get pending withdrawals
app.get('/api/admin/withdrawals/pending', async (req, res) => {
    try {
        const withdrawals = await db.all(`
            SELECT w.*, u.name as user_name, u.mobile as user_mobile 
            FROM withdrawals w 
            JOIN users u ON w.user_id = u.id 
            WHERE w.status = 'pending' 
            ORDER BY w.created_at DESC
        `);
        res.json({ success: true, withdrawals });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Approve withdrawal
app.post('/api/admin/withdrawal/approve', async (req, res) => {
    try {
        const { withdrawalId } = req.body;
        const withdrawal = await db.get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
        
        if (!withdrawal || withdrawal.status !== 'pending') {
            return res.status(400).json({ success: false, message: 'Invalid withdrawal' });
        }
        
        await db.run('UPDATE withdrawals SET status = "approved" WHERE id = ?', [withdrawalId]);
        
        res.json({ success: true, message: 'Withdrawal approved!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ADD BALANCE MANUALLY - FIXED
app.post('/api/admin/add-balance', async (req, res) => {
    try {
        const { userId, amount, reason } = req.body;
        
        if (!userId || !amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid user or amount' });
        }
        
        const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
        await db.run('UPDATE users SET total_deposited = total_deposited + ? WHERE id = ?', [amount, userId]);
        
        await db.run(
            `INSERT INTO deposits (user_id, user_name, user_mobile, amount, method, transaction_id, screenshot, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, user.name, user.mobile, amount, 'manual', `MANUAL_${Date.now()}`, 'manual', 'approved']
        );
        
        const updated = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        
        console.log(`✅ Admin added ${amount} PKR to user ${userId} (${user.name}) - ${reason || 'Manual'}`);
        
        res.json({ success: true, message: 'Balance added!', newBalance: updated.balance });
    } catch (error) {
        console.error('Add balance error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get admin stats
app.get('/api/admin/stats', async (req, res) => {
    try {
        const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
        const totalDeposits = await db.get('SELECT SUM(amount) as total FROM deposits WHERE status = "approved"');
        const totalWithdrawals = await db.get('SELECT SUM(amount) as total FROM withdrawals WHERE status = "approved"');
        const pendingDeposits = await db.get('SELECT COUNT(*) as count FROM deposits WHERE status = "pending"');
        const totalGames = await db.get('SELECT COUNT(*) as count FROM game_history');
        
        res.json({
            success: true,
            stats: {
                totalUsers: totalUsers?.count || 0,
                totalDeposits: totalDeposits?.total || 0,
                totalWithdrawals: totalWithdrawals?.total || 0,
                pendingDeposits: pendingDeposits?.count || 0,
                totalGames: totalGames?.count || 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== SERVE FRONTEND ====================
app.get('/', (req, res) => {
    const indexPath = path.join(frontendPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send('<h1>Frontend not found. Please check deployment.</h1>');
    }
});

app.get('/admin.html', (req, res) => {
    const adminPath = path.join(frontendPath, 'admin.html');
    if (fs.existsSync(adminPath)) {
        res.sendFile(adminPath);
    } else {
        res.send('<h1>Admin page not found. Please create admin.html in frontend folder.</h1>');
    }
});

// ==================== START SERVER ====================
async function startServer() {
    try {
        console.log('🚀 Starting WINPAISA Server...');
        
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
║  Admin: http://localhost:${PORT}/admin.html                    ║
║                                                              ║
║  🎮 3 GAMES AVAILABLE                                         ║
║  💰 NEW USER BALANCE: 0 PKR                                   ║
║  📱 EasyPaisa: 0307 503 0001                                  ║
║                                                              ║
║  👑 ADMIN PANEL: http://localhost:${PORT}/admin.html           ║
║  🔐 Admin Password: admin123                                  ║
╚══════════════════════════════════════════════════════════════╝
            `);
        });
    } catch (err) {
        console.error('❌ Startup error:', err);
        process.exit(1);
    }
}

startServer();
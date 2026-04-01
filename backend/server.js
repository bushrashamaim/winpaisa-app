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

// ==================== FRONTEND PATH (FIXED FOR RENDER) ====================
const frontendPath = path.join(__dirname, '..', 'frontend');
console.log('📁 Frontend path:', frontendPath);

// Check if frontend folder exists
if (!fs.existsSync(frontendPath)) {
    console.error('❌ Frontend folder not found at:', frontendPath);
    // Try alternative path
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

        // Create tables
        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mobile TEXT UNIQUE NOT NULL,
                name TEXT,
                balance INTEGER DEFAULT 500,
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
                user_name TEXT,
                user_mobile TEXT,
                amount INTEGER NOT NULL,
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
            const result = await db.run(
                'INSERT INTO users (mobile, name, balance) VALUES (?, ?, ?)',
                [mobile, `Player_${mobile.slice(-4)}`, 500]
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
        const { userId, userName, userMobile, amount } = req.body;
        const screenshot = req.file ? `/uploads/${req.file.filename}` : null;
        
        if (!userId || amount < 50) {
            return res.status(400).json({ success: false, message: 'Minimum deposit 50 PKR' });
        }
        if (!screenshot) {
            return res.status(400).json({ success: false, message: 'Screenshot required' });
        }
        
        await db.run(
            `INSERT INTO deposits (user_id, user_name, user_mobile, amount, screenshot, status) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, userName, userMobile, amount, screenshot, 'pending']
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
        const { userId, userName, userMobile, amount, account } = req.body;
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
            `INSERT INTO withdrawals (user_id, user_name, user_mobile, amount, account, status) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, userName, userMobile, amount, account, 'pending']
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
            `INSERT INTO game_history (user_id, game, bet_amount, win_amount, result) VALUES (?, ?, ?, ?, ?)`,
            [userId, 'spinwheel', betAmount, winAmount, selected.name]
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

// 10. ADMIN APIs
app.get('/api/admin/deposits/pending', async (req, res) => {
    try {
        const deposits = await db.all(
            `SELECT * FROM deposits WHERE status = 'pending' ORDER BY created_at DESC`
        );
        res.json({ success: true, deposits });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

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
        console.error('Reject error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/withdrawals/pending', async (req, res) => {
    try {
        const withdrawals = await db.all(
            `SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY created_at DESC`
        );
        res.json({ success: true, withdrawals });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/withdrawal/approve', async (req, res) => {
    try {
        const { withdrawalId } = req.body;
        await db.run('UPDATE withdrawals SET status = "approved" WHERE id = ?', [withdrawalId]);
        res.json({ success: true, message: 'Withdrawal approved!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/add-balance', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
        const updated = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        res.json({ success: true, newBalance: updated.balance });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin stats
app.get('/api/admin/stats', async (req, res) => {
    try {
        const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
        const totalDeposits = await db.get('SELECT SUM(amount) as total FROM deposits WHERE status = "approved"');
        const totalWithdrawals = await db.get('SELECT SUM(amount) as total FROM withdrawals WHERE status = "approved"');
        const pendingDeposits = await db.get('SELECT COUNT(*) as count FROM deposits WHERE status = "pending"');
        
        res.json({
            success: true,
            stats: {
                totalUsers: totalUsers?.count || 0,
                totalDeposits: totalDeposits?.total || 0,
                totalWithdrawals: totalWithdrawals?.total || 0,
                pendingDeposits: pendingDeposits?.count || 0
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
        res.send('<h1>Admin page not found.</h1>');
    }
});

// ==================== START SERVER ====================
async function startServer() {
    try {
        console.log('🚀 Starting WINPAISA Server...');
        console.log('📁 __dirname:', __dirname);
        console.log('📁 Frontend path:', frontendPath);
        
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
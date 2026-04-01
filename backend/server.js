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

// ==================== FILE UPLOAD ====================
const uploadDir = path.join(__dirname, 'uploads');
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
const dbPath = path.join(__dirname, 'database', 'winpaisa.db');

if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

async function initDatabase() {
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
    `);

    console.log('✅ Database ready');
}

// ==================== HELPERS ====================
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Smart Win Logic (35% base, new user boost, loss streak protection)
async function calculateWin(userId, betAmount, choice, result) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const isChoiceMatch = (choice === result);
    
    const recentGames = await db.all(
        `SELECT win_amount FROM game_history 
         WHERE user_id = ? 
         ORDER BY created_at DESC LIMIT 5`,
        [userId]
    );
    
    const lossStreak = recentGames.filter(g => g.win_amount === 0).length;
    const isNewUser = (user.games_played || 0) < 3;
    
    let winChance = 0.35; // Base 35%
    
    if (isNewUser) {
        winChance = 0.65; // 65% for new users
    }
    else if (lossStreak >= 3) {
        winChance = 0.55; // 55% after 3 losses
    }
    else if (lossStreak >= 2) {
        winChance = 0.45; // 45% after 2 losses
    }
    
    const rand = Math.random();
    const isWin = isChoiceMatch && (rand < winChance);
    
    let winAmount = 0;
    if (isWin) {
        const multiplier = 1.7 + (Math.random() * 0.8);
        winAmount = Math.floor(betAmount * multiplier);
    }
    
    return { isWin, winAmount };
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
                'INSERT INTO users (mobile, name, balance, games_played, games_won) VALUES (?, ?, ?, ?, ?)',
                [mobile, `Player_${mobile.slice(-4)}`, 0, 0, 0]
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
                games_won: user.games_won || 0
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
        const { userId, amount, method, transactionId } = req.body;
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
            `INSERT INTO deposits (user_id, amount, method, transaction_id, screenshot) VALUES (?, ?, ?, ?, ?)`,
            [userId, amount, method, transactionId, screenshot]
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
        const { userId, amount, method, account } = req.body;
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
            `INSERT INTO withdrawals (user_id, amount, method, account) VALUES (?, ?, ?, ?)`,
            [userId, amount, method, account]
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
        
        const user = await db.get('SELECT balance, games_played, games_won FROM users WHERE id = ?', [userId]);
        
        if (user.balance < betAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }
        
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);
        
        const result = Math.random() < 0.5 ? 'HEADS' : 'TAILS';
        
        const { isWin, winAmount } = await calculateWin(userId, betAmount, choice, result);
        
        if (isWin) {
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
        
        const user = await db.get('SELECT balance, games_played, games_won FROM users WHERE id = ?', [userId]);
        
        if (user.balance < betAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }
        
        await db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);
        
        // Wheel segments: 8 segments, 4 win (1.2x, 1.5x, 1.8x, 2x), 4 lose (0x)
        const wheelSegments = [
            { multiplier: 0, name: 'LOSE' },
            { multiplier: 1.2, name: 'WIN 1.2x' },
            { multiplier: 0, name: 'LOSE' },
            { multiplier: 1.5, name: 'WIN 1.5x' },
            { multiplier: 0, name: 'LOSE' },
            { multiplier: 2, name: 'WIN 2x' },
            { multiplier: 0, name: 'LOSE' },
            { multiplier: 1.8, name: 'WIN 1.8x' }
        ];
        
        const randomIndex = Math.floor(Math.random() * wheelSegments.length);
        const selected = wheelSegments[randomIndex];
        const isWin = selected.multiplier > 0;
        const winAmount = isWin ? Math.floor(betAmount * selected.multiplier) : 0;
        
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
            multiplier: selected.multiplier,
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
        
        const user = await db.get('SELECT balance, games_played, games_won FROM users WHERE id = ?', [userId]);
        
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
app.get('/api/user/:userId', async (req, res) => {
    try {
        const user = await db.get(
            'SELECT id, mobile, name, balance, games_played, games_won FROM users WHERE id = ?',
            [req.params.userId]
        );
        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 9. ADMIN APIs
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await db.all('SELECT * FROM users ORDER BY id DESC');
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/add-balance', async (req, res) => {
    try {
        const { userId, amount, reason } = req.body;
        await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
        await db.run('UPDATE users SET total_deposited = total_deposited + ? WHERE id = ?', [amount, userId]);
        
        const updated = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
        console.log(`✅ Admin added ${amount} PKR to user ${userId} - ${reason || 'Manual'}`);
        res.json({ success: true, newBalance: updated.balance });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/deposits/pending', async (req, res) => {
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
        console.error('Approve deposit error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

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

app.get('/api/admin/stats', async (req, res) => {
    try {
        const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
        const totalDeposits = await db.get('SELECT SUM(amount) as total FROM deposits WHERE status = "approved"');
        const totalWithdrawals = await db.get('SELECT SUM(amount) as total FROM withdrawals WHERE status = "approved"');
        const totalGames = await db.get('SELECT COUNT(*) as count FROM game_history');
        
        res.json({
            success: true,
            stats: {
                totalUsers: totalUsers?.count || 0,
                totalDeposits: totalDeposits?.total || 0,
                totalWithdrawals: totalWithdrawals?.total || 0,
                totalGames: totalGames?.count || 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== START SERVER ====================
async function startServer() {
    try {
        console.log('⏳ Initializing Database...');
        await initDatabase();
        console.log('✅ Database initialized');
        
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
║    • Spin Wheel - 50% win chance (1.2x, 1.5x, 1.8x, 2x)     ║
║    • Card Game - 33% win chance, 1.7x payout                 ║
║                                                              ║
║  📱 EasyPaisa Number: 0307 5030001                           ║
║                                                              ║
║  👑 Admin Panel: Triple click "WINPAISA" logo               ║
║  💰 Withdrawal: Minimum 500 PKR | Instant                    ║
╚══════════════════════════════════════════════════════════════╝
            `);
        });
    } catch (err) {
        console.error('❌ Startup error:', err);
        process.exit(1);
    }
}

startServer();
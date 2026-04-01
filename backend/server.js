const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken'); // ⚠️ tumne miss kiya tha

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// ==================== ✅ FIXED FRONTEND PATH ====================
app.use(express.static(path.join(__dirname, '../frontend')));

// ==================== Uploads ====================
const uploadDir = process.env.RENDER ? '/tmp/uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// ==================== Database ====================
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
let db = null;

const dbPath = process.env.RENDER
    ? '/tmp/winpaisa.db'
    : path.join(__dirname, 'database', 'winpaisa.db');

async function initDatabase() {
    db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

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
            mobile TEXT,
            otp TEXT,
            expires_at DATETIME,
            used INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS deposits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            amount INTEGER,
            screenshot TEXT,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            amount INTEGER,
            account TEXT,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS game_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            game TEXT,
            bet_amount INTEGER,
            win_amount INTEGER,
            result TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    console.log('✅ Database ready');
}

// ==================== Helper ====================
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ==================== API ====================

// OTP
app.post('/api/send-otp', async (req, res) => {
    try {
        const { mobile } = req.body;
        if (!mobile || mobile.length < 10) {
            return res.status(400).json({ success: false, message: 'Invalid mobile' });
        }

        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();

        await db.run('DELETE FROM otps WHERE mobile = ?', [mobile]);
        await db.run(
            'INSERT INTO otps (mobile, otp, expires_at) VALUES (?, ?, ?)',
            [mobile, otp, expiresAt]
        );

        console.log(`OTP: ${otp}`);
        res.json({ success: true, otp });

    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// VERIFY OTP
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { mobile, otp } = req.body;

        const record = await db.get(
            `SELECT * FROM otps WHERE mobile=? AND otp=? AND used=0`,
            [mobile, otp]
        );

        if (!record) {
            return res.status(400).json({ success: false });
        }

        await db.run('UPDATE otps SET used=1 WHERE id=?', [record.id]);

        let user = await db.get('SELECT * FROM users WHERE mobile=?', [mobile]);

        if (!user) {
            const r = await db.run(
                'INSERT INTO users (mobile,name) VALUES (?,?)',
                [mobile, 'Player']
            );
            user = await db.get('SELECT * FROM users WHERE id=?', [r.lastID]);
        }

        const token = jwt.sign({ id: user.id }, 'secret');

        res.json({ success: true, user, token });

    } catch {
        res.status(500).json({ success: false });
    }
});

// ==================== ROUTES ====================

// ROOT
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ADMIN
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/admin.html'));
});

// SPA fallback (IMPORTANT)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ==================== START ====================
async function start() {
    await initDatabase();

    app.listen(PORT, () => {
        console.log(`🚀 Server running on ${PORT}`);
    });
}

start();
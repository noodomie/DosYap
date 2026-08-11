const express = require('express');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Cloudflare Turnstile Gizli Anahtarı (Secret Key)
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '0x4AAAAAAAx_YOUR_SECRET_KEY';

// Cloudinary Yapılandırması
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Veritabanı Kurulumu (SQLite)
const db = new sqlite3.Database('./dosyap.db', (err) => {
    if (err) console.error('Veritabanı hatası:', err.message);
    else console.log('SQLite Veritabanı bağlandı.');
});

db.run(`
    CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        user_token TEXT NOT NULL,
        title TEXT,
        description TEXT,
        original_name TEXT,
        size INTEGER,
        cloudinary_public_id TEXT,
        cloudinary_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Yükleme dizini oluşturma (RAM yerine disk kullanarak bellek tasarrufu)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 10 * 1024 * 1024 } // 10 MB Sınırı
});

// Rate Limiter: 15 dakikada IP başına maks 10 yükleme
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Çok fazla dosya yükleme isteği attınız. Lütfen 15 dakika sonra tekrar deneyin.' }
});

// Cloudflare Turnstile Doğrulama Fonksiyonu
async function verifyTurnstile(token, ip) {
    if (!token) return false;
    try {
        const formData = new URLSearchParams();
        formData.append('secret', TURNSTILE_SECRET_KEY);
        formData.append('response', token);
        formData.append('remoteip', ip);

        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: formData
        });
        const outcome = await res.json();
        return outcome.success;
    } catch (e) {
        console.error('Turnstile hatası:', e);
        return false;
    }
}

// Statik Dosyaları Sunma
app.use(express.static(path.join(__dirname, 'public')));

// API: Dosya Yükleme
app.post('/api/upload', uploadLimiter, upload.single('file'), async (req, res) => {
    const { title, description, userToken, turnstileToken } = req.body;
    const clientIp = req.ip || req.headers['x-forwarded-for'];

    // 1. Turnstile Bot Doğrulaması
    const isHuman = await verifyTurnstile(turnstileToken, clientIp);
    if (!isHuman) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Bot doğrulaması başarısız oldu.' });
    }

    if (!userToken) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Kullanıcı kimliği eksik.' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'Lütfen bir dosya seçin.' });
    }

    // 2. Kota Kontrolü (Kullanıcı başına maks 10 dosya)
    db.get('SELECT COUNT(*) as count FROM files WHERE user_token = ?', [userToken], async (err, row) => {
        if (err) {
            fs.unlinkSync(req.file.path);
            return res.status(500).json({ error: 'Veritabanı hatası.' });
        }

        if (row.count >= 10) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: '10 dosyalık yükleme kotanız doldu. Yeni dosya yüklemek için "Dosyalarım" bölümünden dosya silmelisiniz.' });
        }

        const id = crypto.randomBytes(4).toString('hex');
        const publicId = `dosyap/${id}`;

        try {
            // 3. Diskten Cloudinary'ye Yükleme (RAM tüketmez)
            const uploadResult = await cloudinary.uploader.upload(req.file.path, {
                public_id: publicId,
                resource_type: 'auto'
            });

            // Geçici dosyayı sil
            fs.unlinkSync(req.file.path);

            // 4. Veritabanına Kaydetme
            const stmt = db.prepare(`
                INSERT INTO files (id, user_token, title, description, original_name, size, cloudinary_public_id, cloudinary_url)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                id,
                userToken,
                title || 'İsimsiz Dosya',
                description || '',
                req.file.originalname,
                req.file.size,
                uploadResult.public_id,
                uploadResult.secure_url,
                (err) => {
                    if (err) {
                        return res.status(500).json({ error: 'Veritabanına kayıt yapılamadı.' });
                    }
                    res.json({ success: true, id });
                }
            );
        } catch (uploadError) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            console.error('Cloudinary hatası:', uploadError);
            res.status(500).json({ error: 'Yükleme sırasında hata oluştu.' });
        }
    });
});

// API: Kullanıcının Dosyalarını Getirme
app.get('/api/my-files', (req, res) => {
    const userToken = req.headers['x-user-token'];
    if (!userToken) return res.status(400).json({ error: 'Geçersiz istek.' });

    db.all('SELECT id, title, description, original_name, size, created_at FROM files WHERE user_token = ? ORDER BY created_at DESC', [userToken], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Veri çekilemedi.' });
        res.json({ files: rows, total: rows.length, max: 10 });
    });
});

// API: Dosya Silme
app.delete('/api/file/:id', (req, res) => {
    const userToken = req.headers['x-user-token'];
    const id = req.params.id;

    db.get('SELECT * FROM files WHERE id = ? AND user_token = ?', [id, userToken], async (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Dosya bulunamadı veya silme yetkiniz yok.' });

        try {
            // Cloudinary'den Sil
            await cloudinary.uploader.destroy(row.cloudinary_public_id);
            // Veritabanından Sil
            db.run('DELETE FROM files WHERE id = ?', [id], (dbErr) => {
                if (dbErr) return res.status(500).json({ error: 'Silme hatası.' });
                res.json({ success: true, message: 'Dosya başarıyla silindi.' });
            });
        } catch (e) {
            res.status(500).json({ error: 'Cloudinary silme hatası.' });
        }
    });
});

// API: Dosya Detayı
app.get('/api/file/:id', (req, res) => {
    const id = req.params.id;
    db.get('SELECT id, title, description, original_name, size, cloudinary_url FROM files WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Dosya bulunamadı.' });
        res.json({
            id: row.id,
            title: row.title,
            description: row.description,
            originalName: row.original_name,
            size: row.size,
            downloadUrl: `/download/${row.id}`,
            fileUrl: row.cloudinary_url
        });
    });
});

// Doğrudan Yönlendirmeli İndirme (Bandwidth Trafik İsrafı Engellendi)
app.get('/download/:id', (req, res) => {
    const id = req.params.id;
    db.get('SELECT cloudinary_url, original_name FROM files WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.status(404).send('Dosya bulunamadı.');
        
        // Cloudinary attachment (doğrudan indirme) URL yönlendirmesi
        const downloadUrl = row.cloudinary_url.replace('/upload/', `/upload/fl_attachment:${encodeURIComponent(row.original_name)}/`);
        res.redirect(downloadUrl);
    });
});

// Dinamik OpenGraph Meta Etiketli Sayfa Sunumu
app.get('/dosya/:id', (req, res) => {
    const id = req.params.id;
    const indexPath = path.join(__dirname, 'public', 'index.html');

    fs.readFile(indexPath, 'utf8', (err, htmlData) => {
        if (err) return res.status(500).send('Sunucu hatası');

        db.get('SELECT title, description FROM files WHERE id = ?', [id], (dbErr, row) => {
            let finalHtml = htmlData;
            if (row) {
                finalHtml = finalHtml
                    .replace(/<!--OG_TITLE-->/g, `${row.title} - DosYap`)
                    .replace(/<!--OG_DESC-->/g, row.description || 'DosYap ile güvenle paylaşılan dosya.');
            } else {
                finalHtml = finalHtml
                    .replace(/<!--OG_TITLE-->/g, 'Dosya Bulunamadı - DosYap')
                    .replace(/<!--OG_DESC-->/g, 'Aradığınız dosya silinmiş veya mevcut değil.');
            }
            res.send(finalHtml);
        });
    });
});

app.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda aktif.`);
});

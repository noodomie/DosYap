const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'db.json');

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({}));
}

function readDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = crypto.randomBytes(6).toString('hex') + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({ storage });

app.post('/api/upload', upload.single('file'), (req, res) => {
    const { title, description } = req.body;
    if (!req.file) {
        return res.status(400).json({ error: 'Dosya yüklenmedi.' });
    }

    // 8 karakterli kısa ve temiz ID üretme
    const id = crypto.randomBytes(4).toString('hex');
    const db = readDB();

    db[id] = {
        id,
        title: title || 'İsimsiz Dosya',
        description: description || 'Açıklama bulunmuyor.',
        originalName: req.file.originalname,
        filename: req.file.filename,
        size: req.file.size,
        createdAt: new Date().toISOString()
    };

    writeDB(db);

    res.json({ success: true, id });
});

app.get('/api/file/:id', (req, res) => {
    const db = readDB();
    const fileData = db[req.params.id];
    if (!fileData) {
        return res.status(404).json({ error: 'Dosya bulunamadı.' });
    }
    res.json(fileData);
});

app.get('/download/:id', (req, res) => {
    const db = readDB();
    const fileData = db[req.params.id];
    if (!fileData) {
        return res.status(404).send('Dosya bulunamadı.');
    }
    const filePath = path.join(__dirname, 'uploads', fileData.filename);
    res.download(filePath, fileData.originalName);
});

app.get('/f/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`DosYap sunucusu ${PORT} portunda çalışıyor.`);
});

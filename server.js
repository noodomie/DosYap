const express = require('express');
const Busboy = require('busboy');
const { v2: cloudinary } = require('cloudinary');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const captchas = new Map();
const verifiedSessions = new Set();

function generateSvgCaptcha(code) {
    const width = 180;
    const height = 48;
    let lines = '';
    for (let i = 0; i < 4; i++) {
        const x1 = Math.floor(Math.random() * width);
        const y1 = Math.floor(Math.random() * height);
        const x2 = Math.floor(Math.random() * width);
        const y2 = Math.floor(Math.random() * height);
        lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#2563eb" stroke-width="1.5" opacity="0.4"/>`;
    }
    let dots = '';
    for (let i = 0; i < 30; i++) {
        const cx = Math.floor(Math.random() * width);
        const cy = Math.floor(Math.random() * height);
        dots += `<circle cx="${cx}" cy="${cy}" r="1.5" fill="#3b82f6" opacity="0.3"/>`;
    }
    let chars = '';
    const charSpacing = (width - 30) / code.length;
    for (let i = 0; i < code.length; i++) {
        const x = 16 + i * charSpacing;
        const y = 32 + (Math.random() * 6 - 3);
        const rot = (Math.random() - 0.5) * 30;
        chars += `<text x="${x}" y="${y}" transform="rotate(${rot}, ${x}, ${y})" font-family="monospace" font-weight="bold" font-size="22" fill="#2563eb">${code[i]}</text>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background:transparent;border-radius:8px;">${dots}${lines}${chars}</svg>`;
}

app.get('/api/captcha', (req, res) => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const captchaToken = crypto.randomBytes(16).toString('hex');
    captchas.set(captchaToken, { code: code.toUpperCase(), expires: Date.now() + 300000 });
    const svg = generateSvgCaptcha(code);
    res.json({ captchaToken, svg });
});

app.post('/api/verify-captcha', (req, res) => {
    const { captchaToken, answer } = req.body;
    if (!captchaToken || !captchas.has(captchaToken)) {
        return res.status(400).json({ error: 'Doğrulama süresi dolmuş veya geçersiz.' });
    }
    const captchaData = captchas.get(captchaToken);
    captchas.delete(captchaToken);
    if (Date.now() > captchaData.expires) {
        return res.status(400).json({ error: 'Doğrulama kodunun süresi doldu.' });
    }
    if (answer && answer.trim().toUpperCase() === captchaData.code) {
        const uploadSessionToken = crypto.randomBytes(16).toString('hex');
        verifiedSessions.add(uploadSessionToken);
        setTimeout(() => verifiedSessions.delete(uploadSessionToken), 600000);
        return res.json({ success: true, uploadSessionToken });
    }
    res.status(400).json({ error: 'Doğrulama kodu hatalı.' });
});

app.post('/api/upload', (req, res) => {
    const sessionToken = req.headers['x-upload-token'];
    if (!sessionToken || !verifiedSessions.has(sessionToken)) {
        return res.status(403).json({ error: 'Güvenlik doğrulaması yapılmadı veya süresi doldu.' });
    }

    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } });
    let title = 'İsimsiz Dosya';
    let description = 'Açıklama bulunmuyor.';
    let fileProcessed = false;
    let uploadError = false;
    const id = crypto.randomBytes(4).toString('hex');
    const publicId = `dosyap/${id}`;

    busboy.on('field', (fieldname, val) => {
        if (fieldname === 'title' && val) title = val;
        if (fieldname === 'description' && val) description = val;
    });

    busboy.on('file', (fieldname, file, info) => {
        const { filename } = info;
        fileProcessed = true;

        const uploadStream = cloudinary.uploader.upload_stream(
            {
                public_id: publicId,
                resource_type: 'auto',
                context: {
                    title: title,
                    description: description,
                    originalName: filename
                }
            },
            (error, result) => {
                if (error) {
                    uploadError = true;
                    if (!res.headersSent) {
                        return res.status(500).json({ error: 'Yükleme sırasında hata oluştu.' });
                    }
                    return;
                }
                verifiedSessions.delete(sessionToken);
                if (!res.headersSent) {
                    res.json({
                        success: true,
                        id,
                        title,
                        description,
                        originalName: filename,
                        size: result.bytes
                    });
                }
            }
        );

        file.on('limit', () => {
            uploadError = true;
            if (!res.headersSent) {
                res.status(400).json({ error: 'Dosya boyutu 10 MB sınırını aşıyor.' });
            }
        });

        file.pipe(uploadStream);
    });

    busboy.on('finish', () => {
        if (!fileProcessed && !uploadError && !res.headersSent) {
            res.status(400).json({ error: 'Lütfen bir dosya seçin.' });
        }
    });

    req.pipe(busboy);
});

async function getCloudinaryResource(id) {
    const types = ['image', 'raw', 'video'];
    for (const type of types) {
        try {
            const res = await cloudinary.api.resource(`dosyap/${id}`, { resource_type: type, context: true });
            if (res) return { resource: res, type };
        } catch (e) {}
    }
    return null;
}

app.get('/api/file/:id', async (req, res) => {
    const id = req.params.id;
    const data = await getCloudinaryResource(id);
    if (!data) {
        return res.status(404).json({ error: 'Dosya bulunamadı.' });
    }
    const context = data.resource.context?.custom || data.resource.context || {};
    res.json({
        id: id,
        title: context.title || 'İsimsiz Dosya',
        description: context.description || 'Açıklama bulunmuyor.',
        originalName: context.originalName || 'dosya',
        size: data.resource.bytes,
        downloadUrl: `/download/${id}`
    });
});

app.delete('/api/file/:id', async (req, res) => {
    const id = req.params.id;
    const types = ['image', 'raw', 'video'];
    let deleted = false;
    for (const type of types) {
        try {
            const result = await cloudinary.uploader.destroy(`dosyap/${id}`, { resource_type: type });
            if (result.result === 'ok') {
                deleted = true;
                break;
            }
        } catch (e) {}
    }
    if (deleted) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Dosya bulunamadı veya silinemedi.' });
    }
});

app.get('/download/:id', async (req, res) => {
    const id = req.params.id;
    const data = await getCloudinaryResource(id);
    if (!data) {
        return res.status(404).send('Dosya bulunamadı.');
    }

    const context = data.resource.context?.custom || data.resource.context || {};
    const originalName = context.originalName || `dosya_${id}`;

    const safeName = originalName.replace(/["\r\n]/g, '_').replace(/[^\x00-\x7F]/g, '_');
    const encodedName = encodeURIComponent(originalName);

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`);

    function pipeStream(fileUrl) {
        const client = fileUrl.startsWith('https') ? https : http;
        client.get(fileUrl, (cloudRes) => {
            if (cloudRes.statusCode >= 300 && cloudRes.statusCode < 400 && cloudRes.headers.location) {
                return pipeStream(cloudRes.headers.location);
            }
            res.setHeader('Content-Type', cloudRes.headers['content-type'] || 'application/octet-stream');
            cloudRes.pipe(res);
        }).on('error', (err) => {
            if (!res.headersSent) res.status(500).send('İndirme hatası.');
        });
    }

    pipeStream(data.resource.secure_url);
});

app.get('/dosya/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Sunucu çalışıyor.`);
});

const express = require('express');
const multer = require('multer');
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

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10 MB sınırı
});

app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'Dosya boyutu çok büyük. Maksimum 10 MB yükleyebilirsiniz.' });
            }
            return res.status(400).json({ error: 'Yükleme sırasında bir hata oluştu.' });
        } else if (err) {
            return res.status(500).json({ error: 'Sunucu hatası oluştu.' });
        }

        const { title, description } = req.body;
        if (!req.file) {
            return res.status(400).json({ error: 'Lütfen bir dosya seçin.' });
        }

        const id = crypto.randomBytes(4).toString('hex');
        const publicId = `dosyap/${id}`;

        const uploadStream = cloudinary.uploader.upload_stream(
            {
                public_id: publicId,
                resource_type: 'auto',
                context: {
                    title: title || 'İsimsiz Dosya',
                    description: description || 'Açıklama bulunmuyor.',
                    originalName: req.file.originalname
                }
            },
            (error, result) => {
                if (error) {
                    console.error('Cloudinary hatası:', error);
                    return res.status(500).json({ error: 'Yükleme sırasında hata oluştu.' });
                }
                res.json({ success: true, id });
            }
        );

        uploadStream.end(req.file.buffer);
    });
});

app.get('/api/file/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const result = await cloudinary.search
            .expression(`public_id:dosyap/${id}`)
            .with_field('context')
            .execute();

        if (!result.resources || result.resources.length === 0) {
            return res.status(404).json({ error: 'Dosya bulunamadı.' });
        }

        const asset = result.resources[0];
        const context = asset.context || {};

        res.json({
            id: id,
            title: context.title || 'İsimsiz Dosya',
            description: context.description || 'Açıklama bulunmuyor.',
            originalName: context.originalName || 'dosya',
            size: asset.bytes,
            downloadUrl: `/download/${id}`
        });
    } catch (error) {
        console.error('Arama hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası oluştu.' });
    }
});

app.get('/download/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const result = await cloudinary.search
            .expression(`public_id:dosyap/${id}`)
            .with_field('context')
            .execute();

        if (!result.resources || result.resources.length === 0) {
            return res.status(404).send('Dosya bulunamadı.');
        }

        const asset = result.resources[0];
        const context = asset.context || {};
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
                console.error('İndirme akış hatası:', err);
                if (!res.headersSent) res.status(500).send('İndirme hatası.');
            });
        }

        pipeStream(asset.secure_url);

    } catch (error) {
        console.error('İndirme hatası:', error);
        res.status(500).send('Sunucu hatası.');
    }
});

app.get('/dosya/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Sunucu çalışıyor.`);
});

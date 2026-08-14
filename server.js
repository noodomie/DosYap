const express = require('express');
const busboy = require('busboy');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

app.use(express.static('public'));
app.use(express.json());

const fileStore = new Map();

app.post('/upload', (req, res) => {
  const bb = busboy({ headers: req.headers });
  let uploadStream;
  let fileId = crypto.randomBytes(4).toString('hex');
  let originalFilename = '';

  bb.on('file', (name, file, info) => {
    const { filename, mimeType } = info;
    originalFilename = Buffer.from(filename, 'latin1').toString('utf8');
    
    let resourceType = 'raw';
    if (mimeType.startsWith('image/')) resourceType = 'image';
    else if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) resourceType = 'video';

    uploadStream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, public_id: `dosyap_${fileId}` },
      (error, result) => {
        if (error) {
          return res.status(500).json({ error: 'Yükleme başarısız' });
        }
        const fileData = {
          id: fileId,
          name: originalFilename,
          url: result.secure_url,
          publicId: result.public_id,
          resourceType: resourceType,
          size: result.bytes,
          date: new Date()
        };
        fileStore.set(fileId, fileData);
        return res.json({ success: true, file: fileData });
      }
    );
    file.pipe(uploadStream);
  });

  req.pipe(bb);
});

app.delete('/api/files/:id', async (req, res) => {
  const id = req.params.id;
  const file = fileStore.get(id);
  if (!file) {
    return res.status(404).json({ error: 'Dosya bulunamadı' });
  }
  try {
    await cloudinary.uploader.destroy(file.publicId, { resource_type: file.resourceType });
    fileStore.delete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Silme işlemi başarısız' });
  }
});

app.get('/api/files', (req, res) => {
  res.json(Array.from(fileStore.values()));
});

app.get('/dosya/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sunucu aktif: ${PORT}`);
});

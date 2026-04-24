const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Detect if running on Render (ephemeral filesystem)
const IS_RENDER = !!process.env.RENDER;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Create uploads directory if it doesn't exist (for local/dev environments)
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (IS_RENDER) {
  console.warn('⚠️  Running on Render (ephemeral filesystem). Files will be lost on server restart.');
  console.warn('💡 For production, consider using AWS S3 or configure S3_STORAGE_SETUP.md');
}

// Configure multer for local file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

const uploadSingleFile = upload.single('file');
const uploadSingleAvatar = upload.single('avatar');

/**
 * Save file locally and return the URL
 * @param {Object} file - Multer file object
 * @param {string} baseUrl - Base URL for the server (e.g., http://localhost:5000)
 * @returns {Object} - { url, name, type, size }
 */
const saveFile = (file, baseUrl) => {
  if (!file) {
    throw new Error('No file provided');
  }

  const fileUrl = `${baseUrl}/uploads/${file.filename}`;
  return {
    url: fileUrl,
    name: file.originalname,
    type: file.mimetype,
    size: file.size,
    filename: file.filename
  };
};

/**
 * Delete a file from local storage
 * @param {string} filename - The filename to delete
 */
const deleteFile = (filename) => {
  if (!filename) return;
  
  const filePath = path.join(uploadsDir, filename);
  
  // Security: ensure the file is within the uploads directory
  if (!filePath.startsWith(uploadsDir)) {
    console.warn('Attempted to delete file outside uploads directory:', filePath);
    return;
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('File deleted:', filename);
    }
  } catch (err) {
    console.error('Error deleting file:', err.message);
  }
};

module.exports = {
  uploadSingleFile,
  uploadSingleAvatar,
  saveFile,
  deleteFile,
  uploadsDir
};

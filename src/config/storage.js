/**
 * Production-ready file storage selector
 * Automatically chooses between S3 (for production) and local storage (for development)
 */

const { uploadSingleFile: localUploadSingleFile, uploadSingleAvatar: localUploadSingleAvatar, saveFile: localSaveFile } = require('./localStorage');

let s3UploadSingleFile = null;
let s3UploadSingleAvatar = null;
let uploadToS3 = null;

// Try to load S3 storage - it's optional
try {
  const s3Storage = require('./s3Storage');
  s3UploadSingleFile = s3Storage.uploadSingleFile;
  s3UploadSingleAvatar = s3Storage.uploadSingleAvatar;
  uploadToS3 = s3Storage.uploadToS3;
} catch (err) {
  // S3 module not available, will use local storage fallback
  console.log('ℹ️  S3 storage module not available. Will use local storage fallback.');
}

const IS_RENDER = !!process.env.RENDER;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const HAS_S3_CONFIG = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET_NAME);

// Log current storage configuration
console.log('📁 Storage Configuration:');
console.log(`  - Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
console.log(`  - Platform: ${IS_RENDER ? 'Render (ephemeral)' : 'Local/Self-hosted'}`);
console.log(`  - S3 Available: ${uploadToS3 ? 'YES' : 'NO (aws-sdk not installed)'}`);
console.log(`  - S3 Configured: ${HAS_S3_CONFIG ? 'YES' : 'NO'}`);

let STORAGE_TYPE = 'local';

if (IS_PRODUCTION && IS_RENDER) {
  if (HAS_S3_CONFIG && uploadToS3) {
    STORAGE_TYPE = 's3';
    console.log('  ✅ Using S3 for persistent storage');
  } else {
    if (!HAS_S3_CONFIG) {
      console.warn('  ⚠️  No S3 credentials configured. Using local storage (files will be lost on restart).');
      console.warn('      Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET_NAME to use S3');
    } else {
      console.warn('  ⚠️  S3 module not available. Install aws-sdk: npm install aws-sdk');
    }
  }
} else if (IS_PRODUCTION) {
  console.log('  ℹ️  Using local storage (ensure persistent volume is configured)');
} else {
  console.log('  ℹ️  Development mode - using local storage');
}

// ============= FILE UPLOAD MIDDLEWARE =============

// Choose which multer middleware to use
const uploadSingleFile = (STORAGE_TYPE === 's3' && s3UploadSingleFile) ? s3UploadSingleFile : localUploadSingleFile;
const uploadSingleAvatar = (STORAGE_TYPE === 's3' && s3UploadSingleAvatar) ? s3UploadSingleAvatar : localUploadSingleAvatar;

// ============= FILE SAVE FUNCTION =============

/**
 * Save file to appropriate storage (S3 or local)
 * @param {Object} file - Multer file object
 * @param {string} baseUrl - Base URL for local storage fallback
 * @param {string} folder - Folder/path for S3 storage
 * @returns {Promise<Object>} - { url, name, type, size }
 */
const saveFileToStorage = async (file, baseUrl, folder = 'uploads') => {
  if (STORAGE_TYPE === 's3' && uploadToS3) {
    try {
      return await uploadToS3(file, folder);
    } catch (err) {
      console.error('S3 upload failed, falling back to local storage:', err.message);
      return localSaveFile(file, baseUrl);
    }
  } else {
    // For local storage, baseUrl is passed directly
    return localSaveFile(file, baseUrl);
  }
};

// ============= EXPORTS =============

module.exports = {
  // Middleware
  uploadSingleFile,
  uploadSingleAvatar,
  
  // Storage methods
  saveFileToStorage,
  
  // Configuration info
  STORAGE_TYPE,
  IS_PRODUCTION,
  IS_RENDER,
  HAS_S3_CONFIG,
};

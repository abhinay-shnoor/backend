const AWS = require('aws-sdk');
const multer = require('multer');

// Configure AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1'
});

// Configure multer to use memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

const uploadSingleFile = upload.single('file');
const uploadSingleAvatar = upload.single('avatar');

/**
 * Upload file to S3
 * @param {Object} file - Multer file object
 * @param {string} folder - S3 folder path (e.g., 'attachments', 'avatars')
 * @returns {Promise<Object>} - { url, name, type, size }
 */
const uploadToS3 = async (file, folder = 'uploads') => {
  if (!file) {
    throw new Error('No file provided');
  }

  const bucketName = process.env.AWS_S3_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('AWS_S3_BUCKET_NAME environment variable not set');
  }

  const key = `${folder}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

  const params = {
    Bucket: bucketName,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: 'public-read' // Make files publicly readable
  };

  try {
    const result = await s3.upload(params).promise();
    return {
      url: result.Location,
      name: file.originalname,
      type: file.mimetype,
      size: file.size,
      key: key // Store key for deletion later
    };
  } catch (err) {
    console.error('S3 upload error:', err);
    throw new Error(`S3 upload failed: ${err.message}`);
  }
};

/**
 * Delete file from S3
 * @param {string} key - The S3 key (path) to delete
 */
const deleteFromS3 = async (key) => {
  if (!key) return;

  const bucketName = process.env.AWS_S3_BUCKET_NAME;
  if (!bucketName) {
    console.error('AWS_S3_BUCKET_NAME environment variable not set');
    return;
  }

  const params = {
    Bucket: bucketName,
    Key: key
  };

  try {
    await s3.deleteObject(params).promise();
    console.log('S3 file deleted:', key);
  } catch (err) {
    console.error('Error deleting S3 file:', err.message);
  }
};

module.exports = {
  uploadSingleFile,
  uploadSingleAvatar,
  uploadToS3,
  deleteFromS3
};

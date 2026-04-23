const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadBuffer = (buffer, options = {}) => {
  console.log('Cloudinary uploadBuffer called with options:', JSON.stringify(options));
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'shnoor', resource_type: 'auto', ...options },
      (err, result) => {
        if (err) {
          console.error('Cloudinary upload error:', err);
          return reject(err);
        }
        console.log('Cloudinary upload success:', result.secure_url);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
};

module.exports = { cloudinary, uploadBuffer };